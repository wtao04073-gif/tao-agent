/**
 * Spike 6 · 计量与熔断的可行落点
 *
 * M4-1 要做「用量计量 + 配额 + 超限熔断」。三个假设必须先验证，
 * 因为它们决定熔断能做成什么形态 —— 猜错会做出一个**看起来生效、
 * 实际不生效**的熔断，这比没有熔断更危险（会超卖）。
 *
 * ── 假设 1：`before_request` 能拦下模型调用吗 ──
 *
 * 读码显示 `before_request` 的 result 类型只有 `{streamOptions}`，
 * **没有 `block`**（对比 `before_tool` 有 `block`）。且 `hooks.ts` 的
 * `beforeRequest` 把 handler 异常 catch 后只 `reportError`、**不重抛**。
 *
 * 若如此，用 `before_request` 做熔断等于没做。必须实测确认。
 *
 * ── 假设 2：生成失败时 usage 还会上报吗 ──
 *
 * 计量的铁律是**不能漏计**：任务失败但 token 已经烧掉了，那笔钱还是
 * 要记到租户账上。否则用户可以靠「发起必然失败的任务」白嫖。
 *
 * ── 假设 3：中途熔断时，已产生的 usage 是否仍能被观测到 ──
 *
 * 熔断发生在第 N 轮，前 N-1 轮的消耗必须已经入账。若熔断把整个
 * 运行回滚成「没有 usage」，配额就永远追不上实际消耗。
 */

import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import { AgentHarness, type AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../vendor/pi/agent/src/harness/session/session.ts";
import { afterEach, describe, expect, it } from "vitest";

const sessions: StorageBackedSession[] = [];

afterEach(async () => {
	for (const s of sessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
});

function newSession(id: string): StorageBackedSession {
	const session = new StorageBackedSession(
		{ id, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	return session;
}

/** 一个什么都不做的工具，用来制造多轮对话。 */
const NOOP_TOOL: AgentHarnessTool<undefined> = {
	name: "noop",
	label: "空操作",
	description: "什么都不做",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	replay: "never",
	async execute() {
		return { content: [{ type: "text" as const, text: "ok" }] };
	},
} as AgentHarnessTool<undefined>;

async function makeHarness(
	id: string,
	faux: FauxProviderHandle,
	tools: AgentHarnessTool<undefined>[] = [],
) {
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create(
		{
			session: newSession(id),
			models,
			model: faux.getModel(),
			systemPrompt: "你是计量验证用的助手",
			tools,
		},
		BACKGROUND_CONTEXT,
	);
	return harness;
}

describe("Spike 6 · before_request 能否用于熔断", () => {
	it("before_request 抛异常**不会**阻止模型调用（fail-open）", async () => {
		// 这是本 spike 最重要的一条。若这条为 false，M4-1 的熔断点就选错了。
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("我被调用了")]);

		const harness = await makeHarness("fo", faux);
		let hookRan = false;

		harness.hooks.on("before_request", (() => {
			hookRan = true;
			throw new Error("配额超限，应当熔断");
		}) as never);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await lane.prompt("你好", [], BACKGROUND_CONTEXT);

		expect(hookRan).toBe(true);

		// 模型仍然被调用了 —— 钩子异常被 hooks.ts 吞掉、只做 reportError
		const entries = JSON.stringify(
			await sessions[0]!.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
		);
		expect(entries).toContain("我被调用了");
	});

	it("before_request 的返回值里没有 block 这个通道", async () => {
		// 与 before_tool 的对比：后者返回 {block} 能真正拦下执行。
		// 类型层面就没有 block，所以「返回 block 试试」也不是出路。
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("依然被调用")]);

		const harness = await makeHarness("nb", faux);
		harness.hooks.on("before_request", (() => {
			// 故意返回一个 before_tool 风格的 block —— 内核会忽略
			return { block: { reason: "配额超限" } };
		}) as never);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await lane.prompt("你好", [], BACKGROUND_CONTEXT);

		const entries = JSON.stringify(
			await sessions[0]!.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
		);
		expect(entries).toContain("依然被调用");
	});

	it("对照：before_tool 抛异常**确实**能拦下工具（fail-closed）", async () => {
		// 反向对照，确认上面两条不是「钩子根本没接上」造成的假象。
		// 同一套接线方式下 before_tool 生效、before_request 不生效
		// —— 证明差异来自钩子语义而非测试写法。
		const faux = fauxProvider();
		let toolRan = false;
		const tool: AgentHarnessTool<undefined> = {
			...NOOP_TOOL,
			async execute() {
				toolRan = true;
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		} as AgentHarnessTool<undefined>;

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			fauxAssistantMessage("结束"),
		]);

		const harness = await makeHarness("bt", faux, [tool]);
		harness.hooks.on("before_tool", (() => {
			throw new Error("权限门拒绝");
		}) as never);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await lane.prompt("调用 noop", [], BACKGROUND_CONTEXT);

		// 工具零次执行 —— before_tool 是 fail-closed
		expect(toolRan).toBe(false);
	});
});

