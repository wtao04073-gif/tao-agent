/**
 * 用量看板测试
 *
 * 断言重点在**数字的可信度与可追问性**上：
 *
 *  - 汇总数不能错（用固定期望值，不用「大于零」）
 *  - 下钻的各项加起来要等于总数（否则管理员会发现对不上）
 *  - 金额不完整时必须显式说明（否则管理员以为用得很省）
 *  - 截断时必须说明（否则以为只有这几项）
 */

import { describe, expect, it } from "vitest";
import {
	buildDashboard,
	dayKey,
	renderDashboard,
	MICRO_YUAN_PER_YUAN,
	type ModelPrice,
	type Quota,
	type UsageRecord,
} from "../src/index.ts";

const PRICES: ModelPrice[] = [
	{ model: "deepseek-chat", inputPerMillionYuan: 2, outputPerMillionYuan: 8 },
	{ model: "qwen-plus", inputPerMillionYuan: 0.8, outputPerMillionYuan: 2 },
];

const FROM = Date.UTC(2026, 8, 1);
const TO = Date.UTC(2026, 9, 1);
const PERIOD = { from: FROM, to: TO };

function usage(patch: Partial<UsageRecord> = {}): UsageRecord {
	return {
		tenantId: "univ-009",
		workspaceId: "office",
		taskId: "t-1",
		model: "deepseek-chat",
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		at: Date.UTC(2026, 8, 10),
		...patch,
	};
}

describe("日期分组键", () => {
	it("按 UTC 日期，格式为 YYYY-MM-DD", () => {
		expect(dayKey(Date.UTC(2026, 8, 5))).toBe("2026-09-05");
	});

	it("月与日都补零，便于字符串排序", () => {
		expect(dayKey(Date.UTC(2026, 0, 1))).toBe("2026-01-01");
	});

	it("用 UTC 而非本地时间 —— 否则不同时区的部署会分到不同天", () => {
		expect(dayKey(Date.UTC(2026, 8, 30, 23, 59))).toBe("2026-09-30");
		expect(dayKey(Date.UTC(2026, 9, 1, 0, 1))).toBe("2026-10-01");
	});
});

describe("汇总", () => {
	it("四类 token 全部计入总量", () => {
		// 用互不相同的值 —— 漏掉任一类这个数都不对
		const dashboard = buildDashboard({
			records: [
				usage({ inputTokens: 1, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 1000 }),
			],
			period: PERIOD,
			prices: PRICES,
		});
		expect(dashboard.totals.totalTokens).toBe(1111);
	});

	it("任务数按 taskId 去重", () => {
		const dashboard = buildDashboard({
			records: [
				usage({ taskId: "t-1", inputTokens: 1 }),
				usage({ taskId: "t-1", inputTokens: 1 }),
				usage({ taskId: "t-2", inputTokens: 1 }),
			],
			period: PERIOD,
			prices: PRICES,
		});
		expect(dashboard.totals.taskCount).toBe(2);
	});

	it("金额按固定期望值算对", () => {
		// 100 万输入 × 2 元/百万 = 2 元
		const dashboard = buildDashboard({
			records: [usage({ inputTokens: 1_000_000 })],
			period: PERIOD,
			prices: PRICES,
		});
		expect(dashboard.costMicroYuan).toBe(2 * MICRO_YUAN_PER_YUAN);
	});

	it("未配价的模型被列出 —— 金额不完整必须能被发现", () => {
		// 否则管理员看到偏低的金额会以为用得很省
		const dashboard = buildDashboard({
			records: [usage({ model: "未知模型", inputTokens: 1_000_000 })],
			period: PERIOD,
			prices: PRICES,
		});
		expect(dashboard.unpricedModels).toEqual(["未知模型"]);
	});

	it("空记录不崩，各项为零", () => {
		const dashboard = buildDashboard({ records: [], period: PERIOD, prices: PRICES });
		expect(dashboard.totals.totalTokens).toBe(0);
		expect(dashboard.byModel).toEqual([]);
		expect(dashboard.byDay).toEqual([]);
	});
});

