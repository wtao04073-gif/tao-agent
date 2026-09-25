/**
 * 落盘计量存储测试
 *
 * 断言重点在**崩溃与损坏场景**上。正常路径的汇总逻辑与
 * `MemoryMeteringStore` 共享同一套语义，已在 memory 的测试里覆盖；
 * 这个文件测的是落盘特有的风险：
 *
 *  - 重启后数据还在（否则看板是假的）
 *  - 半写行不会让整个文件读不出来（那会让用量显示为 0）
 *  - 分片边界不会漏记或重复计
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileMeteringStore, shardName, shardsInWindow } from "../src/index.ts";
import type { UsageRecord } from "@tao/core";

const dirs: string[] = [];
const stores: FileMeteringStore[] = [];

afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workdir(): string {
	const dir = mkdtempSync(join(tmpdir(), "file-metering-"));
	dirs.push(dir);
	return dir;
}

function store(dir: string, options: { now?: () => number; onCorruptLine?: (i: { shard: string; skipped: number }) => void } = {}): FileMeteringStore {
	const s = new FileMeteringStore({
		dir,
		// 测试里每次都刷，确保读到的就是写进去的
		fsyncIntervalMs: 0,
		...options,
	});
	stores.push(s);
	return s;
}

const SEP = Date.UTC(2026, 8, 15); // 2026-09-15
const OCT = Date.UTC(2026, 9, 3); // 2026-10-03

function usage(patch: Partial<UsageRecord> = {}): UsageRecord {
	return {
		tenantId: "univ-008",
		workspaceId: "office",
		taskId: "t-1",
		model: "deepseek-chat",
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 5,
		cacheWriteTokens: 1,
		at: SEP,
		...patch,
	};
}

const WINDOW = { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 9, 1) };

describe("分片命名", () => {
	it("按 UTC 年月命名", () => {
		expect(shardName(SEP)).toBe("usage-2026-09.jsonl");
		expect(shardName(OCT)).toBe("usage-2026-10.jsonl");
	});

	it("月份补零，便于文件名排序", () => {
		// 不补零的话 usage-2026-10 会排在 usage-2026-9 前面
		expect(shardName(Date.UTC(2026, 0, 1))).toBe("usage-2026-01.jsonl");
	});

	it("用 UTC 而非本地时间 —— 否则改时区后历史数据会错位", () => {
		// UTC 9/30 23:59 在东八区已是 10/1
		expect(shardName(Date.UTC(2026, 8, 30, 23, 59))).toBe("usage-2026-09.jsonl");
		expect(shardName(Date.UTC(2026, 9, 1, 0, 0))).toBe("usage-2026-10.jsonl");
	});

	it("跨年边界正确", () => {
		expect(shardName(Date.UTC(2026, 11, 31, 23, 59))).toBe("usage-2026-12.jsonl");
		expect(shardName(Date.UTC(2027, 0, 1))).toBe("usage-2027-01.jsonl");
	});
});

describe("时间窗覆盖的分片", () => {
	it("单月窗口只涉及一个分片", () => {
		expect(shardsInWindow(Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 30))).toEqual([
			"usage-2026-09.jsonl",
		]);
	});

	it("跨月窗口涉及全部经过的月份", () => {
		expect(shardsInWindow(Date.UTC(2026, 8, 15), Date.UTC(2026, 10, 5))).toEqual([
			"usage-2026-09.jsonl",
			"usage-2026-10.jsonl",
			"usage-2026-11.jsonl",
		]);
	});

	it("跨年窗口不漏月", () => {
		const shards = shardsInWindow(Date.UTC(2026, 10, 1), Date.UTC(2027, 1, 1));
		expect(shards).toContain("usage-2026-12.jsonl");
		expect(shards).toContain("usage-2027-01.jsonl");
		expect(shards).toContain("usage-2027-02.jsonl");
	});

	it("窗口末尾所在的月份也被覆盖 —— 漏掉会少算当月用量", () => {
		// 这是个容易写错的边界：while (cursor < to) 会漏掉 to 所在的月份
		const shards = shardsInWindow(Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1));
		expect(shards).toContain("usage-2026-10.jsonl");
	});
});

describe("落盘与重启", () => {
	it("写入后能读出来", async () => {
		const dir = workdir();
		const s = store(dir);
		await s.record(usage({ inputTokens: 100 }));

		const totals = await s.totals("univ-008", WINDOW);
		// 100 + 20 + 5 + 1
		expect(totals.totalTokens).toBe(126);
	});

	it("重启后数据还在 —— 这是落盘的全部意义", async () => {
		// 内存实现在这里会归零，而归零意味着配额失效、看板显示 0
		const dir = workdir();
		const first = store(dir);
		await first.record(usage({ inputTokens: 500 }));
		first.close();

		// 模拟进程重启：新建一个 store 指向同一目录
		const second = store(dir);
		const totals = await second.totals("univ-008", WINDOW);
		expect(totals.totalTokens).toBe(526);
		expect(totals.taskCount).toBe(1);
	});

	it("重启后继续追加不覆盖旧数据", async () => {
		const dir = workdir();
		const first = store(dir);
		await first.record(usage({ taskId: "旧任务", inputTokens: 100 }));
		first.close();

		const second = store(dir);
		await second.record(usage({ taskId: "新任务", inputTokens: 200 }));

		const records = await second.list("univ-008", WINDOW);
		expect(records).toHaveLength(2);
		expect(records.map((r) => r.taskId).sort()).toEqual(["新任务", "旧任务"]);
	});

	it("按月分片写到不同文件", async () => {
		const dir = workdir();
		const s = store(dir);
		await s.record(usage({ at: SEP }));
		await s.record(usage({ at: OCT }));

		expect(existsSync(join(dir, "usage-2026-09.jsonl"))).toBe(true);
		expect(existsSync(join(dir, "usage-2026-10.jsonl"))).toBe(true);
		expect(s.shards()).toEqual(["usage-2026-09.jsonl", "usage-2026-10.jsonl"]);
	});

	it("查当月只读当月分片", async () => {
		// 跑一年后若每次都扫全量，查配额要读几百 MB
		const dir = workdir();
		const s = store(dir);
		await s.record(usage({ at: SEP, inputTokens: 100 }));
		await s.record(usage({ at: OCT, inputTokens: 999 }));

		// 只查 9 月
		const totals = await s.totals("univ-008", WINDOW);
		expect(totals.inputTokens).toBe(100);
	});
});

describe("损坏容错", () => {
	it("半写的最后一行被跳过，前面的记录仍全部读出", async () => {
		/**
		 * 这是最重要的一条。断电可能留下不完整的最后一行，
		 * 若整体解析失败等于**全部历史都读不出来** ——
		 * 用户会看到「用量为 0」而实际已经用了很多，配额随之失效。
		 */
		const dir = workdir();
		const s = store(dir);
		for (let i = 0; i < 5; i += 1) await s.record(usage({ taskId: `t-${i}`, inputTokens: 100 }));
		s.close();

		// 模拟断电：追加一个半写的行
		appendFileSync(join(dir, "usage-2026-09.jsonl"), '{"tenantId":"univ-008","inputTok');

		const reopened = store(dir);
		const totals = await reopened.totals("univ-008", WINDOW);
		// 5 条完好记录都在
		expect(totals.taskCount).toBe(5);
		expect(totals.inputTokens).toBe(500);
	});

	it("发现坏行时告警，不静默", async () => {
		// 坏行意味着有用量没被算进去，运维需要知道
		const dir = workdir();
		writeFileSync(
			join(dir, "usage-2026-09.jsonl"),
			`${JSON.stringify(usage())}\n这不是 JSON\n`,
		);

		const corrupt: Array<{ shard: string; skipped: number }> = [];
		const s = store(dir, { onCorruptLine: (i) => void corrupt.push(i) });
		await s.totals("univ-008", WINDOW);

		expect(corrupt).toHaveLength(1);
		expect(corrupt[0]?.shard).toBe("usage-2026-09.jsonl");
		expect(corrupt[0]?.skipped).toBe(1);
	});

	it("但坏行不抛异常 —— 否则一行坏掉会让看板打不开", async () => {
		const dir = workdir();
		writeFileSync(join(dir, "usage-2026-09.jsonl"), "全是垃圾\n还是垃圾\n");
		const s = store(dir);
		await expect(s.totals("univ-008", WINDOW)).resolves.toMatchObject({ totalTokens: 0 });
	});

	it("缺字段的记录被跳过，不让汇总出现 NaN", async () => {
		// 一个 NaN 会污染整个汇总，且 NaN 参与配额比较永远为 false → 永不熔断
		const dir = workdir();
		writeFileSync(
			join(dir, "usage-2026-09.jsonl"),
			`${JSON.stringify({ tenantId: "univ-008", at: SEP })}\n${JSON.stringify(usage())}\n`,
		);

		const s = store(dir);
		const totals = await s.totals("univ-008", WINDOW);
		expect(Number.isNaN(totals.totalTokens)).toBe(false);
		expect(totals.totalTokens).toBe(126);
	});

	it("含换行的字段不破坏行分隔", async () => {
		// JSON.stringify 会转义真实换行。自己拼字符串的实现会在这里劈成两行
		const dir = workdir();
		const s = store(dir);
		await s.record(usage({ taskId: "第一行\n第二行" }));

		const text = readFileSync(join(dir, "usage-2026-09.jsonl"), "utf8");
		expect(text.split("\n").filter((l) => l.trim() !== "")).toHaveLength(1);

		const records = await s.list("univ-008", WINDOW);
		expect(records[0]?.taskId).toBe("第一行\n第二行");
	});

	it("分片文件不存在时返回空而非报错", async () => {
		const dir = workdir();
		const s = store(dir);
		await expect(s.totals("univ-008", WINDOW)).resolves.toMatchObject({
			totalTokens: 0,
			taskCount: 0,
		});
	});
});

