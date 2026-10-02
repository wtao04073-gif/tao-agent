/**
 * 服务入口
 *
 * 装配顺序是刻意的：**配置校验 → 装配 → 监听**。
 * 配置错误在启动时就报全（见 config.ts 的说明），而不是等第一个任务
 * 失败才发现 —— 后者让客户以为是产品不好用。
 */

import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { basename, join, normalize, resolve, sep } from "node:path";
import {
	buildDashboard,
	createPermissionGate,
	evaluateQuota,
	PRESET_CARDS,
	activateableTools,
	compilePrompt,
	listCards,
	resolveCard,
	restrictPolicies,
	withQuotaGate,
	type ModelPrice,
	type Quota,
	type ScenarioCard,
	type StoredAuditEntry,
	type TenantContext,
	type UsageRecord,
	type ChatTurn,
	type TaskEvent,
	type StoredJob,
	type JobMemoryEntry,
	type StoredSkill,
	type StoredAgent,
} from "@tao/core";
import { createDocToolset, createOfficeToolset, DOC_TOOL_POLICIES, OFFICE_TOOL_POLICIES } from "@tao/office";
import { FileAuditStore, FileJobStore, FileJsonStore, FileMeteringStore, FileTaskStore } from "@tao/knowledge";
import {
	createModelRuntime,
	InProcessRunnerFactory,
	MemorySessionFactory,
} from "@tao/agent-host";
import { TaskOrchestrator } from "@tao/orchestrator";
import { createApp, ticketResource, readJsonBody, sendJson, sendError, type Principal } from "./app.ts";
import { listVisibleSkills, listVisibleAgents, newAddonId, resolveAddons } from "./addons.ts";
import {
	authenticateToken,
	hasDefaultTokens,
	loadAccounts,
	resolveWorkspaceDir,
	type AccountDirectory,
} from "./accounts.ts";
import { resolveRegisteredArtifact, taskArtifactDir } from "./artifacts.ts";
import { describeConfig, loadConfig, renderConfigErrors } from "./config.ts";
import { assertSubmissionValid } from "./submission.ts";
import { SseHub } from "./sse.ts";
import { TicketService } from "./tickets.ts";
import { resolveWebDir } from "./static.ts";

import {createWorkspaceServices, workspaceFile} from "./workspace-services.ts";
import {createWorkspaceHandler} from "./workspace-api.ts";
import {handleControlGate} from "./control-gate.ts";
import {copyFileSync,constants as fsConstants} from "node:fs";
import {randomUUID} from "node:crypto";
const { config, errors } = loadConfig(process.env);

/**
 * 配置有错就不启动。
 *
 * 带着错误配置启动会让「所有任务都失败」，而客户看不出是配置问题。
 * 宁可起不来 —— 起不来的原因在日志第一屏就写清楚了。
 */
if (errors.length > 0) {
	process.stderr.write(renderConfigErrors(errors));
	process.exit(1);
}

process.stdout.write(describeConfig(config));

// 工作区必须先存在。容器里首次启动时目录可能还没建
mkdirSync(config.workspaceDir, { recursive: true });

/**
 * 账号目录（M5-2）。
 *
 * 工作区下的 accounts.json：首启落一份种子（含占位 token，会警告尽快改）。
 * 加载失败直接退出 —— 坏账号表要么全员 401 要么权限错乱，必须在启动时拦住。
 */
