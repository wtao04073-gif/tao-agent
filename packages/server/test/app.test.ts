/**
 * HTTP 路由测试
 *
 * 断言重点在**权限与隔离**上。业务逻辑已在各自模块测过，
 * 路由层最容易出的错是：
 *
 *  - 新增管理接口忘了判权 → 普通成员看到全租户数据
 *  - 用请求体里的 tenantId → 任意租户读别家数据
 *  - 用 403 而非 404 回「别家的任务」→ 泄漏「这个 id 存在」
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, parseWindow, Role, SseHub, type AppDeps, type Principal } from "../src/index.ts";
import type { TaskEvent, TenantContext } from "@tao/core";

const TENANT: TenantContext = { tenantId: "univ-010", workspaceId: "office", userId: "sun" };
const NOW = Date.UTC(2026, 8, 15);

const servers: Server[] = [];
const hubs: SseHub[] = [];

afterEach(async () => {
	for (const h of hubs.splice(0)) h.closeAll();
	for (const s of servers.splice(0)) {
		await new Promise<void>((resolve) => s.close(() => resolve()));
	}
});

/** 起一个用 createApp 的服务。 */
/**
 * 起一个用 createApp 的服务。
 *
 * `principal` 用 `{ value }` 包一层而非直接给默认参数 ——
 * 默认参数在显式传 `undefined` 时也会回落到默认值，
 * 于是「测未鉴权」的用例实际上是带着成员身份跑的，断言假通过。
 */
async function serve(
	overrides: Partial<AppDeps> = {},
	principal: { value: Principal | undefined } = { value: { tenant: TENANT, role: Role.Member } },
): Promise<{ port: number; calls: Record<string, unknown[]> }> {
	const hub = new SseHub();
	hubs.push(hub);
	const calls: Record<string, unknown[]> = {};
	const track = (name: string, args: unknown): void => {
		calls[name] = [...(calls[name] ?? []), args];
	};

	const deps: AppDeps = {
		authenticate: async () => principal.value,
		hub,
		taskEvents: () => [],
		listTasks: (tenant) => {
			track("listTasks", tenant);
			return [{ taskId: "t-1", status: "SUCCEEDED" }];
		},
		getTask: (_tenant, taskId) => (taskId === "t-1" ? { taskId, status: "RUNNING" } : undefined),
		submitTask: async (tenant, input) => {
			track("submitTask", { tenant, input });
			return { taskId: "new-task" };
		},
		steerTask: async (tenant, taskId, text) => void track("steerTask", { taskId, text }),
		cancelTask: async (tenant, taskId, reason) => void track("cancelTask", { taskId, reason }),
		...overrides,
	};

	const app = createApp(deps, { now: () => NOW });
	const server = createServer((req, res) => void app(req, res));
	servers.push(server);

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({ port, calls });
		});
	});
}

async function call(
	port: number,
	path: string,
	init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		headers: { Authorization: "Bearer t", ...(init.headers ?? {}) },
		...init,
	});
	const text = await res.text();
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(text) as Record<string, unknown>;
	} catch {
		body = { raw: text };
	}
	return { status: res.status, body };
}

describe("时间窗解析", () => {
	const now = () => NOW;

	it("默认取当月", () => {
		const result = parseWindow(new URLSearchParams(), now);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.window.from).toBe(Date.UTC(2026, 8, 1));
			expect(result.window.to).toBe(Date.UTC(2026, 9, 1));
		}
	});

	it("接受 YYYY-MM-DD", () => {
		const result = parseWindow(new URLSearchParams("from=2026-08-01&to=2026-09-01"), now);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.window.from).toBe(Date.parse("2026-08-01"));
	});

	it("接受毫秒时间戳", () => {
		const result = parseWindow(new URLSearchParams(`from=1000&to=2000`), now);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.window).toEqual({ from: 1000, to: 2000 });
	});

	it("畸形值退回默认，不报错", () => {
		// 管理员手敲 URL 打错一个字符，应当看到当月数据而非参数校验错误
		const result = parseWindow(new URLSearchParams("from=不是日期"), now);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.window.from).toBe(Date.UTC(2026, 8, 1));
	});

	it("起止颠倒时报错 —— 否则返回空会被当成「没人用」", () => {
		const result = parseWindow(new URLSearchParams("from=2026-09-01&to=2026-08-01"), now);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("早于");
	});

	it("起止相同也报错（空窗口）", () => {
		const result = parseWindow(new URLSearchParams("from=1000&to=1000"), now);
		expect(result.ok).toBe(false);
	});
});