describe("Spike 6 · 熔断的可行落点", () => {
	it("before_tool 抛异常可用作「工具级」熔断闸", async () => {
		// 既然 before_request 不可用，熔断只能挂在 before_tool 上。
		// 代价：无法拦下「纯文本生成、不调工具」的消耗。这是真实的能力边界。
		const faux = fauxProvider();
		let toolCalls = 0;
		const tool: AgentHarnessTool<undefined> = {
			...NOOP_TOOL,
			async execute() {
				toolCalls += 1;
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		} as AgentHarnessTool<undefined>;

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			fauxAssistantMessage("结束"),
		]);

		const harness = await makeHarness("brk", faux, [tool]);
		let budget = 2;
		harness.hooks.on("before_tool", (() => {
			budget -= 1;
			if (budget < 0) throw new Error("配额已耗尽，任务终止");
			return undefined;
		}) as never);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await lane.prompt("反复调用 noop", [], BACKGROUND_CONTEXT);

		// 前两次放行，第三次被拦 —— 熔断闸生效
		expect(toolCalls).toBe(2);
	});

	it("`{block}` 比抛异常更可控：能给模型一条可读的拒绝理由", async () => {
		// 抛异常与返回 block 都能拦下执行，但 block 会把 reason 交给模型，
		// 模型能据此对用户解释。熔断应当用 block 而非抛异常。
		const faux = fauxProvider();
		const tool: AgentHarnessTool<undefined> = { ...NOOP_TOOL } as AgentHarnessTool<undefined>;

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			// 第二轮：模型看到拒绝理由后回复用户
			async (ctx: { messages: Array<{ role: string; content?: unknown }> }) => {
				const all = JSON.stringify(ctx.messages);
				return fauxAssistantMessage(
					all.includes("本月配额已用尽")
						? "本月配额已用尽，请联系管理员提额。"
						: "任务完成。",
				);
			},
		]);

		const harness = await makeHarness("blk", faux, [tool]);
		harness.hooks.on("before_tool", (() => {
			return { block: { reason: "本月配额已用尽，请联系管理员提额" } };
		}) as never);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await lane.prompt("调用 noop", [], BACKGROUND_CONTEXT);

		const entries = JSON.stringify(
			await sessions[0]!.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
		);
		// 模型确实收到了理由并转述给用户 —— 这才是用户能看懂的熔断
		expect(entries).toContain("本月配额已用尽，请联系管理员提额。");
	});

	it("block 时工具零次执行（与抛异常一致）", async () => {
		const faux = fauxProvider();
		let toolRan = false;
		const tool: AgentHarnessTool<undefined> = {
			...NOOP_TOOL,
			async execute() {
				toolRan = true;
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		} as AgentHarnessTool<undefined>;

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			fauxAssistantMessage("已知悉"),
		]);

		const harness = await makeHarness("blk2", faux, [tool]);
		harness.hooks.on("before_tool", (() => ({
			block: { reason: "配额超限" },
		})) as never);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await lane.prompt("调用 noop", [], BACKGROUND_CONTEXT);

		expect(toolRan).toBe(false);
	});
});

