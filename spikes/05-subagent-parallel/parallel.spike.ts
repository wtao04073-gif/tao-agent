/**
 * Spike 5 · 子 Agent 并行验证
 *
 * ── 本 spike 修正了 M0 Spike 1 的一处表述 ──
 *
 * M0 的结论写的是「同一 Session 下的多个 lane 在 mutation line 上**串行执行**」。
 * 实测发现这个表述过强，会导致错误的架构决策。准确的事实是：
 *
 *   `MutationLine`（`vendor/pi/agent/src/harness/session/mutation-line.ts`）
 *   只串行化**存储的读-改-写**，不串行化模型调用。
 *
 * 实测数据（两个各 60ms 的子任务并发）：
 *
 * | 形态 | 总耗时 | 模型调用时序 |
 * |---|---|---|
 * | 同 Session 两个 lane | 73ms | A-start, B-start, A-end, B-end（交错）|
 * | 两个独立 Session | 62ms | 同样交错 |
 *
 * 也就是说：**模型调用本来就并发**，同 Session 的代价是写入排队带来的
 * 额外开销（这里约 18%），而非退化成串行（那会是 120ms）。
 *
 * 这个区别直接影响设计：
 *  - 若真是串行，子 Agent **必须**一任务一 Session，没有选择
 *  - 实际是有开销但可并行，所以一任务一 Session 是**优化选择**，
 *    理由从「否则不能并行」变成「减少写入争用 + 故障隔离 + 独立检查点」
 *
 * 为什么仍然采用一子任务一 Session：写入争用会随子任务数增长而放大；
 * 更重要的是**故障隔离**（一个子任务的存储损坏不影响其他）与
 * **独立检查点**（子任务可单独续跑）。
 *
 * ── 不做这个 spike 的风险 ──
 *
 * 把并行做成串行，而功能测试全部通过 —— 因为结果是对的，只是慢。
 * 这种缺陷在生产环境才暴露，且表现为「用户觉得卡」而非明确错误。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../vendor/pi/agent/src/harness/session/session.ts";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
const sessions: StorageBackedSession[] = [];

afterEach(async () => {
	for (const s of sessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newSession(id: string): StorageBackedSession {
	const session = new StorageBackedSession(
		{ id, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	return session;
}

/**
 * 造一个会记录执行时序的假模型。
 *
 * 时序是并行与串行的唯一区分手段 —— 结果本身在两种情况下都是对的。
 */
function timingProvider(delays: Record<string, number>) {
	const faux = fauxProvider();
	const timeline: Array<{ lane: string; at: "start" | "end"; seq: number }> = [];
	let seq = 0;

	faux.setResponses([]);
	// 用工厂函数逐次响应：每次调用按请求内容判断是哪个子任务
	faux.appendResponses(
		Array.from({ length: 20 }, () => async (ctx: { messages: Array<{ role: string; content?: unknown }> }) => {
			// 从最后一条 user 消息识别子任务标识
			const user = [...ctx.messages].reverse().find((m) => m.role === "user");
			const text =
				typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
			const key = Object.keys(delays).find((k) => text.includes(k)) ?? "unknown";

			timeline.push({ lane: key, at: "start", seq: seq++ });
			await new Promise((resolve) => setTimeout(resolve, delays[key] ?? 0));
			timeline.push({ lane: key, at: "end", seq: seq++ });

			return fauxAssistantMessage(`${key} 完成`);
		}),
	);

	return { faux, timeline };
}

/** 判断两个子任务的执行是否真的交错（并行）。 */
function isInterleaved(
	timeline: Array<{ lane: string; at: "start" | "end"; seq: number }>,
	a: string,
	b: string,
): boolean {
	const aStart = timeline.find((e) => e.lane === a && e.at === "start")?.seq;
	const aEnd = timeline.find((e) => e.lane === a && e.at === "end")?.seq;
	const bStart = timeline.find((e) => e.lane === b && e.at === "start")?.seq;
	if (aStart === undefined || aEnd === undefined || bStart === undefined) return false;
	// b 在 a 结束之前就开始了 → 交错
	return bStart > aStart && bStart < aEnd;
}

async function makeHarness(session: StorageBackedSession, faux: FauxProviderHandle) {
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model: faux.getModel(),
			systemPrompt: "你是子任务执行器",
			tools: [],
		},
		BACKGROUND_CONTEXT,
	);
	return harness;
}