describe("下钻", () => {
	it("按模型分组，各项之和等于总量", () => {
		// 对不上的话管理员会立刻发现数据有问题
		const records = [
			usage({ model: "deepseek-chat", inputTokens: 300 }),
			usage({ model: "qwen-plus", inputTokens: 700 }),
		];
		const dashboard = buildDashboard({ records, period: PERIOD, prices: PRICES });

		expect(dashboard.byModel).toHaveLength(2);
		const sum = dashboard.byModel.reduce((a, r) => a + r.totalTokens, 0);
		expect(sum).toBe(dashboard.totals.totalTokens);
	});

	it("按用量降序 —— 管理员先看用得最多的", () => {
		const records = [
			usage({ model: "qwen-plus", inputTokens: 100 }),
			usage({ model: "deepseek-chat", inputTokens: 900 }),
		];
		const dashboard = buildDashboard({ records, period: PERIOD, prices: PRICES });
		expect(dashboard.byModel[0]?.key).toBe("deepseek-chat");
	});

	it("占比之和为 1（允许浮点误差）", () => {
		const records = [
			usage({ model: "deepseek-chat", inputTokens: 333 }),
			usage({ model: "qwen-plus", inputTokens: 667 }),
		];
		const dashboard = buildDashboard({ records, period: PERIOD, prices: PRICES });
		const sum = dashboard.byModel.reduce((a, r) => a + r.share, 0);
		expect(sum).toBeCloseTo(1, 5);
	});

	it("总量为零时占比为 0 而非 NaN", () => {
		// NaN 会在界面上渲染成「NaN%」
		const dashboard = buildDashboard({
			records: [usage({ model: "deepseek-chat" })], // 全零 token
			period: PERIOD,
			prices: PRICES,
		});
		expect(dashboard.byModel[0]?.share).toBe(0);
		expect(Number.isNaN(dashboard.byModel[0]?.share ?? Number.NaN)).toBe(false);
	});

	it("按天分组能看出趋势", () => {
		const records = [
			usage({ at: Date.UTC(2026, 8, 5), inputTokens: 100 }),
			usage({ at: Date.UTC(2026, 8, 5), inputTokens: 100 }),
			usage({ at: Date.UTC(2026, 8, 20), inputTokens: 5000 }),
		];
		const dashboard = buildDashboard({ records, period: PERIOD, prices: PRICES });
		// 突增的那天排在最前
		expect(dashboard.byDay[0]?.key).toBe("2026-09-20");
		expect(dashboard.byDay[0]?.totalTokens).toBe(5000);
	});

	it("按工作区分组（不是按用户 —— 记录里没有 userId）", () => {
		const records = [
			usage({ workspaceId: "教务处", inputTokens: 100 }),
			usage({ workspaceId: "学生处", inputTokens: 200 }),
		];
		const dashboard = buildDashboard({ records, period: PERIOD, prices: PRICES });
		expect(dashboard.byUser.map((r) => r.key).sort()).toEqual(["学生处", "教务处"]);
	});

	it("提供显示名时用显示名，缺失时用 id", () => {
		const records = [usage({ workspaceId: "ws-01", inputTokens: 100 })];
		const dashboard = buildDashboard({
			records,
			period: PERIOD,
			prices: PRICES,
			userNames: new Map([["ws-01", "教务处"]]),
		});
		expect(dashboard.byUser[0]?.label).toBe("教务处");

		const without = buildDashboard({ records, period: PERIOD, prices: PRICES });
		expect(without.byUser[0]?.label).toBe("ws-01");
	});

	it("分组内先汇总再折算金额", () => {
		// 逐条折算会因取整而少计。1000 条 × 3000 token = 300 万 × 2元/百万 = 6 元
		const records = Array.from({ length: 1000 }, (_, i) =>
			usage({ taskId: `t-${i}`, inputTokens: 3000 }),
		);
		const dashboard = buildDashboard({ records, period: PERIOD, prices: PRICES });
		expect(dashboard.byModel[0]?.costMicroYuan).toBe(6 * MICRO_YUAN_PER_YUAN);
	});
});

describe("配额展示", () => {
	const quota: Quota = {
		tenantId: "univ-009",
		periodStart: FROM,
		periodEnd: TO,
		maxTokens: 1000,
		maxCostMicroYuan: 10 * MICRO_YUAN_PER_YUAN,
		maxTasks: 5,
	};

	it("三个维度都给出已用/上限与比例", () => {
		const dashboard = buildDashboard({
			records: [usage({ inputTokens: 500, taskId: "t-1" })],
			period: PERIOD,
			prices: PRICES,
			quota,
			verdict: { ok: true },
		});

		expect(dashboard.quota?.limits).toHaveLength(3);
		const tokens = dashboard.quota?.limits.find((l) => l.dimension === "tokens");
		expect(tokens?.used).toBe(500);
		expect(tokens?.limit).toBe(1000);
		expect(tokens?.ratio).toBe(0.5);
	});

	it("未配的维度不出现在列表里", () => {
		const dashboard = buildDashboard({
			records: [usage({ inputTokens: 100 })],
			period: PERIOD,
			prices: PRICES,
			quota: { tenantId: "univ-009", periodStart: FROM, periodEnd: TO, maxTokens: 1000 },
			verdict: { ok: true },
		});
		expect(dashboard.quota?.limits).toHaveLength(1);
	});

	it("超限时比例封顶在 1 —— 进度条不该溢出", () => {
		const dashboard = buildDashboard({
			records: [usage({ inputTokens: 99_999 })],
			period: PERIOD,
			prices: PRICES,
			quota,
			verdict: { ok: false, reason: "已达上限", exceeded: "tokens" },
		});
		const tokens = dashboard.quota?.limits.find((l) => l.dimension === "tokens");
		expect(tokens?.ratio).toBe(1);
	});

	it("上限为 0 时比例为 1 而非 NaN", () => {
		// 0 表示禁用。除以 0 会得到 Infinity 或 NaN
		const dashboard = buildDashboard({
			records: [],
			period: PERIOD,
			prices: PRICES,
			quota: { tenantId: "univ-009", periodStart: FROM, periodEnd: TO, maxTokens: 0 },
			verdict: { ok: false, reason: "已禁用", exceeded: "tokens" },
		});
		const tokens = dashboard.quota?.limits.find((l) => l.dimension === "tokens");
		expect(tokens?.ratio).toBe(1);
		expect(Number.isFinite(tokens?.ratio ?? Number.NaN)).toBe(true);
	});

	it("没给配额时 quota 字段为 undefined", () => {
		const dashboard = buildDashboard({ records: [], period: PERIOD, prices: PRICES });
		expect(dashboard.quota).toBeUndefined();
	});

	it("金额用元展示，不暴露微元", () => {
		const dashboard = buildDashboard({
			records: [usage({ inputTokens: 1_000_000 })],
			period: PERIOD,
			prices: PRICES,
			quota,
			verdict: { ok: true },
		});
		const cost = dashboard.quota?.limits.find((l) => l.dimension === "cost");
		expect(cost?.usedText).toBe("2.00 元");
		expect(cost?.limitText).toBe("10.00 元");
	});
});

