/**
 * 服务端提交校验测试
 *
 * main.ts 在 resolveCard 之后、compilePrompt 之前调用 assertSubmissionValid
 * （内部为 @tao/core 的 validateSubmission）。这里直接测该服务端函数，并经
 * createApp 验证越界数字提交会回 400 且不创建任务。
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FieldType, Role, Scope, type ScenarioCard, type TenantContext } from "@tao/core";
import { createApp, assertSubmissionValid, SseHub, type AppDeps, type Principal } from "../src/index.ts";

const CARD: ScenarioCard = {
	id: "test.number",
	title: "数字范围卡",
	summary: "",
	industry: "general",
	category: "通用",
	fields: [
		{ name: "count", label: "数量", type: FieldType.Number, required: true, min: 1, max: 100 },
		{ name: "note", label: "备注", type: FieldType.Text, required: false },
	],
	tools: [],
	systemPrompt: "s",
	promptTemplate: "数量：{{count}}",
	scope: Scope.Platform,
	tenantId: null,
	enabled: true,
};

describe("assertSubmissionValid（服务端）", () => {
	it("数字在 min/max 内通过", () => {
		expect(() => assertSubmissionValid(CARD, { count: 50 })).not.toThrow();
		expect(() => assertSubmissionValid(CARD, { count: "1" })).not.toThrow();
		expect(() => assertSubmissionValid(CARD, { count: 1 })).not.toThrow();
		expect(() => assertSubmissionValid(CARD, { count: 100 })).not.toThrow();
	});

	it("数字越界 / 非数字 / 缺必填 抛中文错误", () => {
		expect(() => assertSubmissionValid(CARD, { count: 0 })).toThrow(/不能小于 1/);
		expect(() => assertSubmissionValid(CARD, { count: 101 })).toThrow(/不能大于 100/);
		expect(() => assertSubmissionValid(CARD, { count: "abc" })).toThrow(/需要填数字/);
		expect(() => assertSubmissionValid(CARD, {})).toThrow(/请填写/);
	});

	it("错误话术合并多条问题", () => {
		expect(() => assertSubmissionValid(CARD, { count: 999 })).toThrow(/提交内容有误/);
	});
});

const TENANT: TenantContext = { tenantId: "t", workspaceId: "w", userId: "u" };
const servers: Server[] = [];
const hubs: SseHub[] = [];
afterEach(async () => {
	for (const h of hubs.splice(0)) h.closeAll();
	for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

describe("POST /api/tasks 数字越界", () => {
	async function serve(): Promise<{ port: number; created: number }> {
		const hub = new SseHub();
		hubs.push(hub);
		const state = { created: 0 };
		const member: Principal = { tenant: TENANT, role: Role.Member };
		const deps: AppDeps = {
			authenticate: async () => member,
			hub,
			taskEvents: () => [],
			listTasks: () => [],
			getTask: () => undefined,
			// 复刻 main.ts 的服务端校验：越界即抛，绝不创建任务
			submitTask: async (_tenant, input) => {
				assertSubmissionValid(CARD, input.fields);
				state.created += 1;
				return { taskId: `t-${state.created}` };
			},
			steerTask: async () => {},
			cancelTask: async () => {},
		};
		const app = createApp(deps);
		const server = createServer((req, res) => void app(req, res));
		servers.push(server);
		await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
		const a = server.address();
		return { port: typeof a === "object" && a ? a.port : 0, get created() { return state.created; } };
	}

	async function post(port: number, body: unknown) {
		const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
			body: JSON.stringify(body),
		});
		const text = await res.text();
		let json: Record<string, unknown> = {};
		try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
		return { status: res.status, json };
	}

	it("越界数字回 400 且不创建任务；合法值 202 并创建", async () => {
		const { port } = await serve();
		const bad = await post(port, { scenarioId: "test.number", fields: { count: 101 } });
		expect(bad.status).toBe(400);
		expect(String(bad.json.error)).toMatch(/数量|100/);

		const badLow = await post(port, { scenarioId: "test.number", fields: { count: 0 } });
		expect(badLow.status).toBe(400);

		const ok = await post(port, { scenarioId: "test.number", fields: { count: 50 } });
		expect(ok.status).toBe(202);
		expect(ok.json.taskId).toBe("t-1"); // 前两次被拒，这是第一个真正创建的任务
	});
});