describe("存活探测", () => {
	it("不需要鉴权 —— healthcheck 与负载均衡都不带凭证", async () => {
		// 要求鉴权会让容器被判定为不健康而反复重启
		const { port } = await serve({}, { value: undefined });
		const res = await fetch(`http://127.0.0.1:${port}/healthz`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});
});

describe("鉴权", () => {
	it("未通过鉴权回 401，话术面向用户", async () => {
		const { port } = await serve({}, { value: undefined });
		const { status, body } = await call(port, "/api/tasks");
		expect(status).toBe(401);
		// 不是「Unauthorized」这种技术报错
		expect(body.error).toContain("重新登录");
	});

	it("鉴权组件故障回 503，不泄漏内部错误", async () => {
		const { port } = await serve({
			authenticate: async () => {
				throw new Error("数据库连接串是 postgres://user:pass@host/db");
			},
		});
		const { status, body } = await call(port, "/api/tasks");
		expect(status).toBe(503);
		// 内部细节不能出现在响应里
		expect(JSON.stringify(body)).not.toContain("postgres://");
	});
});

describe("任务接口", () => {
	it("列表用鉴权得到的租户，不看请求参数", async () => {
		const { port, calls } = await serve();
		await call(port, "/api/tasks?tenantId=别家租户");
		expect(calls.listTasks?.[0]).toEqual(TENANT);
	});

	it("提交任务时租户来自鉴权，不来自请求体", async () => {
		/**
		 * 允许请求体带租户信息就等于允许任意租户写别家数据。
		 *
		 * 这条断言被变异测试加强过：原版只在请求体里放 `tenantId`，
		 * 而把实现改成读 `input.tenant` 后依然通过 —— 攻击者会试
		 * **各种可能的字段名**，测试也必须覆盖多种写法。
		 */
		const { port, calls } = await serve();
		const evil = {
			scenarioId: "univ.official-notice",
			fields: {},
			// 一次塞进全部可能的字段名
			tenant: { tenantId: "别家租户", workspaceId: "别家工作区", userId: "攻击者" },
			tenantId: "别家租户",
			workspaceId: "别家工作区",
			userId: "攻击者",
		};
		const { status } = await call(port, "/api/tasks", {
			method: "POST",
			body: JSON.stringify(evil),
		});
		expect(status).toBe(202);

		const passed = calls.submitTask?.[0] as { tenant: TenantContext };
		// 严格相等：任何一个字段被请求体污染都会让这条失败
		expect(passed.tenant).toEqual(TENANT);
		expect(JSON.stringify(passed.tenant)).not.toContain("别家");
		expect(JSON.stringify(passed.tenant)).not.toContain("攻击者");
	});

	it("请求体里的租户字段不会混进 fields 传给场景卡", async () => {
		// fields 会被拼进提示词。把租户信息混进去会让模型看到别家租户名
		const { port, calls } = await serve();
		await call(port, "/api/tasks", {
			method: "POST",
			body: JSON.stringify({
				scenarioId: "univ.official-notice",
				fields: { subject: "正常字段" },
				tenantId: "别家租户",
			}),
		});
		const passed = calls.submitTask?.[0] as { input: { fields: Record<string, unknown> } };
		expect(passed.input.fields).toEqual({ subject: "正常字段" });
	});

	it("缺 scenarioId 时回可读的错误", async () => {
		const { port } = await serve();
		const { status, body } = await call(port, "/api/tasks", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(status).toBe(400);
		expect(body.error).toContain("场景标识");
	});

	it("请求体不是 JSON 时回 400 而非 500", async () => {
		const { port } = await serve();
		const { status, body } = await call(port, "/api/tasks", {
			method: "POST",
			body: "这不是 JSON",
		});
		expect(status).toBe(400);
		expect(body.error).toContain("JSON");
	});

	it("不存在的任务回 404", async () => {
		const { port } = await serve();
		expect((await call(port, "/api/tasks/不存在")).status).toBe(404);
	});

	it("别家的任务也回 404 而非 403 —— 403 会泄漏「这个 id 存在」", async () => {
		const { port } = await serve({
			// 模拟「任务存在但不属于本租户」：getTask 已做归属过滤，返回 undefined
			getTask: () => undefined,
		});
		const { status } = await call(port, "/api/tasks/别家的任务");
		expect(status).toBe(404);
	});

	it("插话口径是「当前步骤完成后送达」，不承诺打断", async () => {
		// 内核 steering 永不打断执行中的工具。回「已打断」是无法兑现的承诺
		const { port } = await serve();
		const { status, body } = await call(port, "/api/tasks/t-1/steer", {
			method: "POST",
			body: JSON.stringify({ text: "补充一句" }),
		});
		expect(status).toBe(202);
		expect(body.delivery).toBe("queued_after_current_step");
		expect(body.message).toContain("当前步骤完成后");
	});

	it("空插话被拒", async () => {
		const { port } = await serve();
		const { status, body } = await call(port, "/api/tasks/t-1/steer", {
			method: "POST",
			body: JSON.stringify({ text: "   " }),
		});
		expect(status).toBe(400);
		expect(body.error).toContain("不能为空");
	});

	it("对不存在的任务插话回 404", async () => {
		const { port } = await serve();
		const { status } = await call(port, "/api/tasks/不存在/steer", {
			method: "POST",
			body: JSON.stringify({ text: "x" }),
		});
		expect(status).toBe(404);
	});

	it("取消带默认理由", async () => {
		const { port, calls } = await serve();
		await call(port, "/api/tasks/t-1/cancel", { method: "POST", body: "{}" });
		expect((calls.cancelTask?.[0] as { reason: string }).reason).toBe("用户取消");
	});

	it("未知动作回 404 并指出是哪个", async () => {
		const { port } = await serve();
		const { status, body } = await call(port, "/api/tasks/t-1/乱来", {
			method: "POST",
			body: "{}",
		});
		expect(status).toBe(404);
		expect(body.error).toContain("乱来");
	});

	it("不支持的方法回 405", async () => {
		const { port } = await serve();
		expect((await call(port, "/api/tasks", { method: "DELETE" })).status).toBe(405);
	});
});

describe("管理接口 · 权限", () => {
	const admin: Principal = { tenant: TENANT, role: Role.TenantAdmin };

	it("普通成员访问管理接口回 403", async () => {
		// 这是本文件最重要的一条：管理接口泄漏等于全租户用量与审计对所有人可见
		const { port } = await serve({ usageDashboard: async () => ({ totals: {} }) });
		const { status, body } = await call(port, "/api/admin/usage");
		expect(status).toBe(403);
		expect(body.error).toContain("管理员权限");
	});

	it("工作区管理员也不够 —— 用量是租户级数据", async () => {
		const { port } = await serve(
			{ usageDashboard: async () => ({ totals: {} }) },
			{ value: { tenant: TENANT, role: Role.WorkspaceAdmin } },
		);
		expect((await call(port, "/api/admin/usage")).status).toBe(403);
	});

	it("租户管理员可以访问", async () => {
		const { port } = await serve({ usageDashboard: async () => ({ totalTokens: 123 }) }, { value: admin });
		const { status, body } = await call(port, "/api/admin/usage");
		expect(status).toBe(200);
		expect(body.totalTokens).toBe(123);
	});

	it("平台管理员可以访问（角色更高）", async () => {
		const { port } = await serve(
			{ usageDashboard: async () => ({ ok: true }) },
			{ value: { tenant: TENANT, role: Role.PlatformAdmin } },
		);
		expect((await call(port, "/api/admin/usage")).status).toBe(200);
	});

	it("**全部**管理子路由都受同一道权限闸", async () => {
		/**
		 * 权限在 /api/admin 这一层统一判，不在每个子路由各判一次。
		 * 分散判权的问题是「新增接口忘了加判断」—— 这条断言守住它：
		 * 任何以 /api/admin 开头的路径，成员身份都拿不到 200。
		 */
		const { port } = await serve({
			usageDashboard: async () => ({}),
			auditLog: async () => [],
		});
		for (const path of [
			"/api/admin/usage",
			"/api/admin/audit",
			"/api/admin/tasks",
			"/api/admin/未来新增的接口",
		]) {
			const { status } = await call(port, path);
			expect(status, path).toBe(403);
		}
	});
});

describe("管理接口 · 行为", () => {
	const admin: Principal = { tenant: TENANT, role: Role.TenantAdmin };

	it("未启用看板时回 501 并说明，不是 404", async () => {
		// 404 会让管理员以为路径写错了，反复试
		const { port } = await serve({}, { value: admin });
		const { status, body } = await call(port, "/api/admin/usage");
		expect(status).toBe(501);
		expect(body.error).toContain("未启用");
	});

	it("时间窗默认当月，可用参数覆盖", async () => {
		const windows: Array<{ from: number; to: number }> = [];
		const { port } = await serve(
			{
				usageDashboard: async (_t, w) => {
					windows.push(w);
					return {};
				},
			},
			{ value: admin },
		);

		await call(port, "/api/admin/usage");
		expect(windows[0]).toEqual({ from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 9, 1) });

		await call(port, "/api/admin/usage?from=2026-01-01&to=2026-02-01");
		expect(windows[1]?.from).toBe(Date.parse("2026-01-01"));
	});

	it("起止颠倒时回 400 而非返回空数据", async () => {
		const { port } = await serve({ usageDashboard: async () => ({}) }, { value: admin });
		const { status, body } = await call(port, "/api/admin/usage?from=2026-09-01&to=2026-08-01");
		expect(status).toBe(400);
		expect(body.error).toContain("早于");
	});

	it("审计查询带条数，便于判断是否被截断", async () => {
		const { port } = await serve(
			{ auditLog: async () => [{ tool: "write_document", decision: "allowed" }] },
			{ value: admin },
		);
		const { status, body } = await call(port, "/api/admin/audit");
		expect(status).toBe(200);
		expect(body.count).toBe(1);
	});

	it("管理接口的租户同样来自鉴权", async () => {
		const seen: TenantContext[] = [];
		const { port } = await serve(
			{
				usageDashboard: async (tenant) => {
					seen.push(tenant);
					return {};
				},
			},
			{ value: admin },
		);
		await call(port, "/api/admin/usage?tenantId=别家租户");
		expect(seen[0]).toEqual(TENANT);
	});

	it("未知管理子路由回 404 并指出是哪个", async () => {
		const { port } = await serve({}, { value: admin });
		const { status, body } = await call(port, "/api/admin/乱来");
		expect(status).toBe(404);
		expect(body.error).toContain("乱来");
	});
});

describe("未知路径", () => {
	it("回 404 而非 500", async () => {
		const { port } = await serve();
		const { status, body } = await call(port, "/api/根本没有");
		expect(status).toBe(404);
		expect(body.error).toContain("接口不存在");
	});
});
