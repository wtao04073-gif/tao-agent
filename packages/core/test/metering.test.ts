/**
 * 计量、配额与熔断测试
 *
 * 断言重点在**钱不能算错**上。计量缺陷的特点是：功能测试全绿（任务都能跑），
 * 只是账不对 —— 而账不对要到对账时才发现，那时已经收错钱了。
 *
 * 所以这里的断言大量用**固定期望值**而非「大于零」：
 * 「金额大于 0」这种断言在单价算错一个数量级时依然通过。
 */

import { describe, expect, it } from "vitest";
import {
	checkQuota,
	estimateCost,
	evaluateQuota,
	formatYuan,
	MICRO_YUAN_PER_YUAN,
	withQuotaGate,
	createPermissionGate,
	type ModelPrice,
	type PermissionGate,
	type Quota,
	type QuotaVerdict,
	type TenantContext,
	type UsageRecord,
	type UsageTotals,
} from "../src/index.ts";

const TENANT: TenantContext = { tenantId: "univ-005", workspaceId: "admin", userId: "zhao" };

/** DeepSeek 与通义的真实量级单价，便于发现数量级错误。 */
const PRICES: ModelPrice[] = [
	{ model: "deepseek-chat", inputPerMillionYuan: 2, outputPerMillionYuan: 8 },
	{
		model: "qwen-plus",
		inputPerMillionYuan: 0.8,
		outputPerMillionYuan: 2,
		cacheReadPerMillionYuan: 0.16,
	},
];

function usage(patch: Partial<UsageRecord> = {}): UsageRecord {
	return {
		tenantId: TENANT.tenantId,
		workspaceId: TENANT.workspaceId,
		taskId: "t-1",
		model: "deepseek-chat",
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		at: 1_700_000_000_000,
		...patch,
	};
}

function totals(patch: Partial<UsageTotals> = {}): UsageTotals {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		taskCount: 0,
		...patch,
	};
}

const PERIOD: Pick<Quota, "tenantId" | "periodStart" | "periodEnd"> = {
	tenantId: TENANT.tenantId,
	periodStart: 1_700_000_000_000,
	periodEnd: 1_800_000_000_000,
};

describe("金额折算", () => {
	it("按固定单价算出精确金额", () => {
		// 100 万输入 token × 2 元/百万 = 2 元；50 万输出 × 8 元/百万 = 4 元
		const { microYuan } = estimateCost(
			[usage({ inputTokens: 1_000_000, outputTokens: 500_000 })],
			PRICES,
		);
		// 固定期望值 —— 「大于 0」的断言在单价错一个数量级时也会通过
		expect(microYuan).toBe(6 * MICRO_YUAN_PER_YUAN);
		expect(formatYuan(microYuan)).toBe("6.00 元");
	});

	it("小额调用逐条取整会归零，所以必须先汇总再折算", () => {
		// 这是本模块最容易写错的地方：单条 3000 token × 2元/百万 = 6 微元。
		// 若实现按「每条折算后取整」，大量小额调用会各自被算成很小的数，
		// 累计误差可观；极端情况下（单价更低）每条都取整成 0。
		//
		// 1000 条 × 3000 token = 300 万 token × 2 元/百万 = 6 元
		const records = Array.from({ length: 1000 }, (_, i) =>
			usage({ inputTokens: 3000, taskId: `t-${i}` }),
		);
		const { microYuan } = estimateCost(records, PRICES);
		expect(microYuan).toBe(6 * MICRO_YUAN_PER_YUAN);
	});

	it("缓存读按缓存单价计，不按输入单价", () => {
		// qwen-plus：缓存读 0.16 元/百万，是输入价 0.8 的 1/5。
		// 按输入价算会高估 5 倍 —— 用户会因此被多收钱
		const { microYuan } = estimateCost(
			[usage({ model: "qwen-plus", cacheReadTokens: 1_000_000 })],
			PRICES,
		);
		expect(microYuan).toBe(0.16 * MICRO_YUAN_PER_YUAN);
	});

	it("未配缓存单价时退化为输入单价", () => {
		// deepseek-chat 没配 cacheRead 价
		const { microYuan } = estimateCost(
			[usage({ cacheReadTokens: 1_000_000 })],
			PRICES,
		);
		expect(microYuan).toBe(2 * MICRO_YUAN_PER_YUAN);
	});

	it("未配价的模型被列出，而不是按免费处理", () => {
		// 新接一个模型忘了配价，若按免费算就是白送算力，且账面完全正常
		const result = estimateCost(
			[usage({ model: "kimi-k2", inputTokens: 1_000_000 })],
			PRICES,
		);
		expect(result.unpricedModels).toEqual(["kimi-k2"]);
		expect(result.microYuan).toBe(0);
	});

	it("混合模型分别按各自单价折算", () => {
		const { microYuan } = estimateCost(
			[
				usage({ model: "deepseek-chat", inputTokens: 1_000_000 }), // 2 元
				usage({ model: "qwen-plus", outputTokens: 1_000_000 }), // 2 元
			],
			PRICES,
		);
		expect(microYuan).toBe(4 * MICRO_YUAN_PER_YUAN);
	});

	it("向上取整 —— 平台方不因取整少收", () => {
		// 1 token × 2元/百万 = 2 微元；但 1 token 的 0.8 元/百万 = 0.8 微元 → 进 1
		const { microYuan } = estimateCost(
			[usage({ model: "qwen-plus", inputTokens: 1 })],
			PRICES,
		);
		expect(microYuan).toBe(1);
	});

	it("空记录折算为零且无未配价模型", () => {
		expect(estimateCost([], PRICES)).toEqual({ microYuan: 0, unpricedModels: [] });
	});
});

