/**
 * 服务入口
 *
 * 装配顺序是刻意的：**配置校验 → 装配 → 监听**。
 * 配置错误在启动时就报全（见 config.ts 的说明），而不是等第一个任务
 * 失败才发现 —— 后者让客户以为是产品不好用。
 */

import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync } from "node:fs";
import {
	createPermissionGate,
	evaluateQuota,
	PRESET_CARDS,
	activateableTools,
	compilePrompt,
	resolveCard,
	restrictPolicies,
	withQuotaGate,
	type Quota,
	type ScenarioCard,
	type TenantContext,
	type UsageRecord,
} from "@tao/core";
import { createDocToolset, createOfficeToolset, DOC_TOOL_POLICIES, OFFICE_TOOL_POLICIES } from "@tao/office";
import { MemoryMeteringStore } from "@tao/knowledge";
import {
	createModelRuntime,
	InProcessRunnerFactory,
	MemorySessionFactory,
} from "@tao/agent-host";
import { TaskOrchestrator } from "@tao/orchestrator";
import { createApp, type Principal } from "./app.ts";
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

const meteringStore = new MemoryMeteringStore();
const sessionFactory = new MemorySessionFactory();
const hub = new SseHub();

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

const orchestrator = new TaskOrchestrator(factory);

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
 * 鉴权。
 *
 * 一期用 Bearer token 映射到租户，token 从环境变量读。
 * 这是私有化单租户部署的够用形态；SaaS 形态换成真实会话服务。
 *
 * **刻意不支持从请求体或查询参数传租户** —— 那等于没有隔离。
 */
async function authenticate(req: IncomingMessage): Promise<Principal | undefined> {
	const header = req.headers.authorization;
	const token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
	if (token === "") return undefined;

	/**
	 * 一期：单租户私有化部署，任何非空 token 都映射到默认租户。
	 *
	 * 这不是「鉴权没做」而是「单租户部署下鉴权的退化形态」——
	 * 但它必须在 M4.md 的能力边界里写明，否则会被当成已完成的多租户鉴权。
	 */
	return {
		tenant: { tenantId: "default", workspaceId: "default", userId: token.slice(0, 16) },
	};
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
				if (entry.decision !== "allowed") {
					process.stdout.write(`[审计] ${entry.tool} 被拒：${entry.reason ?? ""}\n`);
				}
			},
		});

		const gate =
			quota === undefined
				? baseGate
				: withQuotaGate(baseGate, {
						evaluate: async () => evaluateQuota({ store: meteringStore, quota }),
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
		server.close(() => {
			process.stdout.write("服务已停止。\n");
			process.exit(0);
		});
		// 兜底：10 秒后强制退出，避免长连接拖住停机
		setTimeout(() => process.exit(0), 10_000).unref();
	});
}
