/**
 * 内存知识库
 *
 * 一期实现。私有化部署的单机形态用它就够 —— 一个租户的制度文件
 * 通常几百到几千个片段，内存完全放得下。
 *
 * 真正的取舍在于**为什么现在不做持久化**：检索的正确性瓶颈是切分与权限过滤，
 * 这两件事与存储介质无关。先把接口定死、把权限测试写全，
 * 换存储时只需实现同一个 `KnowledgeStore` 接口，测试可以直接复用。
 */

import { checkAccess, type Chunk, type Membership, type SearchHit } from "@tao/core";
import { KeywordRetriever } from "@tao/core";
import type { KnowledgeStore } from "./toolset.ts";

export class MemoryKnowledgeStore implements KnowledgeStore {
	private chunks: Chunk[] = [];

	async search(
		membership: Membership,
		options: { query: string; limit?: number; knowledgeBaseIds?: readonly string[] },
	): Promise<SearchHit[]> {
		// 直接复用已经过完整权限测试的检索器，不另写一套过滤逻辑 ——
		// 权限判断有两处实现就会有两处不一致的风险
		const retriever = new KeywordRetriever(this.chunks);
		return retriever.search(membership, options);
	}

	async add(chunks: readonly Chunk[]): Promise<void> {
		this.chunks.push(...chunks);
	}

	async removeDocument(tenantId: string, documentId: string): Promise<number> {
		const before = this.chunks.length;
		/**
		 * 删除必须同时匹配 tenantId。
		 *
		 * 只按 documentId 删会让 A 租户能删掉 B 租户的同名文档 ——
		 * documentId 若来自文件名或用户输入，这就是个真实的跨租户写入漏洞。
		 */
		this.chunks = this.chunks.filter(
			(c) => !(c.tenantId === tenantId && c.documentId === documentId),
		);
		return before - this.chunks.length;
	}

	async stats(
		membership: Membership,
	): Promise<Array<{ knowledgeBaseId: string; chunks: number }>> {
		const counts = new Map<string, number>();
		for (const chunk of this.chunks) {
			// 统计也要过权限 —— 否则通过「某知识库有多少片段」
			// 能推断出别家有多少文档
			if (!checkAccess(membership, chunk, "read").allowed) continue;
			counts.set(chunk.knowledgeBaseId, (counts.get(chunk.knowledgeBaseId) ?? 0) + 1);
		}
		return [...counts].map(([knowledgeBaseId, chunks]) => ({ knowledgeBaseId, chunks }));
	}

	/** 片段总数。仅供测试与运维观测，不经权限过滤。 */
	get size(): number {
		return this.chunks.length;
	}
}
