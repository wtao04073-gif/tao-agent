/**
 * HTTP 路由
 *
 * 只用 Node 内置 `http`（依据见 [Spike 7](../../../spikes/07-sse-delivery/)）。
 * 手写路由在这个规模下比引框架更划算 —— 接口不到十个，而每个依赖
 * 都是私有化部署的一处风险。
 *
 * ── 一条贯穿全文件的原则 ──
 *
 * **租户身份从不信任请求体。** 它只来自鉴权中间件解析出的会话。
 * 允许请求体带 tenantId 就等于允许任意租户读别家数据 ——
 * 这类漏洞在代码审查里很难看出来，因为参数名看着很正常。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { hasRoleAtLeast, Role, type TaskEvent, type TenantContext } from "@tao/core";
import { parseAnchor, SseHub } from "./sse.ts";

/** 请求体大小上限。防止一个请求吃满内存。 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** 鉴权结果。 */
export interface Principal {
	readonly tenant: TenantContext;
	/**
	 * 角色。管理接口按它判权。
	 *
	 * 默认 `Member` 而非 `TenantAdmin` —— 鉴权实现忘记设角色时，
	 * 后果应当是「管理接口用不了」而不是「谁都是管理员」。
	 */
	readonly role: Role;
}

/** 平台需要的外部依赖。全部注入，便于测试与替换。 */
export interface AppDeps {
	/**
	 * 解析请求身份。返回 undefined 表示未通过鉴权。
	 *
	 * 一期由调用方注入一个简单实现（Bearer token → 租户）；
	 * SaaS 形态换成真实的会话服务。
	 */
	readonly authenticate: (req: IncomingMessage) => Promise<Principal | undefined>;
	/** 取某任务的事件历史，供 SSE 重连补发。 */
	readonly taskEvents: (tenant: TenantContext, taskId: string, afterSeq: number) => readonly TaskEvent[];
	/** 列出某租户工作区的任务。 */
	readonly listTasks: (tenant: TenantContext) => readonly unknown[];
	/** 取单个任务。返回 undefined 表示不存在或不属于该租户。 */
	readonly getTask: (tenant: TenantContext, taskId: string) => unknown | undefined;
	/** 提交任务。 */
	readonly submitTask: (
		tenant: TenantContext,
		input: { readonly scenarioId: string; readonly fields: Record<string, unknown> },
	) => Promise<{ readonly taskId: string }>;
	/** 在执行期间插入消息（「执行中可继续对话」的落点）。 */
	readonly steerTask: (tenant: TenantContext, taskId: string, text: string) => Promise<void>;
	/** 取消任务。 */
	readonly cancelTask: (tenant: TenantContext, taskId: string, reason: string) => Promise<void>;
	readonly hub: SseHub;
	/**
	 * 取用量看板。仅租户管理员可调。
	 *
	 * 时间窗由调用方给定（默认当月），便于管理员查历史周期。
	 */
	readonly usageDashboard?: (
		tenant: TenantContext,
		window: { readonly from: number; readonly to: number },
	) => Promise<unknown>;
	/** 取审计日志。仅租户管理员可调。 */
	readonly auditLog?: (
		tenant: TenantContext,
		window: { readonly from: number; readonly to: number },
	) => Promise<readonly unknown[]>;
}

/** 读取并解析 JSON 请求体。 */
export async function readJsonBody(
	req: IncomingMessage,
	maxBytes = MAX_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		// 超限立即中断，不等读完 —— 否则上限形同虚设
		if (size > maxBytes) {
			return { ok: false, reason: `请求体超过 ${Math.floor(maxBytes / 1024)} KB 上限` };
		}
		chunks.push(buffer);
	}

	if (size === 0) return { ok: true, value: {} };

	try {
		return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
	} catch {
		return { ok: false, reason: "请求体不是合法的 JSON" };
	}
}

/** 回一个 JSON 响应。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(text),
	});
	res.end(text);
}

/**
 * 回一个错误响应。
 *
 * **面向用户的话术，不是技术报错。** 行业用户看到「500 Internal
 * Server Error」只会打电话；看到「模型服务暂时不可用，请稍后重试」
 * 至少知道不是自己操作错了。
 */
export function sendError(res: ServerResponse, status: number, message: string): void {
	sendJson(res, status, { error: message });
}

/**
 * 从 URL 里取路径段，并解码。
 *
 * **必须解码**：不解码的话中文路径会以 `%E4%B9%B1%E6%9D%A5` 的形态
 * 进入错误信息，用户看到一串乱码不知道自己敲错了什么。
 * 目标用户是高校行政与制造业管理岗，他们会用中文命名。
 *
 * 解码失败（畸形百分号编码）时保留原串 —— 报错总比崩掉好。
 */