describe("配额判定", () => {
	it("未触顶时放行", () => {
		const verdict = checkQuota({ ...PERIOD, maxTokens: 1000 }, totals({ totalTokens: 100 }));
		expect(verdict.ok).toBe(true);
	});

	it("达到上限即拦下（等于也算触顶）", () => {
		// 用 > 而非 >= 会让用户刚好用满时再放行一次
		const verdict = checkQuota({ ...PERIOD, maxTokens: 1000 }, totals({ totalTokens: 1000 }));
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.exceeded).toBe("tokens");
	});

	it("maxTokens 为 0 表示禁用，不是无限制", () => {
		// 真值判断（if (quota.maxTokens)）会把 0 当成未设置 —— 恰好在
		// 最需要拦住的场景（欠费停机）下放行。这条断言守住它
		const verdict = checkQuota({ ...PERIOD, maxTokens: 0 }, totals({ totalTokens: 0 }));
		expect(verdict.ok).toBe(false);
	});

	it("未设上限的维度不参与判定", () => {
		const verdict = checkQuota({ ...PERIOD }, totals({ totalTokens: 999_999_999 }));
		expect(verdict.ok).toBe(true);
	});

	it("金额上限独立生效", () => {
		const verdict = checkQuota(
			{ ...PERIOD, maxCostMicroYuan: 10 * MICRO_YUAN_PER_YUAN },
			totals({ totalTokens: 1 }),
			{ microYuan: 10 * MICRO_YUAN_PER_YUAN },
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.exceeded).toBe("cost");
	});

	it("任务数上限独立生效", () => {
		const verdict = checkQuota({ ...PERIOD, maxTasks: 5 }, totals({ taskCount: 5 }));
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.exceeded).toBe("tasks");
	});

	it("拒绝理由是用户可操作的，不是技术报错", () => {
		const verdict = checkQuota({ ...PERIOD, maxTokens: 100 }, totals({ totalTokens: 100 }));
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			// 用户看到后知道该做什么
			expect(verdict.reason).toContain("联系管理员提额");
			// 且含具体数字，便于判断差多少
			expect(verdict.reason).toContain("100");
		}
	});

	it("接近上限时给出提醒但仍放行", () => {
		const verdict = checkQuota(
			{ ...PERIOD, maxTokens: 1000, warnRatio: 0.8 },
			totals({ totalTokens: 850 }),
		);
		expect(verdict.ok).toBe(true);
		if (verdict.ok) expect(verdict.warning).toContain("850");
	});

	it("未接近上限时不发提醒 —— 否则提醒会被忽略", () => {
		const verdict = checkQuota({ ...PERIOD, maxTokens: 1000 }, totals({ totalTokens: 100 }));
		expect(verdict.ok).toBe(true);
		if (verdict.ok) expect(verdict.warning).toBeUndefined();
	});

	it("多个维度同时超限时报第一个，理由不混在一起", () => {
		const verdict = checkQuota(
			{ ...PERIOD, maxTokens: 10, maxTasks: 1 },
			totals({ totalTokens: 100, taskCount: 5 }),
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.exceeded).toBe("tokens");
	});
});