describe("租户隔离与时间窗", () => {
	it("别家租户的记录查不到", async () => {
		const dir = workdir();
		const s = store(dir);
		await s.record(usage({ tenantId: "other-univ", inputTokens: 9999 }));
		await s.record(usage({ tenantId: "univ-008", inputTokens: 100 }));

		const totals = await s.totals("univ-008", WINDOW);
		expect(totals.inputTokens).toBe(100);
	});

	it("时间窗左闭右开 —— 右端闭合会让边界那刻双重计费", async () => {
		const dir = workdir();
		const s = store(dir);
		await s.record(usage({ at: WINDOW.from, inputTokens: 10 }));
		await s.record(usage({ at: WINDOW.to, inputTokens: 999 }));

		const totals = await s.totals("univ-008", WINDOW);
		// from 计入，to 不计入
		expect(totals.inputTokens).toBe(10);
	});

	it("窗口外的记录不计入，即使在同一分片里", async () => {
		const dir = workdir();
		const s = store(dir);
		await s.record(usage({ at: Date.UTC(2026, 8, 5), inputTokens: 10 }));
		await s.record(usage({ at: Date.UTC(2026, 8, 25), inputTokens: 20 }));

		// 只查 9 月上半月
		const totals = await s.totals("univ-008", {
			from: Date.UTC(2026, 8, 1),
			to: Date.UTC(2026, 8, 15),
		});
		expect(totals.inputTokens).toBe(10);
	});

	it("四类 token 全部计入 totalTokens", async () => {
		// 用互不相同的值，漏掉任一类都会让这个数不对
		const dir = workdir();
		const s = store(dir);
		await s.record(
			usage({ inputTokens: 1, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 1000 }),
		);
		expect((await s.totals("univ-008", WINDOW)).totalTokens).toBe(1111);
	});

	it("任务数按 taskId 去重", async () => {
		const dir = workdir();
		const s = store(dir);
		await s.record(usage({ taskId: "t-1" }));
		await s.record(usage({ taskId: "t-1" }));
		await s.record(usage({ taskId: "t-2" }));

		expect((await s.totals("univ-008", WINDOW)).taskCount).toBe(2);
	});
});

describe("并发与批量", () => {
	it("大量追加不丢记录", async () => {
		const dir = workdir();
		const s = store(dir);
		await Promise.all(
			Array.from({ length: 300 }, (_, i) =>
				s.record(usage({ taskId: `t-${i}`, inputTokens: 1 })),
			),
		);
		const totals = await s.totals("univ-008", WINDOW);
		expect(totals.taskCount).toBe(300);
		expect(totals.inputTokens).toBe(300);
	});

	it("跨分片并发写不串", async () => {
		const dir = workdir();
		const s = store(dir);
		await Promise.all([
			...Array.from({ length: 50 }, (_, i) => s.record(usage({ at: SEP, taskId: `s-${i}` }))),
			...Array.from({ length: 50 }, (_, i) => s.record(usage({ at: OCT, taskId: `o-${i}` }))),
		]);

		const sep = await s.list("univ-008", WINDOW);
		expect(sep).toHaveLength(50);
		expect(sep.every((r) => r.taskId.startsWith("s-"))).toBe(true);
	});
});
