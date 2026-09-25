/**
 * 内存计量存储
 *
 * 单机 Compose 私有化部署的默认实现。SaaS 形态换成 Postgres ——
 * 接口不变，因为 `record` 被刻意定义成**只追加**：并发任务同时记账时
 * 读-改-写会丢记录，而丢的是钱。
 */

import type { MeteringStore, UsageRecord, UsageTotals } from "@tao/core";

export class MemoryMeteringStore implements MeteringStore {
	/** 按租户分桶。跨租户查询在这一层就不可能发生。 */
	private readonly byTenant = new Map<string, UsageRecord[]>();

	async record(entry: UsageRecord): Promise<void> {
		const bucket = this.byTenant.get(entry.tenantId) ?? [];
		bucket.push(entry);
		this.byTenant.set(entry.tenantId, bucket);
	}

	async totals(
		tenantId: string,
		window: { readonly from: number; readonly to: number },
	): Promise<UsageTotals> {
		const records = await this.list(tenantId, window);
		const acc = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		const tasks = new Set<string>();

		for (const r of records) {
			acc.inputTokens += r.inputTokens;
			acc.outputTokens += r.outputTokens;
			acc.cacheReadTokens += r.cacheReadTokens;
			acc.cacheWriteTokens += r.cacheWriteTokens;
			tasks.add(r.taskId);
		}

		return {
			...acc,
			/**
			 * 计费 token 含缓存读写。
			 *
			 * 缓存读虽然便宜但**不是免费**，漏掉它会让配额判定偏松 ——
			 * 长对话场景下 cacheRead 可能是输入量的数倍。
			 */
			totalTokens:
				acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheWriteTokens,
			taskCount: tasks.size,
		};
	}

	async list(
		tenantId: string,
		window: { readonly from: number; readonly to: number },
	): Promise<readonly UsageRecord[]> {
		// 左闭右开：periodEnd 是下个周期的起点，闭区间会让边界那一刻双重计费
		return (this.byTenant.get(tenantId) ?? []).filter(
			(r) => r.at >= window.from && r.at < window.to,
		);
	}

	/** 测试与运维用：清空某租户的记录。 */
	async clear(tenantId: string): Promise<void> {
		this.byTenant.delete(tenantId);
	}
}
