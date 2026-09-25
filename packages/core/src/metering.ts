/**
 * 用量计量、配额与熔断
 *
 * ── 设计依据：[Spike 6](../../../spikes/06-metering-breaker/) ──
 *
 * 原计划把熔断挂在 `before_request`（模型调用前），实测发现**不可行**：
 * 该钩子的 result 类型没有 `block` 通道，且内核把 handler 异常 catch 后
 * 只 `reportError`、**不重抛** —— 它是 fail-open 的。挂在那里会做出一个
 * 「看起来生效、实际不生效」的熔断，比没有熔断更危险（会静默超卖）。
 *
 * 所以熔断挂在 `before_tool` 上（fail-closed，已由 M0 Spike 3 验证）。
 * 代价见文件末尾的「能力边界」。
 *
 * ── 三条不能妥协的语义 ──
 *
 *  1. **不能漏计。** 任务失败但 token 已经烧掉了，那笔消耗仍要记账。
 *     否则用户能靠「发起必然失败的任务」白嫖。Spike 6 确认失败前的
 *     usage 仍会逐轮上报，所以只要不在失败路径上跳过记账就行。
 *  2. **配额是租户级的，不是任务级的。** 一个租户并发跑 10 个任务，
 *     不能每个任务都拿到全额配额。
 *  3. **熔断必须给出可操作的理由。** 用 `{block: {reason}}` 而非抛异常 ——
 *     前者会把理由交给模型，模型能转述给用户（Spike 6 已验证）；
 *     后者只会让任务失败，用户看到的是一句技术报错。
 */

import type { PermissionGate, ToolDecision } from "./runner.ts";
import type { TenantContext } from "./tenant.ts";

/**
 * 一条用量记录。
 *
 * **只存 token 数，不存金额。** 见 `estimateCost` 的说明 ——
 * 逐条记录折算金额会因四舍五入而系统性少计。
 */
export interface UsageRecord {
	readonly tenantId: string;
	readonly workspaceId: string;
	readonly taskId: string;
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly at: number;
}

/**
 * 金额的最小单位：微元（1 元 = 1_000_000 微元）。
 *
 * 用整数微元而非浮点元：国产模型 API 的单价低到 0.5 元/百万 token，
 * 一次几千 token 的调用折合几分之一分钱。用浮点累加几十万条记录会漂移，
 * 而漂移的方向对平台方不利（用户少付）。
 */
export const MICRO_YUAN_PER_YUAN = 1_000_000;

/** 一个模型的计价。单位为「元 / 百万 token」，与各家官网口径一致。 */
export interface ModelPrice {
	readonly model: string;
	readonly inputPerMillionYuan: number;
	readonly outputPerMillionYuan: number;
	/** 缓存命中的输入单价。通常远低于普通输入。未给出时按输入价计。 */
	readonly cacheReadPerMillionYuan?: number;
	/** 缓存写入的单价。未给出时按输入价计。 */
	readonly cacheWritePerMillionYuan?: number;
}

/** 用量汇总。 */
export interface UsageTotals {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	/** 计费 token 总数。配额按它判定 —— 与是否配了价格无关。 */
	readonly totalTokens: number;
	readonly taskCount: number;
}

/** 计量存储。私有化部署可换成 Postgres 实现。 */
export interface MeteringStore {
	/**
	 * 追加一条用量记录。
	 *
	 * **必须是追加**而非读-改-写：并发任务同时记账时，读-改-写会丢记录。
	 */
	record(entry: UsageRecord): Promise<void>;
	/** 汇总某租户在某时间窗内的用量。 */
	totals(
		tenantId: string,
		window: { readonly from: number; readonly to: number },
	): Promise<UsageTotals>;
	/** 列出明细，供用量看板与对账使用。 */
	list(
		tenantId: string,
		window: { readonly from: number; readonly to: number },
	): Promise<readonly UsageRecord[]>;
}

/**
 * 一个租户的配额。
 *
 * 三个上限互相独立，任一触顶即熔断。都不设则为无限制 ——
 * 私有化部署用自有推理服务时通常如此。
 */
export interface Quota {
	readonly tenantId: string;
	/** 计费周期起止。用量按它裁剪，跨周期自动归零。 */
	readonly periodStart: number;
	readonly periodEnd: number;
	/** token 上限。`0` 表示一个 token 都不许用，**不是**无限制。 */
	readonly maxTokens?: number;
	/** 金额上限（微元）。 */
	readonly maxCostMicroYuan?: number;
	/** 任务数上限。 */
	readonly maxTasks?: number;
	/** 用到多少比例时开始提醒。默认 0.8。 */
	readonly warnRatio?: number;
}

