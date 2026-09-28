/**
 * 服务入口
 *
 * 装配顺序是刻意的：**配置校验 → 装配 → 监听**。
 * 配置错误在启动时就报全（见 config.ts 的说明），而不是等第一个任务
 * 失败才发现 —— 后者让客户以为是产品不好用。
 */

import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	buildDashboard,
	createPermissionGate,
	evaluateQuota,
	PRESET_CARDS,
	activateableTools,
	compilePrompt,
	resolveCard,
	restrictPolicies,
	withQuotaGate,
	type ModelPrice,
	type Quota,
	type ScenarioCard,
	type StoredAuditEntry,
	type TenantContext,
	type UsageRecord,
} from "@tao/core";
import { createDocToolset, createOfficeToolset, DOC_TOOL_POLICIES, OFFICE_TOOL_POLICIES } from "@tao/office";
import { FileAuditStore, FileMeteringStore, FileTaskStore } from "@tao/knowledge";
import {
	createModelRuntime,
	InProcessRunnerFactory,
	MemorySessionFactory,
} from "@tao/agent-host";
import { TaskOrchestrator } from "@tao/orchestrator";
import { createApp, type Principal } from "./app.ts";
import { authenticateToken, hasDefaultTokens, loadAccounts, type AccountDirectory } from "./accounts.ts";
import { describeConfig, loadConfig, renderConfigErrors } from "./config.ts";
import { SseHub } from "./sse.ts";

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
const modelPrices: readonly ModelPrice[] =
	config.modelInputPriceYuan === undefined || config.modelOutputPriceYuan === undefined
		? []
		: [
				{
					model: config.modelName,
					inputPerMillionYuan: config.modelInputPriceYuan,
					outputPerMillionYuan: config.modelOutputPriceYuan,
					...(config.modelCacheReadPriceYuan === undefined
						? {}
						: { cacheReadPerMillionYuan: config.modelCacheReadPriceYuan }),
				},
			];

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
const { models, model } = createModelRuntime({
	baseUrl: config.modelBaseUrl,
	apiKey: config.modelApiKey,
	modelName: config.modelName,
});

const factory = new InProcessRunnerFactory({
	/**
	 * 会话存储。
	 *
	 * 经 agent-host 的工厂创建，**不在这里直接 import vendor** ——
	 * 那样会破坏「业务代码不认识内核」的边界（check-boundaries.mjs 会拦）。
	 *
	 * 一期是内存实现，进程重启后会话丢失。这是明确的能力边界，
	 * 已记在 M4.md 里。
	 */
	createSession: (sessionId) => sessionFactory.create(sessionId),
	models,
	model,
	// 用量落账
	meter: (record) => meteringStore.record(record as UsageRecord),
	onMeterError: (error, taskId) => {
		// 不静默：账目差异必须能被发现
		process.stderr.write(`[计量] 任务 ${taskId} 落账失败：${error.message}\n`);
	},
});

const orchestrator = new TaskOrchestrator(factory, { store: taskStore });

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

/** 工具集。工作区按租户隔离。 */
function toolsFor(tenant: TenantContext) {
	const dir = `${config.workspaceDir}/${tenant.tenantId}/${tenant.workspaceId}`;
	mkdirSync(dir, { recursive: true });
	return {
		dir,
		tools: [...createOfficeToolset({ workspace: dir }), ...createDocToolset({ workspace: dir })],
	};
}

/**
 * 鉴权（M5-2）。
 *
 * Bearer token 在账号目录里**精确查表**得到租户 / 工作区 / 用户 / 角色，
 * 不再有「任意非空 token 进默认租户」「admin: 前缀判管理员」。
 * 查不到即匿名（路由层回 401）。
 *
 * **刻意不支持从请求体或查询参数传租户** —— 那等于没有隔离。
 */
async function authenticate(req: IncomingMessage): Promise<Principal | undefined> {
	const header = req.headers.authorization;
	const token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
	if (token === "") return undefined;
	const hit = authenticateToken(accounts, token);
	if (hit === undefined) return undefined;
	return { tenant: hit.tenant, role: hit.role };
}

const app = createApp({
	authenticate,
	hub,
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
	submitTask: async (tenant, input) => {
		const card = resolveCard(PRESET_CARDS, input.scenarioId, tenant.tenantId) as
			| ScenarioCard
			| undefined;
		if (card === undefined) throw new Error(`未知的场景：${input.scenarioId}`);

		const { tools } = toolsFor(tenant);
		const quota = currentQuota(tenant.tenantId);
		const basePolicies = restrictPolicies([...OFFICE_TOOL_POLICIES, ...DOC_TOOL_POLICIES], card.tools);
		const baseGate = createPermissionGate({
			policies: basePolicies,
			workspace: toolsFor(tenant).dir,
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

		const taskId = `task-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
		const prompt = compilePrompt(card, input.fields);

		await orchestrator.submit({
			tenant,
			taskId,
			sessionId: taskId,
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate,
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
		void orchestrator.run(taskId, prompt).catch((error) => {
			process.stderr.write(
				`[任务] ${taskId} 执行异常：${error instanceof Error ? error.message : String(error)}\n`,
			);
		});

		return { taskId };
	},
	steerTask: async (tenant, taskId, text) => orchestrator.steer(taskId, text),
	cancelTask: async (tenant, taskId, reason) => void (await orchestrator.cancel(taskId, reason)),

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
});

const server = createServer((req, res) => {
	void app(req, res).catch((error) => {
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