describe("Spike 6 · usage 上报的可靠性", () => {
	it("正常运行时 usage 事件带 input/output token 数", async () => {
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("回答")]);

		const harness = await makeHarness("u1", faux);
		const usages: Array<{ input?: number; output?: number }> = [];
		harness.events.on("usage", ((event: {
			row?: { usage?: { input?: number; output?: number } };
		}) => {
			if (event.row?.usage !== undefined) usages.push(event.row.usage);
		}) as never);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await lane.prompt("问题", [], BACKGROUND_CONTEXT);

		expect(usages.length).toBeGreaterThanOrEqual(1);
		// 计量要的就是这两个数
		expect(usages[0]?.input).toBeTypeOf("number");
		expect(usages[0]?.output).toBeTypeOf("number");
	});

	it("多轮工具调用的 usage 逐轮上报，可累加", async () => {
		// 配额是累加量。若内核只在运行结束时报一次总数，
		// 那么中途熔断就拿不到已消耗量 —— 必须确认是逐轮报的。
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			fauxAssistantMessage("结束"),
		]);

		const harness = await makeHarness("u2", faux, [NOOP_TOOL]);
		let reports = 0;
		harness.events.on("usage", ((event: { row?: { usage?: unknown } }) => {
			if (event.row?.usage !== undefined) reports += 1;
		}) as never);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await lane.prompt("反复调用", [], BACKGROUND_CONTEXT);

		// 三次模型调用 → 三次 usage 上报（而非最后汇总一次）
		expect(reports).toBe(3);
	});

	it("运行中途被熔断，前几轮的 usage 仍然已入账（不回滚）", async () => {
		// 这是「不能漏计」的核心：熔断发生在第 3 轮，前 2 轮烧掉的 token
		// 必须还在账上。若内核把整个运行回滚成零 usage，配额永远追不上消耗。
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			fauxAssistantMessage("结束"),
		]);

		const harness = await makeHarness("u3", faux, [NOOP_TOOL]);
		const usages: number[] = [];
		harness.events.on("usage", ((event: {
			row?: { usage?: { input?: number; output?: number } };
		}) => {
			const u = event.row?.usage;
			if (u !== undefined) usages.push((u.input ?? 0) + (u.output ?? 0));
		}) as never);

		let allowed = 2;
		harness.hooks.on("before_tool", (() => {
			allowed -= 1;
			if (allowed < 0) return { block: { reason: "配额耗尽" } };
			return undefined;
		}) as never);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await lane.prompt("反复调用", [], BACKGROUND_CONTEXT);

		// 熔断前的消耗都在账上
		expect(usages.length).toBeGreaterThanOrEqual(3);
		expect(usages.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
	});

	it("生成失败时，失败前的 usage 不丢", async () => {
		// 场景：任务跑了两轮后 provider 挂了。前两轮的钱已经花了。
		// 若失败就不计量，用户能靠「发起必然失败的任务」白嫖。
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			fauxAssistantMessage([fauxToolCall("noop", {})]),
			// 第三次没有响应 → provider 报错
		]);

		const harness = await makeHarness("u4", faux, [NOOP_TOOL]);
		const usages: number[] = [];
		harness.events.on("usage", ((event: {
			row?: { usage?: { input?: number; output?: number } };
		}) => {
			const u = event.row?.usage;
			if (u !== undefined) usages.push((u.input ?? 0) + (u.output ?? 0));
		}) as never);

		let failed = false;
		harness.events.on("run_end", ((event: { status: string }) => {
			if (event.status === "failed") failed = true;
		}) as never);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await lane.prompt("反复调用", [], BACKGROUND_CONTEXT).catch(() => {});

		// 确认真的失败了（否则下面的断言是空的）
		expect(failed).toBe(true);
		// 失败前两轮的消耗仍然被上报
		expect(usages.length).toBeGreaterThanOrEqual(2);
	});
});