/** 配额判定结果。 */
export type QuotaVerdict =
	| { readonly ok: true; readonly warning?: string }
	| {
			readonly ok: false;
			readonly reason: string;
			/** 触顶的维度，便于看板分类与告警。 */
			readonly exceeded: "tokens" | "cost" | "tasks" | "unavailable";
	  };

/**
 * 按 token 数折算金额（微元）。
 *
 * **从汇总量折算，不从单条记录折算。** 单条几千 token 折合不到 1 微元，
 * 逐条取整会把每笔都算成 0 —— 用户可以无限用而账上始终是零。
 * 这类「每笔都少一点」的缺陷在小规模测试下完全看不出来。
 *
 * 未配价的模型会被列在 `unpricedModels` 里而**不是按免费处理**：
 * 新接一个模型忘了配价，若按免费算就是白送算力，且账面上完全正常。
 */
export function estimateCost(
	records: readonly UsageRecord[],
	prices: readonly ModelPrice[],
): { microYuan: number; unpricedModels: string[] } {
	const byModel = new Map(prices.map((p) => [p.model, p]));
	// 先按模型累计 token，再统一折算 —— 避免逐条取整
	const tokensByModel = new Map<
		string,
		{ input: number; output: number; cacheRead: number; cacheWrite: number }
	>();

	for (const r of records) {
		const acc = tokensByModel.get(r.model) ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		};
		acc.input += r.inputTokens;
		acc.output += r.outputTokens;
		acc.cacheRead += r.cacheReadTokens;
		acc.cacheWrite += r.cacheWriteTokens;
		tokensByModel.set(r.model, acc);
	}

	let microYuan = 0;
	const unpriced = new Set<string>();

	for (const [model, acc] of tokensByModel) {
		const price = byModel.get(model);
		if (price === undefined) {
			unpriced.add(model);
			continue;
		}
		const perMillion = (tokens: number, yuanPerMillion: number): number =>
			(tokens * yuanPerMillion * MICRO_YUAN_PER_YUAN) / 1_000_000;

		microYuan += perMillion(acc.input, price.inputPerMillionYuan);
		microYuan += perMillion(acc.output, price.outputPerMillionYuan);
		microYuan += perMillion(
			acc.cacheRead,
			price.cacheReadPerMillionYuan ?? price.inputPerMillionYuan,
		);
		microYuan += perMillion(
			acc.cacheWrite,
			price.cacheWritePerMillionYuan ?? price.inputPerMillionYuan,
		);
	}

	// 只在最后取整，且向上取整 —— 平台方不该因取整而少收
	return { microYuan: Math.ceil(microYuan), unpricedModels: [...unpriced] };
}

/** 把微元格式化成给人看的金额。 */
export function formatYuan(microYuan: number): string {
	return `${(microYuan / MICRO_YUAN_PER_YUAN).toFixed(2)} 元`;
}

/**
 * 判定配额。
 *
 * 用 `!== undefined` 而非真值判断：`maxTokens: 0` 的语义是
 * 「一个 token 都不许用」（例如欠费停机），真值判断会把它当成无限制 ——
 * 恰好在最需要拦住的场景下放行。
 */
export function checkQuota(
	quota: Quota,
	totals: UsageTotals,
	cost?: { readonly microYuan: number },
): QuotaVerdict {
	const warnRatio = quota.warnRatio ?? 0.8;
	const warnings: string[] = [];

	const judge = (
		used: number,
		limit: number | undefined,
		dimension: "tokens" | "cost" | "tasks",
		describe: (used: number, limit: number) => string,
	): QuotaVerdict | undefined => {
		if (limit === undefined) return undefined;
		if (used >= limit) {
			return {
				ok: false,
				reason: `${describe(used, limit)}，已达本周期上限，请联系管理员提额或等待下个周期`,
				exceeded: dimension,
			};
		}
		if (limit > 0 && used / limit >= warnRatio) {
			warnings.push(describe(used, limit));
		}
		return undefined;
	};

	const verdicts = [
		judge(
			totals.totalTokens,
			quota.maxTokens,
			"tokens",
			(u, l) => `已用 ${u} / ${l} token`,
		),
		judge(
			cost?.microYuan ?? 0,
			quota.maxCostMicroYuan,
			"cost",
			(u, l) => `已用 ${formatYuan(u)} / ${formatYuan(l)}`,
		),
		judge(totals.taskCount, quota.maxTasks, "tasks", (u, l) => `已用 ${u} / ${l} 个任务`),
	].filter((v) => v !== undefined);

	if (verdicts.length > 0) return verdicts[0] as QuotaVerdict;
	return warnings.length > 0 ? { ok: true, warning: warnings.join("；") } : { ok: true };
}

