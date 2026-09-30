/**
 * Spike 1 · 并发隔离
 *
 * 验证问题：同一个 Node 进程内并发运行两个会话，会不会串台？
 *
 * 为什么必须验证：产品的核心卖点之一是「任务执行中可继续对话」，SaaS 形态下
 * 一个进程要承载多个用户的多个会话。一旦串台，就是跨租户数据泄漏 —— 这是
 * 商业上最不可接受的缺陷，必须在 M1 动工前用代码确认，而非依赖文档假设。
 *
 * 审计结论（vendor/pi/agent/src 全量扫描）：消息历史全部挂在实例上，
 * 进程级可变全局只有一处 —— src/stream-fn.ts:3 的 defaultStreamFn。
 * 本 spike 既要证明「正确用法下隔离成立」，也要证明「那处全局确实是陷阱」，
 * 后者决定了我们的适配层必须显式传 streamFn。
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type StreamFn, setDefaultStreamFn } from "@earendil-works/pi-agent-core";

class MockStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(e) => e.type === "done" || e.type === "error",
			(e) => {
				if (e.type === "done") return e.message;
				if (e.type === "error") return e.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const textOf = (m: { content: unknown }): string => {
	const c = m.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
			.map((b) => b.text)
			.join("");
	}
	return "";
};

/**
 * 建一个带标签的 mock 模型。
 *
 * delayMs > 0 时引入真实的异步交错：A 慢、B 快，B 会在 A 还在流式输出时完成。
 * 若存在共享状态，这种交错最容易把它暴露出来。
 *
 * 每次被调用时记录「模型看到的完整上下文」—— 这是检测串台最直接的抓手：
 * 只要 A 的模型看到了 B 的任何文本，隔离就是破的。
 */
function taggedModel(tag: string, delayMs = 0) {
	const seenContexts: string[][] = [];
	let callCount = 0;

	const streamFn: StreamFn = (_model, context) => {
		callCount++;
		seenContexts.push(context.messages.map(textOf));
		const stream = new MockStream();
		const emit = () => stream.push({ type: "done", reason: "stop", message: assistantMessage(`${tag}-reply`) });
		if (delayMs > 0) setTimeout(emit, delayMs);
		else queueMicrotask(emit);
		return stream;
	};

	return { streamFn, seenContexts, get callCount() { return callCount; } };
}

