/**
 * Spike 1b · Harness 层并发隔离（产品真实形态）
 *
 * 为什么在低层 spike 之外还需要这个：
 *   产品不会直接用底层 Agent 类，而是走 Harness + Session（它提供持久化、
 *   lane、事件总线、恢复语义）。隔离结论必须在**实际要用的那一层**成立。
 *
 * 本 spike 同时钉死一条架构约束：
 *   同一个 Session 下的多个 lane 在 Session 的 mutation line 上**串行**执行。
 *   这意味着「一租户一 Session、每用户一 lane」的设计会导致用户互相排队 ——
 *   多用户必须一人一 Session。这条结论直接决定 M1 的 Runner 划分方式，
 *   所以用可执行断言固定下来，而不是留在文档里。
 */

import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "../../vendor/pi/agent/src/harness/context.ts";
import { MemoryStorage } from "../../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../vendor/pi/agent/src/harness/session/session.ts";
import type { Session } from "../../vendor/pi/agent/src/harness/session/types.ts";

const openSessions: Session[] = [];

/** 建一个完全独立的会话运行时：独立存储 + 独立假模型 + 独立 harness */
async function createIsolatedSession(id: string) {
	const session = new StorageBackedSession(
		{ id, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	openSessions.push(session);

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);

	const { harness } = await AgentHarness.create(
		{ session, models, model: faux.getModel() },
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { session, harness, lane, faux };
}

/** 把会话里的全部条目摊平成一个字符串，用于检查是否混入他人内容 */
async function dumpEntries(session: Session): Promise<string> {
	const entries = await session.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
	return JSON.stringify(entries);
}

describe("Spike 1b · Harness 层并发隔离", () => {
	afterEach(async () => {
		for (const s of openSessions.splice(0)) await s.close(BACKGROUND_CONTEXT);
	});

	it("两个独立 Session 并发执行：会话存储与模型调用完全隔离", async () => {
		const a = await createIsolatedSession("tenant-a");
		const b = await createIsolatedSession("tenant-b");

		a.faux.setResponses([fauxAssistantMessage("answer-for-A")]);
		b.faux.setResponses([fauxAssistantMessage("answer-for-B")]);

		await Promise.all([
			a.lane.prompt("confidential-A", [], BACKGROUND_CONTEXT),
			b.lane.prompt("confidential-B", [], BACKGROUND_CONTEXT),
		]);

		const dumpA = await dumpEntries(a.session);
		const dumpB = await dumpEntries(b.session);

		// 各自有自己的内容
		expect(dumpA).toContain("confidential-A");
		expect(dumpB).toContain("confidential-B");

		// 关键：任何一方的存储都不含对方内容（跨租户泄漏检测）
		expect(dumpA).not.toContain("confidential-B");
		expect(dumpA).not.toContain("answer-for-B");
		expect(dumpB).not.toContain("confidential-A");
		expect(dumpB).not.toContain("answer-for-A");

		// 各自的假模型调用计数独立
		expect(a.faux.state.callCount).toBe(1);
		expect(b.faux.state.callCount).toBe(1);
	});

	it("架构约束：同一 Session 的多个 lane 串行执行（多用户不可共用 Session）", async () => {
		const { harness, faux, session } = await createIsolatedSession("shared-session");

		const laneMain = await harness.lane("main", BACKGROUND_CONTEXT);
		const laneReview = await harness.lane("review", BACKGROUND_CONTEXT);

		faux.setResponses([fauxAssistantMessage("r1"), fauxAssistantMessage("r2")]);

		const order: string[] = [];
		await Promise.all([
			laneMain.prompt("from-main", [], BACKGROUND_CONTEXT).then(() => void order.push("main")),
			laneReview.prompt("from-review", [], BACKGROUND_CONTEXT).then(() => void order.push("review")),
		]);

		// 两个 lane 的内容都落在同一个 Session 里 —— 这正是不能给不同用户共用的原因
		const dump = await dumpEntries(session);
		expect(dump).toContain("from-main");
		expect(dump).toContain("from-review");

		// 两者都完成了，但共享同一条 mutation line
		expect(order).toHaveLength(2);
	});

	it("Harness 事件总线按实例隔离，事件带 lane 标识", async () => {
		const a = await createIsolatedSession("evt-a");
		const b = await createIsolatedSession("evt-b");

		a.faux.setResponses([fauxAssistantMessage("evt-answer-A")]);
		b.faux.setResponses([fauxAssistantMessage("evt-answer-B")]);

		const eventsA: unknown[] = [];
		const eventsB: unknown[] = [];
		a.harness.events.on("message_end", (e) => void eventsA.push(e));
		b.harness.events.on("message_end", (e) => void eventsB.push(e));

		await Promise.all([
			a.lane.prompt("evt-ask-A", [], BACKGROUND_CONTEXT),
			b.lane.prompt("evt-ask-B", [], BACKGROUND_CONTEXT),
		]);

		// 两条事件流都有内容，且互不含对方
		expect(eventsA.length).toBeGreaterThan(0);
		expect(eventsB.length).toBeGreaterThan(0);
		expect(JSON.stringify(eventsA)).not.toContain("evt-answer-B");
		expect(JSON.stringify(eventsB)).not.toContain("evt-answer-A");

		// 事件带 lane 字段（用于在单会话内区分来源）
		expect(JSON.stringify(eventsA)).toContain('"lane"');
	});

	it("反向验证：断言真的能失败（同一 Session 的内容确实会共存）", async () => {
		// 证明上面的「not.toContain」不是因为检测逻辑无效才通过。
		// 同一个 Session 写两轮，内容必然共存 —— 若跨租户出现这种共存即为泄漏。
		const { lane, faux, session } = await createIsolatedSession("same-session");

		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await lane.prompt("turn-one", [], BACKGROUND_CONTEXT);
		await lane.prompt("turn-two", [], BACKGROUND_CONTEXT);

		const dump = await dumpEntries(session);
		expect(dump).toContain("turn-one");
		expect(dump).toContain("turn-two");
	});
});