describe("配额熔断闸", () => {
	const gate: PermissionGate = createPermissionGate({
		policies: [{ tool: "write_document" }, { tool: "read_document", pathParams: ["path"] }],
		workspace: "/ws",
	});

	const request = {
		toolName: "write_document",
		args: {},
		tenant: TENANT,
		taskId: "t-1",
	};

	it("配额充足时不改变原决策", async () => {
		const wrapped = withQuotaGate(gate, { evaluate: async () => ({ ok: true }) });
		expect((await wrapped(request)).kind).toBe("allow");
	});

	it("超配额时把放行改成拒绝", async () => {
		const wrapped = withQuotaGate(gate, {
			evaluate: async () => ({ ok: false, reason: "已达上限", exceeded: "tokens" as const }),
		});
		const decision = await wrapped(request);
		expect(decision.kind).toBe("block");
		if (decision.kind === "block") expect(decision.reason).toContain("已达上限");
	});

	it("安全拒绝优先于配额拒绝 —— 越权不能被配额理由盖住", async () => {
		// 若一次调用同时越权又超配额，用户应看到「越权」。
		// 反了的话攻击迹象会被当成配额问题忽略
		let evaluated = false;
		const wrapped = withQuotaGate(gate, {
			evaluate: async () => {
				evaluated = true;
				return { ok: false, reason: "配额超限", exceeded: "tokens" as const };
			},
		});
		const decision = await wrapped({ ...request, toolName: "未登记的工具" });
		expect(decision.kind).toBe("block");
		if (decision.kind === "block") expect(decision.reason).toContain("未被授权");
		// 且没必要查配额 —— 本来也不会消耗 token
		expect(evaluated).toBe(false);
	});

	it("无配额限制的租户直接放行", async () => {
		const wrapped = withQuotaGate(gate, { evaluate: async () => undefined });
		expect((await wrapped(request)).kind).toBe("allow");
	});

	it("计量存储不可用时默认拦下，不静默放行", async () => {
		// 静默超支不可回收；被拦下的任务用户可以重试
		const wrapped = withQuotaGate(gate, {
			evaluate: async () => {
				throw new Error("数据库连接失败");
			},
		});
		const decision = await wrapped(request);
		expect(decision.kind).toBe("block");
		if (decision.kind === "block") {
			expect(decision.reason).toContain("为避免超支");
			// 含原始错误，便于运维排查
			expect(decision.reason).toContain("数据库连接失败");
		}
	});

	it("显式配置 allow 时存储故障放行", async () => {
		const wrapped = withQuotaGate(gate, {
			evaluate: async () => {
				throw new Error("数据库连接失败");
			},
			onStoreError: "allow",
		});
		expect((await wrapped(request)).kind).toBe("allow");
	});

	it("被配额拦下的调用留审计痕迹", async () => {
		// 没有痕迹的话用量争议无从对账
		const entries: Array<{ tool: string; exceeded: string }> = [];
		const wrapped = withQuotaGate(gate, {
			evaluate: async () => ({ ok: false, reason: "超限", exceeded: "cost" as const }),
			audit: (e) => void entries.push(e),
		});
		await wrapped(request);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ tool: "write_document", exceeded: "cost" });
	});

	it("存储故障也留痕，且标为 unavailable 便于分类告警", async () => {
		const entries: Array<{ exceeded: string }> = [];
		const wrapped = withQuotaGate(gate, {
			evaluate: async () => {
				throw new Error("超时");
			},
			audit: (e) => void entries.push(e),
		});
		await wrapped(request);
		expect(entries[0]?.exceeded).toBe("unavailable");
	});

	it("需确认的决策也要过配额 —— 确认后照样会消耗", async () => {
		const confirmGate = createPermissionGate({
			policies: [{ tool: "send_mail", requiresConfirm: true, confirmReason: "对外发送" }],
			workspace: "/ws",
		});
		const wrapped = withQuotaGate(confirmGate, {
			evaluate: async () => ({ ok: false, reason: "配额耗尽", exceeded: "tokens" as const }),
		});
		const decision = await wrapped({ ...request, toolName: "send_mail" });
		// 超配额时连确认卡片都不该弹 —— 用户确认了也执行不了
		expect(decision.kind).toBe("block");
	});
});