let accounts: AccountDirectory;
try {
	accounts = loadAccounts(config.workspaceDir);
} catch (error) {
	process.stderr.write(`账号配置有误，服务不启动：\n${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}
if (hasDefaultTokens(accounts)) {
	process.stderr.write(
		"[安全警告] accounts.json 仍含 change-me 占位 token，仅用于首次启动，请立即替换为强随机值。\n",
	);
}

/**
 * 计量落盘。
 *
 * **不能用内存实现** —— 进程重启后用量归零，配额随之失效，
 * 而用量看板会显示 0。看板读的数据不可信，看板就是假的。
 *
 * 依据见 [Spike 8](../../../spikes/08-append-durability/)：JSONL 追加写
 * 在多进程并发下不截断、进程崩溃不丢数据、半写行可安全跳过。
 */
const meteringStore = new FileMeteringStore({
	dir: join(config.workspaceDir, ".metering"),
	onCorruptLine: ({ shard, skipped }) => {
		// 坏行意味着有用量没算进去，运维需要知道
		process.stderr.write(`[计量] 分片 ${shard} 有 ${skipped} 行无法解析，这部分用量未计入\n`);
	},
});
const sessionFactory = new MemorySessionFactory();

/**
 * 任务与审计落盘（M5-1）。
 *
 * 与计量同目录根下的 JSONL 存储：任务变更 / 事件按任务分文件，审计按天分片。
 * 服务重启后任务列表、事件历史、审计都可恢复 —— 不再是 M4 的「重启即空」。
 */
const taskStore = new FileTaskStore({
	dir: join(config.workspaceDir, ".tasks"),
	onCorruptLine: ({ file, skipped }) => {
		process.stderr.write(`[任务] ${file} 有 ${skipped} 行无法解析，已跳过\n`);
	},
});
const auditStore = new FileAuditStore({
	dir: join(config.workspaceDir, ".tasks"),
	onCorruptLine: ({ file, skipped }) => {
		process.stderr.write(`[审计] ${file} 有 ${skipped} 行无法解析，已跳过\n`);
	},
});
/**
 * 长程任务（Job）落盘：一个任务一个 JSON，跨天多次会话与长期记忆都在其中。
 */
const jobStore = new FileJobStore({ dir: join(config.workspaceDir, ".jobs") });
/** 技能 / 智能体扩展（用户上传 + 系统预置），按记录内 tenant 隔离。 */
const addonDir = join(config.workspaceDir, ".addons");
const skillStore = new FileJsonStore<StoredSkill>({
	dir: addonDir, collection: "skills", idOf: (s) => s.skillId,
});
const agentStore = new FileJsonStore<StoredAgent>({
	dir: addonDir, collection: "agents", idOf: (a) => a.agentId,
});
const hub = new SseHub();

/**
 * 模型价格表。
 *
 * **配额判定与用量看板必须用同一份** —— 两边不一致时，看板显示「还没到上限」
 * 而闸门已经在拦，或者反过来，客户会认为平台在乱算账。
 *
 * 一期只装配了一个模型（见 createModelRuntime），所以表里只有一条。
 * 未配单价时是空表：用量会被列进 `unpricedModels` 而不是按 0 元放行；
 * 配了金额上限却没配价的组合已在 config.ts 拦成启动错误。
 */
function priceRow(
	model: string,
	input: number | undefined,
	output: number | undefined,
	cacheRead: number | undefined,
): ModelPrice | undefined {
	if (input === undefined || output === undefined) return undefined;
	return {
		model,
		inputPerMillionYuan: input,
		outputPerMillionYuan: output,
		...(cacheRead === undefined ? {} : { cacheReadPerMillionYuan: cacheRead }),
	};
}

/**
 * 模型价格表（M5-5：旗舰 + 可选轻量两档各一条）。
 *
 * key 必须与该档实际发出的 UsageRecord.model（即模型 id）一致，
 * estimateCost 按名查价。轻量档缺价时不进表 → 进 unpricedModels，
 * 而不是悄悄按 0 元放行。
 */
const modelPrices: readonly ModelPrice[] = [
	priceRow(config.modelName, config.modelInputPriceYuan, config.modelOutputPriceYuan, config.modelCacheReadPriceYuan),
	config.modelLiteName !== undefined
		? priceRow(
				config.modelLiteName,
				config.modelLiteInputPriceYuan,
				config.modelLiteOutputPriceYuan,
				config.modelLiteCacheReadPriceYuan,
			)
		: undefined,
].filter((p): p is ModelPrice => p !== undefined);

/**
 * 配额。三项都留空时为 undefined —— 私有化部署的默认形态。
 *
 * 周期取当月。平台不自动推进周期（见 M4.md 的能力边界），
 * 这里按进程启动时的月份算，长跑的服务需要外部调度来重启或刷新。
 */
function currentQuota(tenantId: string): Quota | undefined {
	if (
		config.quotaMaxTokens === undefined &&
		config.quotaMaxCostMicroYuan === undefined &&
		config.quotaMaxTasks === undefined
	) {
		return undefined;
	}
	const now = new Date();
	const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
	const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
	return {
		tenantId,
		periodStart: start,
		periodEnd: end,
		...(config.quotaMaxTokens === undefined ? {} : { maxTokens: config.quotaMaxTokens }),
		...(config.quotaMaxCostMicroYuan === undefined
			? {}
			: { maxCostMicroYuan: config.quotaMaxCostMicroYuan }),
		...(config.quotaMaxTasks === undefined ? {} : { maxTasks: config.quotaMaxTasks }),
	};
}

/**
 * 模型运行时。
 *
 * 装配收在 agent-host 里 —— **不在这里直接 import pi-ai**。
 * 第一版就是那么写的，被 check-boundaries.mjs 拦下：provider 装配
 * 是内核细节，放在业务层会让「将来换内核」变成改全平台。
 */
/**
 * 出网前配额判定（M5-5）。
 *
 * 与 before_tool 闸共用同一份 meteringStore / quota / modelPrices ——
 * 看板与闸门必须是同一本账，否则会出现「看板没到上限、任务却被拦」的矛盾。
 * 租户无配额（私有化默认形态）时返回 undefined，即不拦。
 */
async function preflightModelQuota(input: {
	tenant: TenantContext;
	/**
	 * 临界区时刻「此前在途任务 ∪ 本次任务」的 taskId 集合（含本次 taskId），
	 * 由工厂的租户串行预检临界区注入。
	 */
	inflightTaskIds: readonly string[];
}): Promise<Awaited<ReturnType<typeof evaluateQuota>> | undefined> {
	const quota = currentQuota(input.tenant.tenantId);
	if (quota === undefined) return undefined;
	const verdict = await evaluateQuota({ store: meteringStore, quota, prices: modelPrices });

	/**
	 * 任务席位预留（按 taskId 并集去重）。
	 *
	 * evaluateQuota 的 taskCount 只统计**已落账**的任务，但运行中的任务在首轮
	 * usage 落账后就已进入该集合，同时它的席位仍在在途集合里。若直接
	 * 「taskCount + inflightCount」，同一个在途且已落账的任务会被算两次 ——
	 * 上限 2 时：A 已有首轮用量且未结束，B 会看到 1+1>=2 被错拒（实际只有 A）。
	 *
	 * 正确口径是两个 **taskId 集合的并集**：
	 *  - 已落账集合：本周期 usage 记录里出现过的不同 taskId（含已结束的）；
	 *  - 在途集合：临界区注入的 inflightTaskIds（必含本次 taskId）。
	 * A 在途且已落账时并集里只占 1 个；B 进入时并集 {A,B}=2，上限 2 放行，
	 * 第三个任务才拒。临界区串行保证并发预检不共享过期快照、maxTasks 不被突破。
	 *
	 * 话术刻意不出现「限流 / 429 / 超时」等词 —— 这是配额用尽，不是服务拥塞。
	 */
	if (quota.maxTasks !== undefined) {
		const window = { from: quota.periodStart, to: quota.periodEnd };
		const records = await meteringStore.list(input.tenant.tenantId, window);
		const taskIds = new Set<string>();
		for (const record of records) taskIds.add(record.taskId);
		for (const taskId of input.inflightTaskIds) taskIds.add(taskId);
		// 并集已含本次 taskId：上限 N 时，并集为 N 仍放行（本次就是第 N 个），
		// 超过 N（第 N+1 个）才拒。不能用 >=，否则第二个任务会被提前拒掉。
		if (taskIds.size > quota.maxTasks) {
			return {
				ok: false,
				exceeded: "tasks" as const,
				reason: `本周期任务数已达上限（${quota.maxTasks} 个，含执行中的任务），请联系管理员提升任务配额或等待下个周期`,
			};
		}
	}

	return verdict;
}

/**
 * 模型运行时（M5-5：旗舰 + 可选轻量双档）。
 *
 * 装配收在 agent-host 里 —— **不在这里直接 import pi-ai**。
 */
const liteConfigured =
	config.modelLiteBaseUrl !== undefined &&
	config.modelLiteApiKey !== undefined &&
	config.modelLiteName !== undefined;
const { models, model, modelForTier } = createModelRuntime({
	flagship: {
		baseUrl: config.modelBaseUrl,
		apiKey: config.modelApiKey,
		modelName: config.modelName,
		maxTokens: config.modelMaxTokens,
		...(config.modelInputPriceYuan === undefined ? {} : { inputCostPerMillion: config.modelInputPriceYuan }),
		...(config.modelOutputPriceYuan === undefined ? {} : { outputCostPerMillion: config.modelOutputPriceYuan }),
		...(config.modelCacheReadPriceYuan === undefined
			? {}
			: { cacheReadCostPerMillion: config.modelCacheReadPriceYuan }),
	},
	...(liteConfigured
		? {
				lite: {
					baseUrl: config.modelLiteBaseUrl as string,
					apiKey: config.modelLiteApiKey as string,
					modelName: config.modelLiteName as string,
					maxTokens: config.modelMaxTokens,
					...(config.modelLiteInputPriceYuan === undefined
						? {}
						: { inputCostPerMillion: config.modelLiteInputPriceYuan }),
					...(config.modelLiteOutputPriceYuan === undefined
						? {}
						: { outputCostPerMillion: config.modelLiteOutputPriceYuan }),
					...(config.modelLiteCacheReadPriceYuan === undefined
						? {}
						: { cacheReadCostPerMillion: config.modelLiteCacheReadPriceYuan }),
				},
			}
		: {}),
});

const factory = new InProcessRunnerFactory({
	/**
	 * 会话存储。经 agent-host 工厂创建，**不在这里直接 import vendor**。
	 * 一期是内存实现，进程重启后会话丢失（明确的能力边界，记在 M4/M5）。
	 */
	createSession: (sessionId) => sessionFactory.create(sessionId),
	models,
	model,
	modelForTier,
	// 出网前配额闸：第一次模型调用前判定，纯文本任务也拦得住，零模型消耗。
	// inflightTaskIds（含本次）由工厂的租户串行临界区注入，与已落账 taskId
	// 集合取并集去重后做任务席位预留。
	preflightModel: (input) =>
		preflightModelQuota({ tenant: input.tenant, inflightTaskIds: input.inflightTaskIds }),
	// 用量落账
	meter: (record) => meteringStore.record(record as UsageRecord),
	onMeterError: (error, taskId) => {
		process.stderr.write(`[计量] 任务 ${taskId} 落账失败：${error.message}\n`);
	},
});

const orchestrator = new TaskOrchestrator(factory, {
	store: taskStore,
	// 事件 / 产物落盘失败不静默（磁盘满、只读文件系统等）：任务继续在内存态运行，
	// 但差异必须能被发现；关键状态迁移失败由编排器转入 FAILED，不经过这里
	onPersistenceError: (error, taskId) => {
		process.stderr.write(`[持久化] 任务 ${taskId} 事件/产物落盘失败：${error.message}\n`);
	},
});

// 启动恢复：把上次进程遗留在 RUNNING 的任务标记为 INTERRUPTED（不重建执行器，
// 会话上下文已随旧进程丢失，用户可从检查点重试）。必须在接 SSE 订阅前完成。
const interrupted = orchestrator.recover();
if (interrupted.length > 0) {
	process.stdout.write(
		`[恢复] ${interrupted.length} 个任务在服务重启时处于执行中，已标记为中断：${interrupted.join(", ")}\n`,
	);
}

// 编排器事件 → SSE 下发
orchestrator.subscribe((event) => {
	hub.publish(event);
});

/**
 * 工具集。工作区按租户隔离；产物目录按任务隔离。
 *
 * - 共享工作区根 `…/<tenant>/<workspace>/`：放用户上传的输入资料（唯一命名）；
 * - 任务产物目录 `…/artifacts/<taskId>/`：本任务工具的所有输出都落在这里，
 *   也是该任务权限门的 workspace（执行侧只能读写自己的产物子树）。
 *
 * 产物按任务分目录是为了消除「同默认输出名跨任务串档/互相覆盖」：两个任务
 * 即便都产出「对账差异报告.xlsx」，也写在各自目录、下载各取自己登记的路径。
 * 输入文件仍在共享根，但权限门**不再授权整个共享根**，只把本任务表单实际
 * 引用到的上传文件以文件级白名单（allowedFiles，精确到文件、不扩目录）放行，
 * 因此 `artifacts/<其他任务>/…` 既不在本任务 workspace 子树、也不在白名单，
 * 知道路径也读不到（见 submitTask）。
 */
/**
 * 由首条 query 生成对话标题：去空白/换行，截断到 24 字。
 *
 * 不额外调用模型做摘要 —— 标题要在提交瞬间可得（左侧列表立刻可认），
 * 且省一次模型开销；用户的首句话本身通常已能表达意图。超长加省略号。
 */
function summarizeTitle(query: string): string {
	const oneLine = query.replace(/\s+/g, " ").trim();
	if (oneLine === "") return "新对话";
	return oneLine.length > 24 ? oneLine.slice(0, 24) + "…" : oneLine;
}

/**
 * 把长程任务的长期记忆转成跨轮上下文（ChatTurn）。
 * 每条记忆是一次会话沉淀的「结论」，以统一的虚拟问答形式带给模型：
 * 用户侧标注是第几次会话的诉求，助手侧是该次结论。
 */
function jobMemoryAsTurns(job: StoredJob): ChatTurn[] {
	return job.memory.map((m, i) => ({
		user: `（第 ${i + 1} 次会话的进展记录）`,
		assistant: m.summary,
	}));
}

/** 给长程任务会话的系统提示加上任务目标与历次结论，让模型一开始就有全局背景。 */
function withJobContext(systemPrompt: string, job: StoredJob): string {
	const lines = [
		systemPrompt,
		"",
		"【你正在协助推进一个长期任务】",
		"任务标题：" + job.title,
		"任务目标：" + job.goal,
	];
	if (job.memory.length > 0) {
		lines.push("此前各次会话已沉淀的结论：");
		job.memory.forEach((m, i) => lines.push(`${i + 1}. ${m.summary}`));
	}
	lines.push("请在上述背景下继续推进本次诉求，不要让用户重复已提供过的信息。");
	return lines.join("\n");
}

/**
 * 一次会话跑完后沉淀到长程任务：登记 conversationId，并追加一条记忆
 * （取本轮最终助手回答的摘要）。只保留最近若干条，避免无限增长。
 */
function commitJobConversation(job: StoredJob, conversationId: string, taskId: string): void {
	const events = orchestrator.events(taskId);
	let answer = "";
	for (const e of events) {
		if (e.type === "assistant_message") answer = e.text;
	}
	const summary = answer.trim() === "" ? "本次会话未产生文字结论。" : summarizeMemory(answer);
	const entry: JobMemoryEntry = { conversationId, at: Date.now(), summary };
	const conversationIds = job.conversationIds.includes(conversationId)
		? job.conversationIds
		: [...job.conversationIds, conversationId];
	const updated: StoredJob = {
		...job,
		conversationIds,
		memory: [...job.memory, entry].slice(-20),
		updatedAt: Date.now(),
	};
	jobStore.put(updated);
}

/**
 * 会话结论 → 记忆摘要：剥离 markdown/表格符号，取第一个自然句，去空白、限长。
 * 不额外调用模型，即时可用；重点是留下干净、可被下次会话读懂的进展要点。
 */
function summarizeMemory(text: string): string {
	const cleaned = text
		.replace(/```[\s\S]*?```/g, " ") // 代码块
		.replace(/^\s*\|.*\|\s*$/gm, " ") // 表格行
		.replace(/[#>*_`-]{2,}/g, " ") // markdown 强调/标题符号
		.replace(/\s+/g, " ")
		.trim();
	// 优先取首个句读；没有句号就整段截断
	const m = cleaned.match(/^[^。！？!?\n]{6,160}[。！？!?]/);
	const one = (m ? m[0] : cleaned).trim();
	return one.length > 160 ? one.slice(0, 160) + "…" : one;
}