function segments(pathname: string): string[] {
	return pathname
		.split("/")
		.filter((s) => s !== "")
		.map((s) => {
			try {
				return decodeURIComponent(s);
			} catch {
				return s;
			}
		});
}

/**
 * 解析时间窗查询参数，默认当月。
 *
 * 畸形值退回默认值而非报错 —— 管理员手敲 URL 时打错一个字符，
 * 应当看到当月数据而不是一条参数校验错误。
 *
 * 但**起止顺序颠倒要报错**：`from > to` 会让查询返回空，
 * 管理员会以为「这个月没人用」，而实际是参数写反了。
 */
export function parseWindow(
	params: URLSearchParams,
	now: () => number,
): { ok: true; window: { from: number; to: number } } | { ok: false; reason: string } {
	const parse = (raw: string | null): number | undefined => {
		if (raw === null || raw.trim() === "") return undefined;
		// 同时接受毫秒时间戳与 YYYY-MM-DD
		const asNumber = Number(raw);
		if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
		const asDate = Date.parse(raw);
		return Number.isNaN(asDate) ? undefined : asDate;
	};

	const at = new Date(now());
	const defaultFrom = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
	const defaultTo = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);

	const from = parse(params.get("from")) ?? defaultFrom;
	const to = parse(params.get("to")) ?? defaultTo;

	if (from >= to) {
		return {
			ok: false,
			reason: "起始时间必须早于结束时间。参数格式为毫秒时间戳或 YYYY-MM-DD",
		};
	}
	return { ok: true, window: { from, to } };
}

/**
 * 构造请求处理器。
 *
 * 路由表：
 *   GET  /healthz                      存活探测（不鉴权）
 *   GET  /api/tasks                    任务列表
 *   POST /api/tasks                    提交任务
 *   GET  /api/tasks/:id                任务详情
 *   POST /api/tasks/:id/steer          执行中插话
 *   POST /api/tasks/:id/cancel         取消
 *   GET  /api/events                   SSE 事件流
 */