describe("配额判定的串联", () => {
	/** 一个最小的计量存储，用来验证 evaluateQuota 的串联逻辑。 */
	function store(records: UsageRecord[]) {
		return {
			async record(entry: UsageRecord) {
				records.push(entry);
			},
			async list(tenantId: string, w: { from: number; to: number }) {
				return records.filter((r) => r.tenantId === tenantId && r.at >= w.from && r.at < w.to);
			},
			async totals(tenantId: string, w: { from: number; to: number }) {
				const rs = await this.list(tenantId, w);
				const sum = (pick: (r: UsageRecord) => number) => rs.reduce((a, r) => a + pick(r), 0);
				return {
					inputTokens: sum((r) => r.inputTokens),
					outputTokens: sum((r) => r.outputTokens),
					cacheReadTokens: sum((r) => r.cacheReadTokens),
					cacheWriteTokens: sum((r) => r.cacheWriteTokens),
					totalTokens: sum(
						(r) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
					),
					taskCount: new Set(rs.map((r) => r.taskId)).size,
				};
			},
		};
	}

	it("配了金额上限时会真的折算 —— 否则上限形同虚设", async () => {
		const records = [usage({ inputTokens: 5_000_000 })]; // 10 元
		const verdict = await evaluateQuota({
			store: store(records),
			quota: { ...PERIOD, maxCostMicroYuan: 10 * MICRO_YUAN_PER_YUAN },
			prices: PRICES,
		});
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.exceeded).toBe("cost");
	});

	it("未配金额上限时跳过折算，只判 token", async () => {
		const records = [usage({ inputTokens: 100 })];
		const verdict = await evaluateQuota({
			store: store(records),
			quota: { ...PERIOD, maxTokens: 1000 },
			prices: PRICES,
		});
		expect(verdict.ok).toBe(true);
	});

	it("跨周期的用量不计入本周期", async () => {
		// 周期归零靠时间窗裁剪，不靠定时清理 —— 后者漏跑一次就会误拦一整个周期
		const records = [
			usage({ inputTokens: 999_999, at: PERIOD.periodStart - 1 }), // 上个周期
		];
		const verdict = await evaluateQuota({
			store: store(records),
			quota: { ...PERIOD, maxTokens: 1000 },
		});
		expect(verdict.ok).toBe(true);
	});

	it("周期结束时刻的用量归下个周期（左闭右开）", async () => {
		// 闭区间会让边界那一刻的消耗被两个周期都算一次
		const records = [usage({ inputTokens: 999_999, at: PERIOD.periodEnd })];
		const verdict = await evaluateQuota({
			store: store(records),
			quota: { ...PERIOD, maxTokens: 1000 },
		});
		expect(verdict.ok).toBe(true);
	});
});

describe("配额判定 · 别家租户", () => {
	it("别家租户的用量不计入我方配额", async () => {
		const records: UsageRecord[] = [
			usage({ tenantId: "other-univ", inputTokens: 999_999 }),
		];
		const verdict = await evaluateQuota({
			store: {
				async record() {},
				async list(tenantId, w) {
					return records.filter((r) => r.tenantId === tenantId && r.at >= w.from && r.at < w.to);
				},
				async totals(tenantId, w) {
					const rs = await this.list(tenantId, w);
					return totals({
						totalTokens: rs.reduce((a, r) => a + r.inputTokens, 0),
						taskCount: new Set(rs.map((r) => r.taskId)).size,
					});
				},
			},
			quota: { ...PERIOD, maxTokens: 1000 },
		});
		expect(verdict.ok).toBe(true);
	});
});

describe("提醒与展示", () => {
	it("金额展示到分，不暴露微元", () => {
		// 用户看到「1234567 微元」会困惑
		expect(formatYuan(1_234_567)).toBe("1.23 元");
	});

	it("零金额也正常展示", () => {
		expect(formatYuan(0)).toBe("0.00 元");
	});

	it("QuotaVerdict 的两个分支类型可辨", () => {
		// 编译期保证调用方必须先判 ok 才能读 reason
		const ok: QuotaVerdict = { ok: true };
		const bad: QuotaVerdict = { ok: false, reason: "x", exceeded: "tokens" };
		expect(ok.ok).toBe(true);
		expect(bad.ok).toBe(false);
	});
});