describe("Spike 1 · 并发隔离", () => {
	afterEach(() => {
		// 复位那处进程级全局，避免污染后续用例
		setDefaultStreamFn(undefined);
	});

	it("两个 Agent 实例并发执行：消息历史互不串台", async () => {
		// A 慢 B 快，强制产生时间交错
		const a = taggedModel("A", 50);
		const b = taggedModel("B", 5);

		const agentA = new Agent({ streamFn: a.streamFn });
		const agentB = new Agent({ streamFn: b.streamFn });

		await Promise.all([agentA.prompt("question-from-A"), agentB.prompt("question-from-B")]);

		const historyA = agentA.state.messages.map(textOf).join("|");
		const historyB = agentB.state.messages.map(textOf).join("|");

		// A 的历史只含 A 的内容
		expect(historyA).toContain("question-from-A");
		expect(historyA).toContain("A-reply");
		expect(historyA).not.toContain("question-from-B");
		expect(historyA).not.toContain("B-reply");

		// B 的历史只含 B 的内容
		expect(historyB).toContain("question-from-B");
		expect(historyB).toContain("B-reply");
		expect(historyB).not.toContain("question-from-A");
		expect(historyB).not.toContain("A-reply");
	});

	it("模型侧看到的上下文也不串台（发给模型的 transcript 是隔离的）", async () => {
		const a = taggedModel("A", 40);
		const b = taggedModel("B", 5);

		const agentA = new Agent({ streamFn: a.streamFn });
		const agentB = new Agent({ streamFn: b.streamFn });

		await Promise.all([agentA.prompt("secret-of-A"), agentB.prompt("secret-of-B")]);

		// 这是最关键的断言：模型请求里若混入对方内容，等于跨租户泄漏
		expect(a.seenContexts.flat().join("|")).not.toContain("secret-of-B");
		expect(b.seenContexts.flat().join("|")).not.toContain("secret-of-A");

		// 各自的模型都只被调用了自己那一次
		expect(a.callCount).toBe(1);
		expect(b.callCount).toBe(1);
	});

	it("事件流按订阅者隔离，且事件对象不共享引用", async () => {
		const a = taggedModel("A", 30);
		const b = taggedModel("B", 5);

		const agentA = new Agent({ streamFn: a.streamFn });
		const agentB = new Agent({ streamFn: b.streamFn });

		const eventsA: AgentEvent[] = [];
		const eventsB: AgentEvent[] = [];
		agentA.subscribe((e) => void eventsA.push(e));
		agentB.subscribe((e) => void eventsB.push(e));

		await Promise.all([agentA.prompt("evt-A"), agentB.prompt("evt-B")]);

		// 两边都拿到完整的一轮
		for (const events of [eventsA, eventsB]) {
			expect(events.some((e) => e.type === "agent_start")).toBe(true);
			expect(events.some((e) => e.type === "agent_end")).toBe(true);
		}

		// 事件承载的消息内容不交叉
		const payload = (events: AgentEvent[]) =>
			events
				.map((e) => ("message" in e && e.message ? textOf(e.message as { content: unknown }) : ""))
				.join("|");

		expect(payload(eventsA)).not.toContain("B-reply");
		expect(payload(eventsB)).not.toContain("A-reply");

		// 事件对象之间无共享引用（同一个对象出现在两条流里即为泄漏）
		const overlap = eventsA.filter((e) => eventsB.includes(e));
		expect(overlap).toEqual([]);
	});

	it("三个以上会话并发同样隔离（排除「只在两个时凑巧正确」）", async () => {
		const N = 6;
		const models = Array.from({ length: N }, (_, i) =>
			// 交错的延迟，让完成顺序与启动顺序不同
			taggedModel(`S${i}`, (N - i) * 7),
		);
		const agents = models.map((m) => new Agent({ streamFn: m.streamFn }));

		await Promise.all(agents.map((ag, i) => ag.prompt(`ask-${i}`)));

		agents.forEach((ag, i) => {
			const history = ag.state.messages.map(textOf).join("|");
			expect(history).toContain(`ask-${i}`);
			expect(history).toContain(`S${i}-reply`);
			// 不含任何其他会话的内容
			for (let j = 0; j < N; j++) {
				if (j === i) continue;
				expect(history).not.toContain(`ask-${j}`);
				expect(history).not.toContain(`S${j}-reply`);
			}
		});
	});

	it("反向验证：断言真的能失败（共用一个 Agent 实例时历史必然混合）", async () => {
		// 如果上面的断言在任何情况下都通过，它们就只是装饰。
		// 这里故意用「一个实例跑两轮」构造出混合历史，证明检测逻辑有效。
		const m = taggedModel("X");
		const agent = new Agent({ streamFn: m.streamFn });

		await agent.prompt("first-turn");
		await agent.prompt("second-turn");

		const history = agent.state.messages.map(textOf).join("|");
		// 同一实例内两轮内容共存 —— 这正是「串台」在跨会话时的表现形态
		expect(history).toContain("first-turn");
		expect(history).toContain("second-turn");
		expect(m.callCount).toBe(2);
	});

	it("已知陷阱：省略 streamFn 会落到进程级全局 defaultStreamFn（共享）", async () => {
		// src/stream-fn.ts:3 是全包唯一的可变进程级状态。
		// 它只在构造时省略 streamFn 才生效，但一旦生效，多个会话就共用同一个模型入口。
		// 我们的适配层必须始终显式传 streamFn —— 本用例把这条约束钉成可执行的证据。
		const shared = taggedModel("SHARED");
		setDefaultStreamFn(shared.streamFn);

		const agent1 = new Agent({});
		const agent2 = new Agent({});

		await Promise.all([agent1.prompt("via-global-1"), agent2.prompt("via-global-2")]);

		// 两个会话都走了同一个 streamFn：调用次数累加在同一个计数器上
		expect(shared.callCount).toBe(2);

		// 各自的消息历史仍然隔离（历史挂实例），但模型入口是共享的
		expect(agent1.state.messages.map(textOf).join("|")).not.toContain("via-global-2");
		expect(agent2.state.messages.map(textOf).join("|")).not.toContain("via-global-1");

		// 该全局可被任意代码覆盖，且缺省时构造就失败 —— 这是它成为陷阱的原因。
		// 注意：解析发生在构造期（agent.ts:234），不是 prompt 期，
		// 所以「忘记配全局」是启动即崩，而非运行到一半才崩。
		setDefaultStreamFn(undefined);
		expect(() => new Agent({})).toThrow(/No default stream function/);
	});
});
