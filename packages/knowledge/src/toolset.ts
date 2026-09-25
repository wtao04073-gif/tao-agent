/**
 * 知识库工具
 *
 * `search_knowledge` 与 `ingest_document`（后者不给模型用，是平台侧入库入口）。
 *
 * 一条不可绕过的约束：**检索必须携带调用者身份，不允许跨租户召回**。
 * 这里的设计让「忘记传身份」变成编译错误 —— `KnowledgeStore.search`
 * 的第一个参数是必填的 `Membership`，与 `Retriever` 接口一致。
 *
 * 为什么知识库工具单独一个包而不塞进 @tao/office：office 管的是
 * 文件格式读写，知识库管的是检索与权限。混在一起会让 office 包
 * 依赖租户模型，边界就糊了。
 */

import {
	citationsOf,
	formatCitations,
	ingestDocument,
	type Chunk,
	type IngestContext,
	type Membership,
	type PlatformTool,
	type SearchHit,
	type SourceParagraph,
} from "@tao/core";

/**
 * 知识库存储接口。
 *
 * 抽成接口是为了让一期的内存实现与后续的持久化实现可以互换 ——
 * 私有化部署会用 SQLite 或 PostgreSQL，SaaS 会用共享库加租户分区，
 * 但工具层的代码不该因此改动。
 */
export interface KnowledgeStore {
	/** 检索。membership 必填，不允许跨租户召回。 */
	search(
		membership: Membership,
		options: { query: string; limit?: number; knowledgeBaseIds?: readonly string[] },
	): Promise<SearchHit[]>;
	/** 入库。 */
	add(chunks: readonly Chunk[]): Promise<void>;
	/** 按文档删除。文档更新时先删旧片段，否则会同时召回新旧两版。 */
	removeDocument(tenantId: string, documentId: string): Promise<number>;
	/** 列出某租户可见的知识库标识与片段数，用于管理后台。 */
	stats(membership: Membership): Promise<Array<{ knowledgeBaseId: string; chunks: number }>>;
}

export interface KnowledgeToolsetOptions {
	readonly store: KnowledgeStore;
	/** 当前调用者身份。由平台在装配工具时注入，不经模型。 */
	readonly membership: Membership;
	/** 默认检索的知识库范围。省略则搜全部可见知识库。 */
	readonly defaultKnowledgeBaseIds?: readonly string[];
}

/** 单次检索返回的条数上限。给模型太多召回结果反而干扰判断。 */
const MAX_HITS = 6;

export function createKnowledgeToolset(options: KnowledgeToolsetOptions): PlatformTool[] {
	const searchTool: PlatformTool = {
		name: "search_knowledge",
		label: "检索知识库",
		description:
			"在本单位知识库中检索相关内容（制度文件、模板、历史材料、体系文件）。返回的内容带来源标注，引用时必须标明出处。查询用明确的名词，如「不合格品处置」「实验室安全管理办法」。",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "检索关键词。用明确的名词，不要用整句话提问",
				},
				limit: {
					type: "number",
					description: `返回条数，默认 ${MAX_HITS}，最大 ${MAX_HITS}`,
				},
				knowledgeBaseIds: {
					type: "array",
					items: { type: "string" },
					description: "限定在某几个知识库内检索。省略则搜全部可见知识库",
				},
			},
			required: ["query"],
		},
		replay: "safe", // 只读
		async execute({ args }) {
			const input = args as {
				query: string;
				limit?: number;
				knowledgeBaseIds?: string[];
			};

			/**
			 * 身份来自平台注入的 `options.membership`，**不从工具参数取**。
			 *
			 * 这是最关键的一行。若让模型传租户 id，越狱提示或上下文污染
			 * 就能让它读别家的知识库 —— 而这种泄漏极隐蔽，产出看起来正常，
			 * 只是内容里混进了别家的数据。
			 */
			const hits = await options.store.search(options.membership, {
				query: input.query,
				limit: Math.min(input.limit ?? MAX_HITS, MAX_HITS),
				...(input.knowledgeBaseIds !== undefined
					? { knowledgeBaseIds: input.knowledgeBaseIds }
					: options.defaultKnowledgeBaseIds !== undefined
						? { knowledgeBaseIds: options.defaultKnowledgeBaseIds }
						: {}),
			});

			if (hits.length === 0) {
				return {
					// 明确说没找到，而不是返回空字符串让模型自行想象
					text: `知识库中未找到与「${input.query}」相关的内容。如需引用制度或模板，请告知用户知识库缺少相关材料，不要凭记忆编写。`,
					details: { query: input.query, hits: 0 },
				};
			}

			return {
				text: formatCitations(hits),
				details: {
					query: input.query,
					hits: hits.length,
					// 供产物溯源链路登记来源
					citations: citationsOf(hits),
				},
			};
		},
	};

	return [searchTool];
}

/** 知识库工具的权限策略。检索没有路径参数，但仍须登记才能通过默认拒绝。 */
export const KNOWLEDGE_TOOL_POLICIES = [{ tool: "search_knowledge" }] as const;

/**
 * 平台侧入库入口。
 *
 * **不作为工具暴露给模型** —— 入库是管理动作，由用户在知识库管理界面
 * 上传文档触发，不该由 Agent 在任务执行中自行决定往知识库里写东西。
 */
export async function ingestIntoStore(
	store: KnowledgeStore,
	paragraphs: readonly SourceParagraph[],
	context: IngestContext,
): Promise<{ readonly chunks: number }> {
	// 先删旧片段：文档更新后若不删，会同时召回新旧两版，
	// 用户拿到自相矛盾的引用却不知道原因
	await store.removeDocument(context.tenantId, context.documentId);

	const chunks = ingestDocument(paragraphs, context);
	await store.add(chunks);
	return { chunks: chunks.length };
}
