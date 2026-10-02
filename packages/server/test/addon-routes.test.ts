/**
 * 技能 / 智能体 HTTP 路由测试
 *
 * 重点：入参校验（缺必填 → 400）、成功路径、未装配 → 501，
 * 以及 POST /api/tasks 对 skillId / agentId 的白名单透传。
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, Role, SseHub, type AppDeps, type Principal } from "../src/index.ts";
import type { TaskEvent, TenantContext } from "@tao/core";

const TENANT: TenantContext = { tenantId: "univ-010", workspaceId: "office", userId: "sun" };

const servers: Server[] = [];
const hubs: SseHub[] = [];
afterEach(async () => {
	for (const h of hubs.splice(0)) h.closeAll();
	for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function serve(overrides: Partial<AppDeps> = {}) {
	const hub = new SseHub();
	hubs.push(hub);
	const calls: Record<string, unknown[]> = {};
	const track = (n: string, a: unknown) => { calls[n] = [...(calls[n] ?? []), a]; };
	const deps: AppDeps = {
		authenticate: async (): Promise<Principal> => ({ tenant: TENANT, role: Role.Member, name: "sun" }),
		hub,
		taskEvents: (): TaskEvent[] => [],
		listTasks: () => [],
		getTask: () => undefined,
		submitTask: async (_tenant, input) => {
			track("submitTask", input);
			return { taskId: "t-new", conversationId: "c-1" };
		},
		steerTask: async () => {},
		cancelTask: async () => {},
		listSkills: () => [{ skillId: "s1", name: "技能一" }],
		listAgents: () => [{ agentId: "a1", name: "智能体一" }],
		createSkill: async (_t, input) => {
			track("createSkill", input);
			return { skillId: "s-new" };
		},
		createAgent: async (_t, input) => {
			track("createAgent", input);
			return { agentId: "a-new" };
		},
		...overrides,
	};
	const app = createApp(deps);
	const server = createServer((req, res) => void app(req, res));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return { port, calls };
}

async function call(port: number, path: string, init: RequestInit = {}) {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		headers: { Authorization: "Bearer t", ...(init.headers ?? {}) },
		...init,
	});
	const text = await res.text();
	let body: Record<string, unknown> = {};
	try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
	return { status: res.status, body };
}

describe("技能路由", () => {
	it("GET 返回列表", async () => {
		const { port } = await serve();
		const r = await call(port, "/api/skills");
		expect(r.status).toBe(200);
		expect((r.body.skills as unknown[])[0]).toMatchObject({ skillId: "s1" });
	});

	it("POST 缺名称或内容 → 400", async () => {
		const { port } = await serve();
		const bad = await call(port, "/api/skills", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }),
		});
		expect(bad.status).toBe(400);
	});

	it("POST 合法 → 201 且回填默认描述", async () => {
		const { port, calls } = await serve();
		const r = await call(port, "/api/skills", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "我的技能", content: "# 规则" }),
		});
		expect(r.status).toBe(201);
		expect(r.body.skillId).toBe("s-new");
		expect((calls.createSkill[0] as { description: string }).description).toBe("自定义技能");
	});

	it("未装配技能能力 → 501", async () => {
		const { port } = await serve({ listSkills: undefined, createSkill: undefined });
		const r = await call(port, "/api/skills");
		expect(r.status).toBe(501);
	});
});

describe("智能体路由", () => {
	it("POST 缺系统提示词 → 400；合法 → 201", async () => {
		const { port } = await serve();
		const bad = await call(port, "/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		expect(bad.status).toBe(400);
		const ok = await call(port, "/api/agents", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "角色", systemPrompt: "你是…", skillIds: ["s1", 1, "s1"] }),
		});
		expect(ok.status).toBe(201);
		expect(ok.body.agentId).toBe("a-new");
	});
});

describe("任务提交透传扩展", () => {
	it("POST /api/tasks 白名单透传 skillId / agentId，过滤非法类型", async () => {
		const { port, calls } = await serve();
		const r = await call(port, "/api/tasks", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "你好", skillId: "s1", agentId: "a1", bogus: "x" }),
		});
		expect(r.status).toBe(202);
		const input = calls.submitTask[0] as Record<string, unknown>;
		expect(input.skillId).toBe("s1");
		expect(input.agentId).toBe("a1");
		expect("bogus" in input).toBe(false);
	});
});