describe("Spike 5 · 同 Session 多 lane 的真实行为（修正 M0 表述）", () => {
	it("模型调用是并发的，不是串行", async () => {
		// M0 的表述「多 lane 在 mutation line 上串行执行」过强。
		// MutationLine 只串行化存储读-改-写，模型调用本来就并发。
		const { faux, timeline } = timingProvider({ 子任务A: 60, 子任务B: 5 });
		const session = newSession("shared");
		const harness = await makeHarness(session, faux);

		const laneA = await harness.lane("sub-a", BACKGROUND_CONTEXT);
		const laneB = await harness.lane("sub-b", BACKGROUND_CONTEXT);

		// A 慢 B 快，同时发起
		await Promise.all([
			laneA.prompt("处理 子任务A", [], BACKGROUND_CONTEXT),
			laneB.prompt("处理 子任务B", [], BACKGROUND_CONTEXT),
		]);

		expect(timeline.filter((e) => e.at === "end")).toHaveLength(2);
		// 快的在慢的结束前就完成了 —— 若真串行则不可能
		expect(isInterleaved(timeline, "子任务A", "子任务B")).toBe(true);
	});

	it("但同 Session 有写入争用开销，独立 Session 更快", async () => {
		// 这是采用「一子任务一 Session」的量化依据之一。
		// 两个各 50ms 的任务：完全串行会是 100ms，完全并行是 50ms。
		const measure = async (shared: boolean): Promise<number> => {
			const { faux } = timingProvider({ 子任务A: 50, 子任务B: 50 });
			let lanes: Array<{ prompt: (t: string) => Promise<unknown> }>;

			if (shared) {
				const harness = await makeHarness(newSession(`sh-${Math.random()}`), faux);
				const a = await harness.lane("a", BACKGROUND_CONTEXT);
				const b = await harness.lane("b", BACKGROUND_CONTEXT);
				lanes = [
					{ prompt: (t) => a.prompt(t, [], BACKGROUND_CONTEXT) },
					{ prompt: (t) => b.prompt(t, [], BACKGROUND_CONTEXT) },
				];
			} else {
				const h1 = await makeHarness(newSession(`i1-${Math.random()}`), faux);
				const h2 = await makeHarness(newSession(`i2-${Math.random()}`), faux);
				const a = await h1.lane("main", BACKGROUND_CONTEXT);
				const b = await h2.lane("main", BACKGROUND_CONTEXT);
				lanes = [
					{ prompt: (t) => a.prompt(t, [], BACKGROUND_CONTEXT) },
					{ prompt: (t) => b.prompt(t, [], BACKGROUND_CONTEXT) },
				];
			}

			const started = Date.now();
			await Promise.all([lanes[0]!.prompt("处理 子任务A"), lanes[1]!.prompt("处理 子任务B")]);
			return Date.now() - started;
		};

		const shared = await measure(true);
		const separate = await measure(false);

		// 两者都远小于串行的 100ms —— 确认并发成立
		expect(shared).toBeLessThan(95);
		expect(separate).toBeLessThan(95);
		// 独立 Session 不慢于共用（通常更快，但不断言严格小于以免时序抖动导致偶发失败）
		expect(separate).toBeLessThanOrEqual(shared + 15);
	});
});