/** 记录一次模型用量。由适配层在收到 usage 事件时调用。 */
export async function recordUsage(
	store: MeteringStore,
	entry: UsageRecord,
): Promise<void> {
	await store.record(entry);
}

/**
 * 取某租户当前周期的配额判定。
 *
 * 把「查配额 → 汇总用量 → 折算金额 → 判定」串成一次调用，
 * 避免调用方漏掉其中一步（漏掉折算就等于金额上限失效）。
 */
export async function evaluateQuota(options: {
	readonly store: MeteringStore;
	readonly quota: Quota;
	readonly prices?: readonly ModelPrice[];
}): Promise<QuotaVerdict> {
	const window = { from: options.quota.periodStart, to: options.quota.periodEnd };
	const totals = await options.store.totals(options.quota.tenantId, window);

	// 只有配了金额上限才需要折算 —— 省掉一次明细查询
	if (options.quota.maxCostMicroYuan === undefined) {
		return checkQuota(options.quota, totals);
	}
	const records = await options.store.list(options.quota.tenantId, window);
	const cost = estimateCost(records, options.prices ?? []);
	return checkQuota(options.quota, totals, cost);
}

export interface QuotaGateOptions {
	/** 取当前租户的配额判定。返回 undefined 表示该租户无配额限制。 */
	readonly evaluate: (tenant: TenantContext) => Promise<QuotaVerdict | undefined>;
	/** 审计回调。被配额拦下的调用也必须留痕，否则用量争议无从对账。 */
	readonly audit?: (entry: {
		readonly tool: string;
		readonly tenantId: string;
		readonly reason: string;
		readonly exceeded: string;
	}) => void | Promise<void>;
	/**
	 * 计量存储不可用时的行为。默认 `"block"`。
	 *
	 * 选 block 的理由：静默超支是不可回收的损失，而被拦下的任务用户可以重试。
	 * 私有化部署若用自有推理服务、本就不限量，应当**把配额设为无限制**，
	 * 而不是把这个开关翻成 allow —— 后者会让 SaaS 形态下的计量故障变成免费午餐。
	 */
	readonly onStoreError?: "block" | "allow";
}

/**
 * 给权限门叠加配额熔断。
 *
 * **顺序是先安全、后配额**，这是刻意的：
 * 若一次调用同时越权又超配额，用户应当看到「越权」而不是「超配额」——
 * 越权可能是攻击迹象，被配额理由盖住就查不出来了。
 *
 * 只对已放行（allow / confirm）的调用查配额：已被安全门拒的调用
 * 本来也不会消耗 token，没必要再判一次。
 */
export function withQuotaGate(inner: PermissionGate, options: QuotaGateOptions): PermissionGate {
	return async (request): Promise<ToolDecision> => {
		const decision = await inner(request);
		if (decision.kind === "block") return decision;

		let verdict: QuotaVerdict | undefined;
		try {
			verdict = await options.evaluate(request.tenant);
		} catch (error) {
			if ((options.onStoreError ?? "block") === "allow") return decision;
			const reason = `用量计量不可用，为避免超支已暂停执行：${
				error instanceof Error ? error.message : String(error)
			}`;
			await options.audit?.({
				tool: request.toolName,
				tenantId: request.tenant.tenantId,
				reason,
				exceeded: "unavailable",
			});
			return { kind: "block", reason };
		}

		if (verdict === undefined || verdict.ok) return decision;

		await options.audit?.({
			tool: request.toolName,
			tenantId: request.tenant.tenantId,
			reason: verdict.reason,
			exceeded: verdict.exceeded,
		});
		return { kind: "block", reason: verdict.reason };
	};
}

/**
 * ── 能力边界（Spike 6 实测后的诚实结论）──
 *
 *  - **拦不住纯文本生成。** 熔断挂在 `before_tool` 上，一次「不调工具、
 *    只生成长文本」的运行不会经过任何闸门。超限租户提交任务后，
 *    仍可能烧掉一轮模型调用才被拦下。要在模型调用前拦，需要改内核
 *    （给 `before_request` 加 block 通道）或在 provider 层加闸 ——
 *    前者破坏 vendor 策略，后者是 M5 的事。
 *  - **配额检查有一轮的滞后。** 判定读的是已落账的用量，当前这一轮的
 *    消耗还没入账。并发任务多时，实际超出量可达「并发数 × 单轮消耗」。
 *    SaaS 形态下应把配额上限设得略低于硬上限来吸收这个误差。
 *  - **任务数统计的是有用量记录的任务数**，零消耗的任务不计入。
 *  - **未接入编排层的提交前预检。** `evaluateQuota` 已可用，但
 *    `TaskOrchestrator.submit` 还没调它 —— 接入见 M4-1 的编排层改动。
 */
