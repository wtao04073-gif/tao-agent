/**
 * 计量存储测试
 *
 * 这个文件的存在源于一次**变异逃逸**：把 `totalTokens` 从
 * 「input + output + cacheRead + cacheWrite」改成「input + output」后，
 * 全部 43 项计量测试依然通过 —— 因为当时只测了 `checkQuota` 这类纯函数，
 * 存储的汇总逻辑没有任何断言。
 *
 * 漏计 cacheRead 的后果是配额判定系统性偏松：长对话场景下 cacheRead
 * 可能是输入量的数倍，用户实际用掉的算力远超账面。这类缺陷不会让任何
 * 功能出错，只会让平台方少收钱 —— 没有测试就永远发现不了。
 */

import { describe, expect, it } from "vitest";
import { MemoryMeteringStore } from "../src/memory-metering-store.ts";
import type { UsageRecord } from "@tao/core";

const NOW = 1_700_000_000_000;
const WINDOW = { from: NOW - 1000, to: NOW + 1000 };

function usage(patch: Partial<UsageRecord> = {}): UsageRecord {
	return {
		tenantId: "univ-006",
		workspaceId: "research",
		taskId: "t-1",
		model: "deepseek-chat",
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		at: NOW,
		...patch,
	};
}

describe("计量存储 · 汇总", () => {
	it("四类 token 全部计入 totalTokens", async () => {
		// 这条断言是变异测试逃逸后补的。用固定期望值而非「大于零」——
		// 后者在漏掉任一类别时依然通过
		const store = new MemoryMeteringStore();
		await store.record(
			usage({ inputTokens: 1, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 1000 }),
		);

		const totals = await store.totals("univ-006", WINDOW);
		expect(totals.inputTokens).toBe(1);
		expect(totals.outputTokens).toBe(10);
		expect(totals.cacheReadTokens).toBe(100);
		expect(totals.cacheWriteTokens).toBe(1000);
		// 1 + 10 + 100 + 1000 —— 漏掉任一类别这个数都不对
		expect(totals.totalTokens).toBe(1111);
	});

	it("缓存读单独计入 —— 便宜不等于免费", async () => {
		// 单独一条断言守住最容易被漏掉的那一类
		const store = new MemoryMeteringStore();
		await store.record(usage({ cacheReadTokens: 500 }));
		expect((await store.totals("univ-006", WINDOW)).totalTokens).toBe(500);
	});

	it("缓存写单独计入", async () => {
		const store = new MemoryMeteringStore();
		await store.record(usage({ cacheWriteTokens: 500 }));
		expect((await store.totals("univ-006", WINDOW)).totalTokens).toBe(500);
	});

	it("多条记录累加", async () => {
		const store = new MemoryMeteringStore();
		for (let i = 0; i < 5; i += 1) await store.record(usage({ inputTokens: 100 }));
		expect((await store.totals("univ-006", WINDOW)).totalTokens).toBe(500);
	});

	it("任务数按 taskId 去重 —— 一个任务多轮调用算一个任务", async () => {
		const store = new MemoryMeteringStore();
		await store.record(usage({ taskId: "t-1", inputTokens: 1 }));
		await store.record(usage({ taskId: "t-1", inputTokens: 1 }));
		await store.record(usage({ taskId: "t-2", inputTokens: 1 }));

		const totals = await store.totals("univ-006", WINDOW);
		// 三条记录、两个任务
		expect(totals.taskCount).toBe(2);
		expect(totals.totalTokens).toBe(3);
	});

	it("无记录时汇总为全零而非抛错", async () => {
		const store = new MemoryMeteringStore();
		const totals = await store.totals("从未用过的租户", WINDOW);
		expect(totals.totalTokens).toBe(0);
		expect(totals.taskCount).toBe(0);
	});
});