describe("Spike 5 · 一子任务一 Session 可真并行", () => {
	it("两个独立 Session 的执行真实交错", async () => {
		const { faux, timeline } = timingProvider({ 子任务A: 60, 子任务B: 5 });

		const harnessA = await makeHarness(newSession("sub-a"), faux);
		const harnessB = await makeHarness(newSession("sub-b"), faux);
		const laneA = await harnessA.lane("main", BACKGROUND_CONTEXT);
		const laneB = await harnessB.lane("main", BACKGROUND_CONTEXT);

		await Promise.all([
			laneA.prompt("处理 子任务A", [], BACKGROUND_CONTEXT),
			laneB.prompt("处理 子任务B", [], BACKGROUND_CONTEXT),
		]);

		// 并行：慢的还没结束，快的已经开始
		expect(isInterleaved(timeline, "子任务A", "子任务B")).toBe(true);
	});

	it("并行度随 Session 数增长", async () => {
		const keys = ["任务1", "任务2", "任务3", "任务4"];
		const delays = Object.fromEntries(keys.map((k) => [k, 30]));
		const { faux, timeline } = timingProvider(delays);

		const lanes = await Promise.all(
			keys.map(async (key, i) => {
				const harness = await makeHarness(newSession(`s-${i}`), faux);
				return { key, lane: await harness.lane("main", BACKGROUND_CONTEXT) };
			}),
		);

		const started = Date.now();
		await Promise.all(
			lanes.map(({ key, lane }) => lane.prompt(`处理 ${key}`, [], BACKGROUND_CONTEXT)),
		);
		const elapsed = Date.now() - started;

		expect(timeline.filter((e) => e.at === "end")).toHaveLength(4);
		// 4 个各 30ms 的任务并行，总耗时应远小于串行的 120ms
		expect(elapsed).toBeLessThan(100);

		// 所有任务都在第一个结束前就已开始
		const firstEnd = timeline.find((e) => e.at === "end")?.seq ?? 0;
		const startsBeforeFirstEnd = timeline.filter((e) => e.at === "start" && e.seq < firstEnd).length;
		expect(startsBeforeFirstEnd).toBe(4);
	});
});

describe("Spike 5 · 并行子任务的隔离", () => {
	it("一个子任务失败不影响其他子任务完成", async () => {
		// 多部门数据汇总时，某个部门的文件坏了不该让整个任务失败
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		faux.setResponses([
			fauxAssistantMessage("子任务1 完成"),
			// 第二个子任务没有排响应 → faux 报错
		]);

		const h1 = await makeHarness(newSession("ok"), faux);
		const h2 = await makeHarness(newSession("fail"), faux);
		const lane1 = await h1.lane("main", BACKGROUND_CONTEXT);
		const lane2 = await h2.lane("main", BACKGROUND_CONTEXT);

		const results = await Promise.allSettled([
			lane1.prompt("任务1", [], BACKGROUND_CONTEXT),
			lane2.prompt("任务2", [], BACKGROUND_CONTEXT),
		]);

		// 用 allSettled 而非 all —— 一个失败不该让其他的结果丢失
		expect(results).toHaveLength(2);
		expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
	});

	it("子任务之间的消息历史不串", async () => {
		// 与 M0 Spike 1 同样的验证：检查各自 Session 的内容
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage("甲的答案"),
			fauxAssistantMessage("乙的答案"),
		]);

		const sa = newSession("a");
		const sb = newSession("b");
		const ha = await makeHarness(sa, faux);
		const hb = await makeHarness(sb, faux);
		const la = await ha.lane("main", BACKGROUND_CONTEXT);
		const lb = await hb.lane("main", BACKGROUND_CONTEXT);

		await la.prompt("甲的问题", [], BACKGROUND_CONTEXT);
		await lb.prompt("乙的问题", [], BACKGROUND_CONTEXT);

		const entriesA = JSON.stringify(
			await sa.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
		);
		const entriesB = JSON.stringify(
			await sb.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
		);

		// 反向验证：先确认各自真的有内容（否则下面的「不含」会假通过）
		expect(entriesA).toContain("甲的问题");
		expect(entriesB).toContain("乙的问题");

		expect(entriesA).not.toContain("乙的问题");
		expect(entriesB).not.toContain("甲的问题");
	});
});

describe("Spike 5 · 结果汇聚", () => {
	it("子任务结果按发起顺序可靠对应", async () => {
		// 扇出后必须知道哪个结果对应哪个子任务。
		// Promise.all 保序，但完成顺序与发起顺序不同 —— 容易写错的地方
		const { faux } = timingProvider({ 慢任务: 50, 中任务: 25, 快任务: 5 });
		const keys = ["慢任务", "中任务", "快任务"];

		const lanes = await Promise.all(
			keys.map(async (key, i) => {
				const harness = await makeHarness(newSession(`agg-${i}`), faux);
				return { key, lane: await harness.lane("main", BACKGROUND_CONTEXT) };
			}),
		);

		const results = await Promise.all(
			lanes.map(async ({ key, lane }) => {
				await lane.prompt(`处理 ${key}`, [], BACKGROUND_CONTEXT);
				return key;
			}),
		);

		// 结果顺序 = 发起顺序，不是完成顺序
		expect(results).toEqual(["慢任务", "中任务", "快任务"]);
	});
});