/**
 * 取某多轮对话的标题与过往问答（按任务创建顺序、事件 seq 顺序配对）。
 *
 * 从该 conversationId 下各轮任务的事件流里，按出现顺序收集 user_message 与
 * assistant_message，相邻配对成 {user, assistant}。仅含已完整回答的轮次
 * （有问有答），未回答完的半截不进上下文。
 *
 * @returns 无权/对话不存在返回 undefined；存在但首轮为空也返回空 turns。
 */
async function conversationTurns(
	tenant: TenantContext,
	conversationId: string,
): Promise<{ title: string; turns: ChatTurn[] } | undefined> {
	const tasks = orchestrator
		.list(tenant)
		.filter((t) => (t as { conversationId?: string }).conversationId === conversationId)
		.sort((a, b) => a.createdAt - b.createdAt);
	if (tasks.length === 0) return undefined;

	const title =
		(tasks[0] as { title?: string }).title?.trim() || summarizeTitle("对话");

	const turns: ChatTurn[] = [];
	for (const t of tasks) {
		const events: readonly TaskEvent[] = orchestrator.events(t.taskId);
		let pendingUser: string | undefined;
		for (const e of events) {
			if (e.type === "user_message") {
				pendingUser = e.text;
			} else if (e.type === "assistant_message") {
				if (pendingUser !== undefined && e.text.trim() !== "") {
					turns.push({ user: pendingUser, assistant: e.text });
					pendingUser = undefined;
				}
			}
		}
	}
	// 只保留最近若干轮，避免历史无限增长撑爆上下文（一期取最近 10 轮）。
	return { title, turns: turns.slice(-10) };
}