describe("计量存储 · 追加语义", () => {
	it("record 是追加而非覆盖", async () => {
		// 若实现成读-改-写，并发任务同时记账会丢记录 —— 丢的是钱
		const store = new MemoryMeteringStore();
		await Promise.all(
			Array.from({ length: 50 }, (_, i) =>
				store.record(usage({ taskId: `t-${i}`, inputTokens: 10 })),
			),
		);
		const totals = await store.totals("univ-006", WINDOW);
		expect(totals.totalTokens).toBe(500);
		expect(totals.taskCount).toBe(50);
	});

	it("并发记账不丢记录", async () => {
		// 同一个任务的多轮调用并发落账
		const store = new MemoryMeteringStore();
		await Promise.all(
			Array.from({ length: 100 }, () => store.record(usage({ inputTokens: 1 }))),
		);
		expect((await store.list("univ-006", WINDOW)).length).toBe(100);
	});
});

describe("计量存储 · 时间窗", () => {
	it("窗口左端闭合", async () => {
		const store = new MemoryMeteringStore();
		await store.record(usage({ inputTokens: 100, at: WINDOW.from }));
		expect((await store.totals("univ-006", WINDOW)).totalTokens).toBe(100);
	});

	it("窗口右端开放 —— 否则边界那一刻会被两个周期双重计费", async () => {
		const store = new MemoryMeteringStore();
		await store.record(usage({ inputTokens: 100, at: WINDOW.to }));
		expect((await store.totals("univ-006", WINDOW)).totalTokens).toBe(0);
	});

	it("窗口外的记录不计入", async () => {
		const store = new MemoryMeteringStore();
		await store.record(usage({ inputTokens: 999, at: WINDOW.from - 1 }));
		await store.record(usage({ inputTokens: 999, at: WINDOW.to + 1 }));
		await store.record(usage({ inputTokens: 1, at: NOW }));
		expect((await store.totals("univ-006", WINDOW)).totalTokens).toBe(1);
	});
});

describe("计量存储 · 租户隔离", () => {
	it("别家租户的用量查不到", async () => {
		const store = new MemoryMeteringStore();
		await store.record(usage({ tenantId: "other", inputTokens: 999_999 }));
		expect((await store.totals("univ-006", WINDOW)).totalTokens).toBe(0);
		expect(await store.list("univ-006", WINDOW)).toEqual([]);
	});

	it("同租户不同工作区的用量都计入租户账面", async () => {
		// 配额是租户级的 —— 一个租户的多个工作区共享配额
		const store = new MemoryMeteringStore();
		await store.record(usage({ workspaceId: "ws-a", inputTokens: 100 }));
		await store.record(usage({ workspaceId: "ws-b", inputTokens: 100 }));
		expect((await store.totals("univ-006", WINDOW)).totalTokens).toBe(200);
	});

	it("清空某租户不影响其他租户", async () => {
		const store = new MemoryMeteringStore();
		await store.record(usage({ tenantId: "a", inputTokens: 10 }));
		await store.record(usage({ tenantId: "b", inputTokens: 20 }));
		await store.clear("a");
		expect((await store.totals("a", WINDOW)).totalTokens).toBe(0);
		expect((await store.totals("b", WINDOW)).totalTokens).toBe(20);
	});
});

describe("计量存储 · 明细", () => {
	it("明细保留模型名，供分模型对账", async () => {
		const store = new MemoryMeteringStore();
		await store.record(usage({ model: "deepseek-chat", inputTokens: 1 }));
		await store.record(usage({ model: "qwen-plus", inputTokens: 1 }));

		const models = (await store.list("univ-006", WINDOW)).map((r) => r.model);
		expect(models.sort()).toEqual(["deepseek-chat", "qwen-plus"]);
	});

	it("明细保留 taskId，便于定位是哪个任务烧的", async () => {
		const store = new MemoryMeteringStore();
		await store.record(usage({ taskId: "对账-0925", inputTokens: 1 }));
		expect((await store.list("univ-006", WINDOW))[0]?.taskId).toBe("对账-0925");
	});
});