export function createApp(deps: AppDeps, options: { now?: () => number } = {}) {
	const now = options.now ?? (() => Date.now());

	return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const path = segments(url.pathname);
		const method = req.method ?? "GET";

		/**
		 * 存活探测不鉴权。
		 *
		 * 放在鉴权之前：Compose 的 healthcheck 与负载均衡的探测都不带凭证，
		 * 要求鉴权会让容器被判定为不健康而反复重启。
		 */
		if (method === "GET" && path.length === 1 && path[0] === "healthz") {
			sendJson(res, 200, { status: "ok" });
			return;
		}

		let principal: Principal | undefined;
		try {
			principal = await deps.authenticate(req);
		} catch {
			// 鉴权组件自身故障不该泄漏内部错误
			sendError(res, 503, "鉴权服务暂时不可用，请稍后重试");
			return;
		}

		if (principal === undefined) {
			sendError(res, 401, "未登录或登录已过期，请重新登录");
			return;
		}
		const { tenant } = principal;

		// ── SSE 事件流 ──
		if (method === "GET" && path.length === 2 && path[0] === "api" && path[1] === "events") {
			const taskId = url.searchParams.get("taskId");
			const anchor = parseAnchor(
				req.headers["last-event-id"],
				url.searchParams.get("lastEventId"),
			);

			/**
			 * 订阅特定任务前先校验归属。
			 *
			 * 不校验的话，猜到别家的 taskId 就能收到对方的全部事件 ——
			 * 而事件里含文件路径、数据摘要这些敏感内容。
			 * SseHub 的租户过滤是第二道闸，但第一道必须在这里。
			 */
			if (taskId !== null && deps.getTask(tenant, taskId) === undefined) {
				sendError(res, 404, "任务不存在");
				return;
			}

			deps.hub.attach({
				res,
				tenantId: tenant.tenantId,
				workspaceId: tenant.workspaceId,
				taskId,
				backlog: taskId === null ? [] : deps.taskEvents(tenant, taskId, anchor),
				onClientClose: (handler) => req.on("close", handler),
			});
			return;
		}

		// ── 任务集合 ──
		if (path.length === 2 && path[0] === "api" && path[1] === "tasks") {
			if (method === "GET") {
				sendJson(res, 200, { tasks: deps.listTasks(tenant) });
				return;
			}

			if (method === "POST") {
				const body = await readJsonBody(req);
				if (!body.ok) {
					sendError(res, 400, body.reason);
					return;
				}
				const input = body.value as { scenarioId?: unknown; fields?: unknown };
				if (typeof input.scenarioId !== "string" || input.scenarioId === "") {
					sendError(res, 400, "缺少场景标识（scenarioId）");
					return;
				}

				try {
					// 租户来自鉴权，**绝不**从请求体取 —— 见文件头说明
					const result = await deps.submitTask(tenant, {
						scenarioId: input.scenarioId,
						fields:
							typeof input.fields === "object" && input.fields !== null
								? (input.fields as Record<string, unknown>)
								: {},
					});
					sendJson(res, 202, result);
				} catch (error) {
					sendError(res, 400, error instanceof Error ? error.message : "任务提交失败");
				}
				return;
			}

			sendError(res, 405, `不支持 ${method} 方法`);
			return;
		}

		// ── 单个任务 ──
		if (path.length === 3 && path[0] === "api" && path[1] === "tasks" && method === "GET") {
			const task = deps.getTask(tenant, path[2] as string);
			if (task === undefined) {
				// 不存在与无权访问都回 404 —— 回 403 会泄漏「这个 id 存在」
				sendError(res, 404, "任务不存在");
				return;
			}
			sendJson(res, 200, task);
			return;
		}

		// ── 任务动作 ──
		if (path.length === 4 && path[0] === "api" && path[1] === "tasks" && method === "POST") {
			const taskId = path[2] as string;
			const action = path[3];

			if (deps.getTask(tenant, taskId) === undefined) {
				sendError(res, 404, "任务不存在");
				return;
			}

			const body = await readJsonBody(req);
			if (!body.ok) {
				sendError(res, 400, body.reason);
				return;
			}
			const payload = body.value as { text?: unknown; reason?: unknown };

			try {
				if (action === "steer") {
					if (typeof payload.text !== "string" || payload.text.trim() === "") {
						sendError(res, 400, "插话内容不能为空");
						return;
					}
					await deps.steerTask(tenant, taskId, payload.text);
					/**
					 * 口径固定：**已插入，将在当前步骤完成后送达**。
					 *
					 * 内核的 steering 永不打断执行中的工具。回「已打断」
					 * 是无法兑现的承诺，用户会以为当前动作已停止。
					 */
					sendJson(res, 202, {
						delivery: "queued_after_current_step",
						message: "已收到，将在当前步骤完成后送达",
					});
					return;
				}

				if (action === "cancel") {
					const reason = typeof payload.reason === "string" ? payload.reason : "用户取消";
					await deps.cancelTask(tenant, taskId, reason);
					sendJson(res, 200, { status: "cancelled" });
					return;
				}
			} catch (error) {
				sendError(res, 409, error instanceof Error ? error.message : "操作失败");
				return;
			}

			sendError(res, 404, `未知的操作：${action}`);
			return;
		}

		// ── 管理接口（仅租户管理员）──
		if (path.length >= 2 && path[0] === "api" && path[1] === "admin") {
			/**
			 * 权限在这里统一判，不在每个子路由里各判一次。
			 *
			 * 分散判权的问题是「新增一个管理接口忘了加判断」——
			 * 而那个疏漏的后果是普通成员能看到全租户的用量与审计日志。
			 */
			if (!hasRoleAtLeast(principal.role, Role.TenantAdmin)) {
				// 回 403 而非 404：管理员入口是公开知识，藏不住也没必要藏。
				// 但要说清是权限问题，否则管理员会以为功能没部署
				sendError(res, 403, "需要租户管理员权限。若你确认应当有权限，请联系平台管理员");
				return;
			}

			const window = parseWindow(url.searchParams, now);
			if (!window.ok) {
				sendError(res, 400, window.reason);
				return;
			}

			if (method === "GET" && path[2] === "usage") {
				if (deps.usageDashboard === undefined) {
					sendError(res, 501, "当前部署未启用用量看板");
					return;
				}
				sendJson(res, 200, await deps.usageDashboard(tenant, window.window));
				return;
			}

			if (method === "GET" && path[2] === "audit") {
				if (deps.auditLog === undefined) {
					sendError(res, 501, "当前部署未启用审计查询");
					return;
				}
				const entries = await deps.auditLog(tenant, window.window);
				sendJson(res, 200, { entries, count: entries.length });
				return;
			}

			if (method === "GET" && path[2] === "tasks") {
				// 管理员看全工作区的任务，而成员只看自己工作区的
				sendJson(res, 200, { tasks: deps.listTasks(tenant) });
				return;
			}

			sendError(res, 404, `未知的管理接口：${path.slice(2).join("/")}`);
			return;
		}

		sendError(res, 404, "接口不存在");
	};
}