function toolsFor(tenant: TenantContext, taskId: string) {
	// 账号校验已限制标识为安全单段，这里再经 resolveWorkspaceDir 做一次边界断言，
	// 防止任何逃逸标识（如 ../）把工作区目录解析到根之外后再 mkdir。
	const dir = resolveWorkspaceDir(config.workspaceDir, tenant.tenantId, tenant.workspaceId);
	mkdirSync(dir, { recursive: true });
	// taskId 为服务端生成（task-时间戳-随机数），再过白名单才拼目录
	const artifactDir = taskArtifactDir(dir, taskId);
	mkdirSync(artifactDir, { recursive: true });
	return {
		dir,
		artifactDir,
		tools: [
			...createOfficeToolset({ workspace: artifactDir }),
			...createDocToolset({ workspace: artifactDir }),
            workspaceServices.createKnowledgeTool(tenant),
		],
	};
}

/**
 * 收集任务表单实际引用的上传输入文件，构成**文件级**白名单。
 *
 * 不能把表单里的任意字符串都加白（模型/用户可以填任意路径），也不能授权整个
 * 共享根（那等于不隔离：其他任务的 artifacts 也在共享根下）。做法是取交集：
 *  1. 列出租户共享根**当前层**存在的普通上传文件（上传接口只落单段文件名到
 *     根下，不递归进 artifacts/ 等子目录）；
 *  2. 递归收集表单 fields 中的全部字符串值；
 * 只有「确实是共享根现存上传文件」且「被本次表单引用」的路径才进白名单。
 * 白名单按精确路径匹配，授权 a.xlsx 不会放开同目录的 b.xlsx（见 checkPath）。
 */
function collectAllowedInputFiles(
	workspaceRoot: string,
	fields: Readonly<Record<string, unknown>>,
): string[] {
	const referenced = new Set<string>();
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			referenced.add(normalize(resolve(value)));
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (typeof value === "object" && value !== null) {
			for (const v of Object.values(value as Record<string, unknown>)) walk(v);
		}
	};
	walk(fields);

	const allowed: string[] = [];
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(workspaceRoot, { withFileTypes: true });
	} catch {
		return allowed;
	}
	const root = resolve(workspaceRoot);
	for (const entry of entries) {
		// 只要根层普通文件：artifacts/ 等子目录（含其他任务产物）不在其中
		if (!entry.isFile()) continue;
		const abs = normalize(join(root, entry.name));
		if (referenced.has(abs)) allowed.push(abs);
	}
	return allowed;
}

