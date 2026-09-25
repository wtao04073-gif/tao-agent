/**
 * 用量看板数据
 *
 * 租户管理员要回答的问题就三个：**用了多少、谁在用、有没有异常**。
 * 这个模块把计量与审计数据整理成能直接渲染的形状。
 *
 * ── 一条贯穿的原则：数字要能被追问 ──
 *
 * 「本月用了 1200 万 token」对管理员没有意义 —— 他会立刻问「谁用的、
 * 用在哪、为什么这么多」。答不上来的看板不会有人看第二次。
 *
 * 所以每个汇总都带**可下钻的维度**（按用户、按场景、按模型、按天），
 * 且金额与 token 同时给出（管理员关心钱，技术关心量）。
 */

import { estimateCost, formatYuan, type ModelPrice, type UsageRecord } from "./metering.ts";
import type { Quota, QuotaVerdict, UsageTotals } from "./metering.ts";

/** 一个维度上的用量明细。 */
export interface UsageBreakdown {
	/** 维度取值，如用户 id、场景 id、模型名、日期。 */
	readonly key: string;
	/** 面向用户的标签。维度取值是 id 时用它显示。 */
	readonly label: string;
	readonly totalTokens: number;
	readonly taskCount: number;
	readonly costMicroYuan: number;
	/** 占总量的比例（0-1）。用于进度条与排序。 */
	readonly share: number;
}

/** 看板数据。 */
export interface UsageDashboard {
	readonly period: { readonly from: number; readonly to: number };
	readonly totals: UsageTotals;
	readonly costMicroYuan: number;
	/** 未配价的模型。有值时金额是**不完整的**，必须在界面上说明。 */
	readonly unpricedModels: readonly string[];
	/** 按用户下钻。 */
	readonly byUser: readonly UsageBreakdown[];
	/** 按模型下钻。 */
	readonly byModel: readonly UsageBreakdown[];
	/** 按天的趋势。用于发现突增。 */
	readonly byDay: readonly UsageBreakdown[];
	/** 配额状态。未配配额时为 undefined。 */
	readonly quota?: {
		readonly verdict: QuotaVerdict;
		/** 各维度的已用/上限，供渲染进度条。 */
		readonly limits: readonly {
			readonly dimension: "tokens" | "cost" | "tasks";
			readonly label: string;
			readonly used: number;
			readonly limit: number;
			readonly usedText: string;
			readonly limitText: string;
			readonly ratio: number;
		}[];
	};
}

/** 把一批记录按某个维度分组汇总。 */
function breakdown(
	records: readonly UsageRecord[],
	prices: readonly ModelPrice[],
	keyOf: (r: UsageRecord) => string,
	labelOf: (key: string) => string,
): UsageBreakdown[] {
	const groups = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const key = keyOf(record);
		const bucket = groups.get(key) ?? [];
		bucket.push(record);
		groups.set(key, bucket);
	}

	const rows: Array<Omit<UsageBreakdown, "share">> = [];
	for (const [key, bucket] of groups) {
		const totalTokens = bucket.reduce(
			(sum, r) => sum + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
			0,
		);
		rows.push({
			key,
			label: labelOf(key),
			totalTokens,
			taskCount: new Set(bucket.map((r) => r.taskId)).size,
			// 分组内先汇总再折算 —— 逐条折算会因取整而少计
			costMicroYuan: estimateCost(bucket, prices).microYuan,
		});
	}

	const grand = rows.reduce((sum, r) => sum + r.totalTokens, 0);
	return rows
		// 降序 —— 管理员先看用得最多的
		.sort((a, b) => b.totalTokens - a.totalTokens)
		.map((r) => ({
			...r,
			// 总量为 0 时不能除 —— 会得到 NaN，渲染出「NaN%」
			share: grand === 0 ? 0 : r.totalTokens / grand,
		}));
}