describe("文本渲染", () => {
	it("含总量、任务数与费用", () => {
		const text = renderDashboard(
			buildDashboard({
				records: [usage({ inputTokens: 1_000_000, taskId: "t-1" })],
				period: PERIOD,
				prices: PRICES,
			}),
		);
		expect(text).toContain("总用量");
		expect(text).toContain("任务数");
		expect(text).toContain("2.00 元");
	});

	it("大数字带千分位 —— 管理员要能一眼看出量级", () => {
		const text = renderDashboard(
			buildDashboard({
				records: [usage({ inputTokens: 12_345_678 })],
				period: PERIOD,
				prices: PRICES,
			}),
		);
		expect(text).toContain("12,345,678");
	});

	it("未配价时显式警告费用不完整", () => {
		const text = renderDashboard(
			buildDashboard({
				records: [usage({ model: "未知模型", inputTokens: 1_000_000 })],
				period: PERIOD,
				prices: PRICES,
			}),
		);
		expect(text).toContain("费用不完整");
		expect(text).toContain("未知模型");
	});

	it("配额超限时用醒目标记", () => {
		const text = renderDashboard(
			buildDashboard({
				records: [usage({ inputTokens: 2000 })],
				period: PERIOD,
				prices: PRICES,
				quota: { tenantId: "univ-009", periodStart: FROM, periodEnd: TO, maxTokens: 1000 },
				verdict: { ok: false, reason: "已达本周期上限，请联系管理员提额", exceeded: "tokens" },
			}),
		);
		expect(text).toContain("✗");
		expect(text).toContain("联系管理员提额");
	});

	it("接近上限时给提醒", () => {
		const text = renderDashboard(
			buildDashboard({
				records: [usage({ inputTokens: 850 })],
				period: PERIOD,
				prices: PRICES,
				quota: { tenantId: "univ-009", periodStart: FROM, periodEnd: TO, maxTokens: 1000 },
				verdict: { ok: true, warning: "已用 850 / 1000 token" },
			}),
		);
		expect(text).toContain("!");
		expect(text).toContain("850");
	});

	it("列表被截断时明确说明 —— 否则以为只有这几项", () => {
		const records = Array.from({ length: 12 }, (_, i) =>
			usage({ model: `模型-${i}`, taskId: `t-${i}`, inputTokens: 100 * (12 - i) }),
		);
		const text = renderDashboard(buildDashboard({ records, period: PERIOD, prices: PRICES }));
		// 按模型只显示前 5 项，剩下 7 项要说明
		expect(text).toContain("另有 7 项未显示");
	});

	it("项数未超上限时不出现截断提示", () => {
		const records = [usage({ model: "deepseek-chat", inputTokens: 100 })];
		const text = renderDashboard(buildDashboard({ records, period: PERIOD, prices: PRICES }));
		expect(text).not.toContain("未显示");
	});

	it("空数据也能渲染，不崩", () => {
		const text = renderDashboard(buildDashboard({ records: [], period: PERIOD, prices: PRICES }));
		expect(text).toContain("用量看板");
		expect(text).toContain("0 token");
	});

	it("写「按工作区」而非「按用户」—— 口径不能误导追责", () => {
		// 记录里没有 userId，按用户下钻实际是按工作区。
		// 界面上写「按用户」会让管理员按错误口径追责
		const text = renderDashboard(
			buildDashboard({
				records: [usage({ workspaceId: "教务处", inputTokens: 100 })],
				period: PERIOD,
				prices: PRICES,
			}),
		);
		expect(text).toContain("按工作区");
		expect(text).not.toContain("按用户");
	});
});