/**
 * 上传文件名净化：只保留 basename 与安全字符（中文、字母数字、点、连字符、
 * 下划线），路径分隔符、通配符、控制字符一律替成下划线，杜绝目录逃逸。
 */
function sanitizeUploadName(name: string): string {
	const base = basename(name).trim();
	const cleaned = base
		.replace(/[^\w.一-鿿㐀-䶿-]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	return cleaned === "" || cleaned === "." ? "upload" : cleaned;
}

/** 同名文件不覆盖：在扩展名前加 (1)/(2)…。 */
function uniqueName(dir: string, name: string): string {
	if (!pathExists(join(dir, name))) return name;
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	for (let i = 1; i < 10000; i++) {
		const candidate = `${stem} (${i})${ext}`;
		if (!pathExists(join(dir, candidate))) return candidate;
	}
	return `${stem}-${Date.now()}${ext}`;
}

function pathExists(p: string): boolean {
	try {
		statSync(p);
		return true;
	} catch {
		return false;
	}
}

/** 短时一次性票据服务：SSE 与下载用它换票，长期 Bearer 不再出现在 URL 里。 */
const tickets = new TicketService();

/**
 * 从 URL 判定该请求是否属于「只能用票据的 GET 通道」（SSE / 下载）。
 * 返回要消费的票据用途与资源范围；不属于则返回 null。
 */
function ticketTarget(
	req: IncomingMessage,
): { kind: "events" | "download"; resource: string | null } | null {
	try {
		const u = new URL(req.url ?? "", "http://localhost");
		// 与路由层 segments() 同口径解码，保证票据 resource 签发/消费逐字一致
		const decode = (s: string): string => {
			try {
				return decodeURIComponent(s);
			} catch {
				return s;
			}
		};
		const seg = u.pathname.split("/").filter(Boolean).map(decode);
		if (seg[0] !== "api") return null;
		if (seg[1] === "events" && seg.length === 2) {
			const taskId = u.searchParams.get("taskId");
			return { kind: "events", resource: ticketResource.events(taskId) };
		}
		if (seg[1] === "tasks" && seg[3] === "artifacts" && seg.length === 5) {
			return { kind: "download", resource: ticketResource.artifact(seg[2] as string, seg[4] as string) };
		}
		if (seg[1] === "files" && seg.length === 3) {
			return { kind: "download", resource: ticketResource.file(seg[2] as string) };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * 鉴权（M5-2 + 票据）。
 *
 * Bearer token 在账号目录里**精确查表**得到租户 / 工作区 / 用户 / 角色，
 * 不再有「任意非空 token 进默认租户」「admin: 前缀判管理员」。
 * 查不到即匿名（路由层回 401）。
 *
 * **刻意不支持从请求体传租户** —— 那等于没有隔离。
 *
 * 浏览器无法为 EventSource 与下载导航自定义 Authorization 头。这两类 GET
 * 只接受 `?ticket=`：票据是先用 Bearer 经 `/ticket` 接口签发的、短时、
 * 绑定用途与资源、一次性的临时凭证。**长期账号令牌永不出现在 URL 里**
 * （避免进访问日志 / 历史 / Referer）。票据在建立连接那一下即被消耗，
 * SSE 之后靠心跳保活；其余接口仍只认 Bearer 头。
 */
async function authenticate(req: IncomingMessage): Promise<Principal | undefined> {
	const header = req.headers.authorization;
	const headerToken = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
	if (headerToken !== "") {
		const hit = authenticateToken(accounts, headerToken);
		if (hit === undefined) return undefined;
		return { tenant: hit.tenant, role: hit.role, name: hit.name };
	}

	// 无 Bearer 头时，仅 SSE / 下载三类 GET 可凭一次性票据通过，且参数名只认 ticket
	const target = ticketTarget(req);
	if (target === null) return undefined;
	try {
		const u = new URL(req.url ?? "", "http://localhost");
		const ticket = (u.searchParams.get("ticket") ?? "").trim();
		if (ticket === "") return undefined;
		return tickets.consume({ kind: target.kind, ticket, resource: target.resource });
	} catch {
		return undefined;
	}
}

/**
 * 同源前端目录。生产镜像在 /app/web，开发态在仓库根 web/。
 * 解析不到（误删前端资源）也不阻断 API —— 仅无页面可访问，启动日志说明。
 */
// 入口经 ESM 运行，用 import.meta.url 定位自身所在目录，与启动 cwd 无关。
const entryFile = fileURLToPath(import.meta.url);
const webDir = resolveWebDir(process.env.WEB_DIR, entryFile);
if (webDir === undefined) {
	process.stderr.write("[Web] 未找到前端目录（web/login.html），本次启动仅提供 API，不托管页面。\n");
}

const workspaceServices=createWorkspaceServices({workspaceRoot:config.workspaceDir});
function ownedTask(tenant:TenantContext,taskId:string) {
 const task=orchestrator.get(taskId);
 return task && task.tenant.tenantId===tenant.tenantId && task.tenant.workspaceId===tenant.workspaceId ? task : undefined;
}
function ownedArtifact(tenant:TenantContext,taskId:string,name:string) {
 const task=ownedTask(tenant,taskId);if(!task)return undefined;
 return resolveRegisteredArtifact({workspaceRoot:resolveWorkspaceDir(config.workspaceDir,tenant.tenantId,tenant.workspaceId),artifacts:task.artifacts,name});
}
const workspaceHandler=createWorkspaceHandler({authenticate,workspaceRoot:config.workspaceDir,getTask:ownedTask,artifactPath:ownedArtifact,services:workspaceServices});
const app = createApp({
	authenticate,
	modelInfo: () => ({
		flagshipName: config.modelName,
		...(liteConfigured ? { liteName: config.modelLiteName as string } : {}),
	}),
	hub,
	tickets,
	taskEvents: (tenant, taskId, afterSeq) => {
		const task = orchestrator.get(taskId);
		// 双重校验归属 —— 编排器的 list 已过滤，但单点取用要自己查
		if (task === undefined || task.tenant.tenantId !== tenant.tenantId) return [];
		return orchestrator.events(taskId, afterSeq);
	},
	listTasks: (tenant) => orchestrator.list(tenant),
	getTask: (tenant, taskId) => {
		const task = orchestrator.get(taskId);
		if (task === undefined) return undefined;
		if (task.tenant.tenantId !== tenant.tenantId) return undefined;
		if (task.tenant.workspaceId !== tenant.workspaceId) return undefined;
		return task;
	},
	createJob: async (tenant, input) => {
		const now = Date.now();
		const jobId = `job-${now}-${Math.floor(Math.random() * 1e6)}`;
		const stored: StoredJob = {
			jobId,
			tenant,
			title: summarizeTitle(input.title || input.goal),
			goal: input.goal,
			status: "active",
			createdAt: now,
			updatedAt: now,
			conversationIds: [],
			memory: [],
		};
		if (!jobStore.create(stored)) throw new Error("任务创建失败，请重试");
		return { jobId };
	},
	listJobs: (tenant) => jobStore.listByTenant(tenant.tenantId, tenant.workspaceId),
	getJob: (tenant, jobId) => {
		const job = jobStore.get(jobId);
		if (job === undefined) return undefined;
		if (job.tenant.tenantId !== tenant.tenantId) return undefined;
		if (job.tenant.workspaceId !== tenant.workspaceId) return undefined;
		return job;
	},
	listSkills: (tenant) => listVisibleSkills(skillStore, tenant),
	listAgents: (tenant) => listVisibleAgents(agentStore, tenant),
	createSkill: async (tenant, input) => {
		const now = Date.now();
		const skillId = newAddonId("skill");
		const stored: StoredSkill = {
			skillId,
			tenant,
			name: input.name,
			description: input.description,
			content: input.content,
			builtin: false,
			createdAt: now,
			updatedAt: now,
		};
		if (!skillStore.create(stored)) throw new Error("技能创建失败，请重试");
		return { skillId };
	},
	createAgent: async (tenant, input) => {
		const now = Date.now();
		const agentId = newAddonId("agent");
		// 挂载的技能必须是本租户可见（内置或自有）的，全部不可见则拒，防止挂空引用。
		const visible = new Set(
			listVisibleSkills(skillStore, tenant).map((s) => s.skillId),
		);
		const skillIds = [...new Set(input.skillIds)].filter((id) => visible.has(id));
		if (input.skillIds.length > 0 && skillIds.length === 0) {
			throw new Error("所选技能均不可用，请重新选择");
		}
		const stored: StoredAgent = {
			agentId,
			tenant,
			name: input.name,
			description: input.description,
			systemPrompt: input.systemPrompt,
			skillIds,
			builtin: false,
			createdAt: now,
			updatedAt: now,
		};
		if (!agentStore.create(stored)) throw new Error("智能体创建失败，请重试");
		return { agentId };
	},
	submitTask: async (tenant, input) => {
		const card = resolveCard(PRESET_CARDS, input.scenarioId, tenant.tenantId) as
			| ScenarioCard
			| undefined;
		if (card === undefined) throw new Error(`未知的场景：${input.scenarioId}`);

		// 服务端必须自己再校验一遍表单：必填、数字 / min-max、单选枚举等。
		// 前端校验可被绕过（直接调 API），缺失或越界的字段会原样拼进提示词，
		// 数字超界还会让 Agent 拿着错误参数去执行。校验在 resolveCard 之后、
		// compilePrompt 之前；任何错误都在此抛 400，绝不创建任务。
		assertSubmissionValid(card, input.fields);

		// taskId 先于工具集生成：产物目录按它隔离。id 为服务端生成的安全字符，
		// taskArtifactDir 内部还会再过一次白名单。
		const taskId = `task-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
		const { dir: workspaceDir, artifactDir, tools } = toolsFor(tenant, taskId);
		const quota = currentQuota(tenant.tenantId);
		const basePolicies = restrictPolicies([...OFFICE_TOOL_POLICIES, ...DOC_TOOL_POLICIES, {tool:"search_knowledge"}], card.tools);
		// 输入文件白名单：只有表单实际引用、且确为共享根现存上传文件的路径才放行，
		// 精确到文件、不扩目录；不授权整个共享根，从执行侧隔离其他任务的产物。
		const allowedFiles = collectAllowedInputFiles(workspaceDir, input.fields);
		const baseGate = createPermissionGate({
			policies: basePolicies,
			// 权限门的 workspace 收窄到本任务专属产物目录：工具输出天然落其内，
			// 读其他任务 artifacts（artifacts/<otherTaskId>/…）即越界被拒。
			workspace: artifactDir,
			// 不再授权共享根与「共享根+本任务目录」：共享根会连其他任务产物一起放行。
			// 本任务产物已由 workspace 覆盖；输入读取走文件级白名单。
			grantedDirs: [],
			allowedFiles,
			audit: (entry) => {
				const stored: StoredAuditEntry = {
					...entry,
					at: Date.now(),
					tenantId: tenant.tenantId,
					workspaceId: tenant.workspaceId,
					userId: tenant.userId,
					// 工具级审计在 M2 即固定不带 taskId（权限门在任务上下文外也可触发）
					taskId: "",
				};
				auditStore.append(stored);
				if (entry.decision !== "allowed") {
					process.stdout.write(`[审计] ${entry.tool} 被拒：${entry.reason ?? ""}\n`);
				}
			},
		});

		const gate =
			quota === undefined
				? baseGate
				: withQuotaGate(baseGate, {
						evaluate: async () =>
							evaluateQuota({ store: meteringStore, quota, prices: modelPrices }),
						audit: (entry) => {
							process.stdout.write(
								`[配额] ${entry.tool} 被拦：${entry.reason}（${entry.exceeded}）\n`,
							);
						},
					});

		const prompt = compilePrompt(card, input.fields);

		// 用户本轮原文：自由对话取 fields.query；场景卡也尽量取 query 字段，用于标题与历史。
		const rawQuery = typeof input.fields.query === "string" ? input.fields.query : prompt;

		// 解析本次选用的智能体 / 技能（内置或本租户上传，越权 / 不存在即抛错拒建）。
		// 智能体的 systemPrompt 覆盖场景默认人设；其挂载技能 + 显式技能合并注入内核。
		const addons = resolveAddons({
			tenant,
			skillStore,
			agentStore,
			...(input.skillId === undefined ? {} : { skillId: input.skillId }),
			...(input.agentId === undefined ? {} : { agentId: input.agentId }),
		});
		const personaPrompt = addons.systemPromptOverride ?? card.systemPrompt;

		// ── 会话 / 长程任务归属 ────────────────────────────────────
		// 临时对话：首轮生成 conversationId；续聊（带 conversationId）聚合本对话历史。
		// 长程任务（带 jobId）：每次发送都是该任务下的一次新会话，上下文来自任务的
		// 长期记忆（历次会话结论）而非单个对话窗口，从而跨天、跨上下文组也能接上。
		let conversationId: string;
		let title: string;
		let history: ChatTurn[] = [];
		let job: StoredJob | undefined;
		if (input.jobId !== undefined) {
			job = jobStore.get(input.jobId);
			if (job === undefined ||
				job.tenant.tenantId !== tenant.tenantId ||
				job.tenant.workspaceId !== tenant.workspaceId) {
				throw new Error("任务不存在或无权访问");
			}
			// 长程任务下：新会话；标题沿用任务名；上下文 = 任务目标 + 历次会话记忆。
			conversationId = `conv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
			title = job.title;
			history = jobMemoryAsTurns(job);
		} else if (input.conversationId !== undefined) {
			const prior = await conversationTurns(tenant, input.conversationId);
			if (prior === undefined) throw new Error("对话不存在或无权访问");
			conversationId = input.conversationId;
			title = prior.title;
			history = prior.turns;
		} else {
			conversationId = `conv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
			title = summarizeTitle(rawQuery);
		}

		await orchestrator.submit({
			tenant,
			taskId,
			sessionId: taskId,
			scenarioId: input.scenarioId,
			conversationId,
			title,
			...(job === undefined ? {} : { jobId: job.jobId }),
			// 显式档位选路：HTTP 层已白名单校验，缺省旗舰
			tier: input.tier,
			prompt,
			systemPrompt: job === undefined ? personaPrompt : withJobContext(personaPrompt, job),
			tools,
			gate,
			history,
			...(addons.skills.length === 0 ? {} : { skills: addons.skills }),
			activeTools: activateableTools(
				card.tools,
				tools.map((t) => t.name),
			),
		});

		/**
		 * **提交后立即返回，执行在后台跑** —— 这是「执行任务时能继续对话」
		 * 的落点。不 await run()。
		 *
		 * 执行失败不会让提交接口报错，失败通过事件流回投（状态转 FAILED）。
		 */
		void orchestrator.run(taskId, prompt, rawQuery + (allowedFiles.length ? "\n\n引用资料：" + allowedFiles.map(file => basename(file)).join("、") : ""))
			.then(() => {
				// 长程任务：本轮（一次会话）跑完后，登记会话并把结论沉淀为长期记忆，
				// 供跨天/下一组上下文继续。失败不影响本次结果，只告警。
				if (job !== undefined) {
					try {
						commitJobConversation(job, conversationId, taskId);
					} catch (error) {
						process.stderr.write(
							`[长程任务] 记忆沉淀失败：${error instanceof Error ? error.message : String(error)}\n`,
						);
					}
				}
			})
			.catch((error) => {
				process.stderr.write(
					`[任务] ${taskId} 执行异常：${error instanceof Error ? error.message : String(error)}\n`,
				);
			});

		return { taskId, conversationId };
	},
	steerTask: async (tenant, taskId, text) => orchestrator.steer(taskId, text),
	cancelTask: async (tenant, taskId, reason) => void (await orchestrator.cancel(taskId, reason)),
	confirmTask: async (tenant, taskId) => {
		// 归属校验由路由层 getTask 完成；这里仅推进状态机
		void tenant;
		await orchestrator.confirm(taskId);
	},
	rejectTask: async (tenant, taskId, reason) => {
		void tenant;
		await orchestrator.reject(taskId, reason);
	},

	listScenarios: (tenant) => listCards(PRESET_CARDS, tenant.tenantId),

	uploadFile: async (tenant, file) => {
		const dir = resolveWorkspaceDir(config.workspaceDir, tenant.tenantId, tenant.workspaceId);
		mkdirSync(dir, { recursive: true });
		// 只保留安全单段文件名，防注入路径分隔符；同名加时间戳避免覆盖
		const safeBase = sanitizeUploadName(file.name);
		const finalName = uniqueName(dir, safeBase);
		const abs = join(dir, finalName);
		writeFileSync(abs, file.bytes);
		return { name: finalName, path: abs, sizeBytes: file.bytes.length };
	},

	listFiles: (tenant) => {
		const dir = resolveWorkspaceDir(config.workspaceDir, tenant.tenantId, tenant.workspaceId);
		try {
			return readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isFile())
				.map((e) => {
					const st = statSync(join(dir, e.name));
					return { name: e.name, sizeBytes: st.size, modifiedAt: st.mtimeMs } satisfies {
						name: string;
						sizeBytes: number;
						modifiedAt: number;
					};
				})
				.sort((a, b) => b.modifiedAt - a.modifiedAt);
		} catch {
			return [];
		}
	},

	workspaceFilePath: (tenant, name) => {
		// 只允许单段 basename，与工作区边界断言双重防护
		if (name !== basename(name) || name === "" || name === "." || name === "..") return undefined;
		const dir = resolveWorkspaceDir(config.workspaceDir, tenant.tenantId, tenant.workspaceId);
		const target = normalize(resolve(dir, name));
		if (target !== dir && !target.startsWith(dir + sep)) return undefined;
		try {
			if (!statSync(target).isFile()) return undefined;
		} catch {
			return undefined;
		}
		return target;
	},

	artifactPath: (tenant, taskId, name) => {
		const task = orchestrator.get(taskId);
		if (task === undefined) return undefined;
		if (task.tenant.tenantId !== tenant.tenantId || task.tenant.workspaceId !== tenant.workspaceId) {
			return undefined;
		}
		// 下载永远返回该任务**自己登记的完整路径**（产物在任务子目录
		// artifacts/<taskId>/ 下），经 realpath 边界校验后直出；
		// 绝不丢路径后到共享根按 basename 重建 —— 那是跨任务串档的根因。
		const root = resolveWorkspaceDir(config.workspaceDir, tenant.tenantId, tenant.workspaceId);
		return resolveRegisteredArtifact({ workspaceRoot: root, artifacts: task.artifacts, name });
	},

	usageDashboard: async (tenant, window) => {
		const records = await meteringStore.list(tenant.tenantId, window);
		const quota = currentQuota(tenant.tenantId);
		const verdict =
			quota === undefined
				? undefined
				: await evaluateQuota({ store: meteringStore, quota, prices: modelPrices });
		return buildDashboard({
			records,
			period: window,
			prices: modelPrices,
			...(quota === undefined ? {} : { quota }),
			...(verdict === undefined ? {} : { verdict }),
		});
	},

	auditLog: async (tenant, window) => auditStore.list(tenant.tenantId, window.from, window.to),
}, webDir === undefined ? {} : { webDir });

const controlSessions=new Map<string,{token:string;expires:number}>();
async function controlIdentity(req:IncomingMessage):Promise<Principal|undefined>{
 const direct=await authenticate(req);if(direct)return direct;
 const cookie=(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('tao_control='))?.slice(12);
 if(!cookie)return undefined;const session=controlSessions.get(cookie);
 if(!session||session.expires<Date.now()){controlSessions.delete(cookie);return undefined;}
 const account=authenticateToken(accounts,session.token);
 return account ? {tenant:account.tenant,role:account.role,name:account.name} : undefined;
}
const server = createServer((req, res) => {
 void (async()=>{
  if(req.url==='/control/logout' && req.method==='POST'){
   const cookie=(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('tao_control='))?.slice(12);
   if(cookie)controlSessions.delete(cookie);
   res.setHeader('Set-Cookie','tao_control=; Path=/control; Max-Age=0; HttpOnly; SameSite=Strict');
   sendJson(res,200,{ok:true});return;
  }
  if(req.url==='/api/control/session' && req.method==='POST'){
   const principal=await authenticate(req);
   if(!principal){sendError(res,401,'登录无效');return;}
   if(!['TENANT_ADMIN','PLATFORM_ADMIN'].includes(principal.role)){sendError(res,403,'需要管理员权限');return;}
   for(const [key,value] of controlSessions)if(value.expires<Date.now())controlSessions.delete(key);
   if(controlSessions.size>=1000){sendError(res,429,'登录会话过多');return;}
   const id=randomUUID();controlSessions.set(id,{token:(req.headers.authorization??'').replace(/^Bearer\s+/i,''),expires:Date.now()+30*60*1000});
   res.setHeader('Set-Cookie','tao_control='+id+'; Path=/control; Max-Age=1800; HttpOnly; SameSite=Strict'+(req.headers['x-forwarded-proto']==='https'?'; Secure':''));
   sendJson(res,200,{ok:true});return;
  }
  if(webDir && await handleControlGate(req,res,{webDir,authenticate:controlIdentity}))return;
  const path=new URL(req.url??'/', 'http://localhost').pathname;
  if(req.method==='POST' && ['/api/workspace/files/reference','/api/workspace/artifacts/reference'].includes(path)){
   const principal=await authenticate(req);if(!principal){sendError(res,401,'请先登录');return;}
   const parsed=await readJsonBody(req);if(!parsed.ok||!parsed.value||typeof parsed.value!=='object'){sendError(res,400,'请求参数不正确');return;}
   const body=parsed.value as {name?:unknown;taskId?:unknown};
   if(typeof body.name!=='string'){sendError(res,400,'缺少文件名');return;}
   try {
    if(path.includes('/artifacts/')){
     if(typeof body.taskId!=='string'){sendError(res,400,'缺少任务');return;}
     const source=ownedArtifact(principal.tenant,body.taskId,body.name);if(!source){sendError(res,404,'产物不存在');return;}
     const root=resolveWorkspaceDir(config.workspaceDir,principal.tenant.tenantId,principal.tenant.workspaceId);
     const name=randomUUID().slice(0,8)+'-'+sanitizeUploadName(body.name),target=join(root,name);
     copyFileSync(source,target,fsConstants.COPYFILE_EXCL);sendJson(res,200,{name,path:target});
    } else {const source=workspaceFile(config.workspaceDir,principal.tenant,body.name);sendJson(res,200,{name:body.name,path:source});}
   }catch{sendError(res,404,'文件不存在或无法引用');}return;
  }
  if(await workspaceHandler(req,res))return;
  await app(req,res);
 })().catch((error) => {
		// 兜底：路由层漏掉的异常不该让连接挂死
		process.stderr.write(`[HTTP] 未处理异常：${error instanceof Error ? error.message : error}\n`);
		if (!res.headersSent) {
			res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: "服务内部错误，请稍后重试" }));
		}
	});
});

server.listen(config.port, "0.0.0.0", () => {
	process.stdout.write(`服务已启动，监听 ${config.port} 端口。\n`);
});

/**
 * 优雅停机。
 *
 * 不处理信号的后果：docker stop 时 SSE 连接被硬切，前端看到的是
 * 「进度卡住」而非「服务重启中」—— 不会触发重连。
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		process.stdout.write(`\n收到 ${signal}，正在停止服务…\n`);
		hub.closeAll();
		void sessionFactory.close();
		// 刷盘后再退出 —— 否则最后几秒的用量会丢
		meteringStore.close();
		server.close(() => {
			process.stdout.write("服务已停止。\n");
			process.exit(0);
		});
		// 兜底：10 秒后强制退出，避免长连接拖住停机
		setTimeout(() => process.exit(0), 10_000).unref();
	});
}