/** 取某时刻所属的 UTC 日期（YYYY-MM-DD）。 */
export function dayKey(at: number): string {
	const d = new Date(at);
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${d.getUTCFullYear()}-${month}-${day}`;
}

/** 汇总出看板数据。 */
export function buildDashboard(options: {
	readonly records: readonly UsageRecord[];
	readonly period: { readonly from: number; readonly to: number };
	readonly prices?: readonly ModelPrice[];
	readonly quota?: Quota;
	/** 配额判定。由调用方传入（它需要访问存储）。 */
	readonly verdict?: QuotaVerdict;
	/** 用户 id → 显示名。缺失时显示 id 本身。 */
	readonly userNames?: ReadonlyMap<string, string>;
}): UsageDashboard {
	const { records, period } = options;
	const prices = options.prices ?? [];

	const acc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	const tasks = new Set<string>();
	for (const r of records) {
		acc.inputTokens += r.inputTokens;
		acc.outputTokens += r.outputTokens;
		acc.cacheReadTokens += r.cacheReadTokens;
		acc.cacheWriteTokens += r.cacheWriteTokens;
		tasks.add(r.taskId);
	}

	const totals: UsageTotals = {
		...acc,
		totalTokens:
			acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheWriteTokens,
		taskCount: tasks.size,
	};

	const cost = estimateCost(records, prices);

	const dashboard: UsageDashboard = {
		period,
		totals,
		costMicroYuan: cost.microYuan,
		unpricedModels: cost.unpricedModels,
		byUser: breakdown(
			records,
			prices,
			// 用量记录里没有 userId —— 按 workspaceId 下钻（见文件末尾的能力边界）
			(r) => r.workspaceId,
			(key) => options.userNames?.get(key) ?? key,
		),
		byModel: breakdown(records, prices, (r) => r.model, (key) => key),
		byDay: breakdown(records, prices, (r) => dayKey(r.at), (key) => key),
	};

	if (options.quota === undefined || options.verdict === undefined) return dashboard;

	type QuotaLimit = NonNullable<UsageDashboard["quota"]>["limits"][number];
	const limits: QuotaLimit[] = [];
	const quota = options.quota;

	if (quota.maxTokens !== undefined) {
		limits.push({
			dimension: "tokens",
			label: "Token 用量",
			used: totals.totalTokens,
			limit: quota.maxTokens,
			usedText: `${totals.totalTokens.toLocaleString("zh-CN")} token`,
			limitText: `${quota.maxTokens.toLocaleString("zh-CN")} token`,
			ratio: quota.maxTokens === 0 ? 1 : Math.min(1, totals.totalTokens / quota.maxTokens),
		});
	}
	if (quota.maxCostMicroYuan !== undefined) {
		limits.push({
			dimension: "cost",
			label: "费用",
			used: cost.microYuan,
			limit: quota.maxCostMicroYuan,
			usedText: formatYuan(cost.microYuan),
			limitText: formatYuan(quota.maxCostMicroYuan),
			ratio:
				quota.maxCostMicroYuan === 0
					? 1
					: Math.min(1, cost.microYuan / quota.maxCostMicroYuan),
		});
	}
	if (quota.maxTasks !== undefined) {
		limits.push({
			dimension: "tasks",
			label: "任务数",
			used: totals.taskCount,
			limit: quota.maxTasks,
			usedText: `${totals.taskCount} 个`,
			limitText: `${quota.maxTasks} 个`,
			ratio: quota.maxTasks === 0 ? 1 : Math.min(1, totals.taskCount / quota.maxTasks),
		});
	}

	return { ...dashboard, quota: { verdict: options.verdict, limits } };
}

/**
 * 把看板渲染成纯文本。
 *
 * 一期没有前端界面，管理员通过 API 取数。给一份可直接看的文本，
 * 比让客户自己解析 JSON 现实得多。
 */
export function renderDashboard(dashboard: UsageDashboard): string {
	const lines: string[] = [];
	const from = new Date(dashboard.period.from).toISOString().slice(0, 10);
	const to = new Date(dashboard.period.to).toISOString().slice(0, 10);

	lines.push("", `用量看板（${from} 至 ${to}）`, "─".repeat(52));
	lines.push(`  总用量    ${dashboard.totals.totalTokens.toLocaleString("zh-CN")} token`);
	lines.push(`  任务数    ${dashboard.totals.taskCount} 个`);
	lines.push(`  费用      ${formatYuan(dashboard.costMicroYuan)}`);

	/**
	 * 未配价必须显式说明。
	 *
	 * 否则管理员看到一个偏低的金额会以为用得很省，
	 * 而实际上有些模型的消耗完全没算进去。
	 */
	if (dashboard.unpricedModels.length > 0) {
		lines.push(
			`  ⚠ 以下模型未配置单价，费用不完整：${dashboard.unpricedModels.join("、")}`,
		);
	}

	if (dashboard.quota !== undefined) {
		lines.push("", "配额", "─".repeat(52));
		for (const limit of dashboard.quota.limits) {
			const percent = Math.round(limit.ratio * 100);
			// 20 格的进度条，文本界面下够看
			const filled = Math.round(limit.ratio * 20);
			const bar = `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
			lines.push(`  ${limit.label.padEnd(10)} ${bar} ${percent}%`);
			lines.push(`  ${" ".repeat(10)} ${limit.usedText} / ${limit.limitText}`);
		}
		if (!dashboard.quota.verdict.ok) {
			lines.push(`  ✗ ${dashboard.quota.verdict.reason}`);
		} else if (dashboard.quota.verdict.warning !== undefined) {
			lines.push(`  ! ${dashboard.quota.verdict.warning}`);
		}
	}

	const section = (title: string, rows: readonly UsageBreakdown[], limit = 5): void => {
		if (rows.length === 0) return;
		lines.push("", title, "─".repeat(52));
		for (const row of rows.slice(0, limit)) {
			const percent = `${Math.round(row.share * 100)}%`.padStart(4);
			lines.push(
				`  ${row.label.padEnd(20)} ${row.totalTokens.toLocaleString("zh-CN").padStart(12)} token  ${percent}  ${formatYuan(row.costMicroYuan)}`,
			);
		}
		// 明确说明被截断了，否则管理员会以为只有这几项
		if (rows.length > limit) {
			lines.push(`  …… 另有 ${rows.length - limit} 项未显示`);
		}
	};

	section("按工作区", dashboard.byUser);
	section("按模型", dashboard.byModel);
	section("按日期", dashboard.byDay, 10);

	lines.push("");
	return lines.join("\n");
}

/**
 * ── 能力边界 ──
 *
 *  - **按用户下钻实际是按工作区下钻。** `UsageRecord` 里没有 `userId` ——
 *    计量发生在适配层，而那里只拿到 `TenantContext` 的租户与工作区。
 *    要按人下钻得先把 userId 带进用量记录（改 `UsageRecord` 形状 +
 *    改落账接线），留到 M5。**界面上必须写「按工作区」而不是「按用户」**，
 *    否则管理员会按错误的口径追责。
 *  - **没有按场景下钻。** 用量记录里没有 scenarioId，同上。
 *  - **没有实时刷新。** 看板是查询时汇总的快照。
 *  - **大数据量下会慢。** 每次查询都全量读分片并在内存里分组。
 *    单机部署一年的量级（十万条以内）没问题，SaaS 形态要换聚合表。
 */
