/**
 * 文档切分
 *
 * 检索质量的瓶颈在切分，不在相似度算法。切错了再好的算法也召回不到。
 *
 * 目标客户的文档有两个特点决定了切分策略：
 *
 *  1. **强层级结构。** 体系文件、评估指标、管理办法都是「第X章 / 第Y条」
 *     的树形结构。按固定字数切会把「第 5.2 条 不合格品处置」的标题
 *     与正文切开，检索命中标题却拿不到内容。
 *  2. **条款是自然的检索单位。** 用户查「不合格品怎么处置」，要的是
 *     那一条的完整内容，不是横跨两条的一段文本。
 *
 * 所以按**标题边界**切分，而非按固定字数。每个片段带上它所属的标题路径
 * （「质量手册 > 第5章 测量分析 > 5.2 不合格品处置」），这样：
 *   - 命中片段时能告诉用户它出自哪一条
 *   - 标题里的关键词也参与匹配（用户常用标题词检索）
 */

import type { Chunk } from "./retrieval.ts";
import type { Scope } from "./tenant.ts";

/** 待切分的文档段落。与 @tao/office 的 DocParagraph 结构对齐。 */
export interface SourceParagraph {
	readonly index: number;
	readonly text: string;
	readonly isHeading: boolean;
	readonly headingLevel: number | null;
}

export interface ChunkOptions {
	/**
	 * 单个片段的目标字数上限。
	 *
	 * 超长的条款会被继续按段落切开 —— 有些管理办法一条能写两千字，
	 * 整条塞进上下文会挤掉其他召回结果。
	 */
	readonly maxChars?: number;
	/**
	 * 相邻片段的重叠段落数。
	 *
	 * 用于缓解「答案正好横跨切分点」。默认 1 段 —— 再多会让同一内容
	 * 在多个片段里重复，检索结果看起来是好几条其实是同一段。
	 */
	readonly overlapParagraphs?: number;
}

export const DEFAULT_MAX_CHARS = 1200;
export const DEFAULT_OVERLAP = 1;

/** 切分产出的片段（尚未附加归属信息）。 */
export interface RawChunk {
	readonly text: string;
	/** 所属标题路径，从外到内。空数组表示文档开头没有标题的内容。 */
	readonly headingPath: readonly string[];
	/** 该片段在原文中的起始段落序号。这是溯源的 locator。 */
	readonly startParagraph: number;
	readonly endParagraph: number;
}

/**
 * 按标题边界切分文档。
 *
 * 切分规则：
 *  - 遇到标题时结束当前片段，开始新片段
 *  - 同级或更高级标题会重置标题路径的对应层级
 *  - 片段超过 maxChars 时就地切断，但仍保留同一标题路径
 */
export function chunkDocument(
	paragraphs: readonly SourceParagraph[],
	options: ChunkOptions = {},
): RawChunk[] {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const overlap = options.overlapParagraphs ?? DEFAULT_OVERLAP;

	const chunks: RawChunk[] = [];
	/** 当前标题路径。索引 0 对应 level 1。 */
	let headingPath: string[] = [];
	let buffer: SourceParagraph[] = [];

	const flush = (): void => {
		if (buffer.length === 0) return;
		const text = buffer.map((p) => p.text).join("\n");
		if (text.trim() === "") {
			buffer = [];
			return;
		}
		chunks.push({
			text,
			headingPath: [...headingPath],
			startParagraph: buffer[0]?.index ?? 0,
			endParagraph: buffer.at(-1)?.index ?? 0,
		});
		// 留下尾部若干段作为下一片段的重叠部分
		buffer = overlap > 0 ? buffer.slice(-overlap) : [];
	};

	for (const paragraph of paragraphs) {
		if (paragraph.isHeading) {
			// 标题是天然的切分点：一个条款结束，下一个开始
			flush();
			// 新标题开始时不带重叠 —— 上一条的尾巴混进下一条会让
			// 检索结果的归属混乱（明明是 5.3 却显示 5.2 的内容）
			buffer = [];

			const level = paragraph.headingLevel ?? 1;
			// 截断到当前层级之上，再放入自己。同级标题会替换而非追加
			headingPath = headingPath.slice(0, level - 1);
			headingPath[level - 1] = paragraph.text;
			// 中间层级缺失时补空串，避免 undefined 进数组
			for (let i = 0; i < headingPath.length; i++) {
				headingPath[i] ??= "";
			}
			continue;
		}

		buffer.push(paragraph);

		const currentChars = buffer.reduce((sum, p) => sum + p.text.length, 0);
		if (currentChars >= maxChars) flush();
	}

	flush();
	return chunks;
}

/** 入库时需要的归属信息。 */
export interface IngestContext {
	readonly tenantId: string;
	readonly workspaceId: string;
	readonly ownerId: string;
	readonly scope: Scope;
	readonly knowledgeBaseId: string;
	readonly documentId: string;
	readonly documentName: string;
}

/**
 * 把切分结果转成可检索的 Chunk。
 *
 * 归属信息（租户、工作区、scope）在这里**一次性注入**。
 * 这是刻意的：入库是唯一能给片段打上归属标签的时机，
 * 漏掉一个字段就意味着该片段的权限判定会出错。
 * 让它成为必填参数，忘记传就编译不过。
 */
export function toChunks(raw: readonly RawChunk[], context: IngestContext): Chunk[] {
	return raw.map((chunk, i) => ({
		id: `${context.documentId}#${i}`,
		documentId: context.documentId,
		documentName: context.documentName,
		/**
		 * 标题路径拼进正文参与匹配。
		 *
		 * 用户常用标题词检索（「不合格品处置的规定」），而这些词
		 * 往往只出现在标题里，不在条款正文中。
		 */
		text: chunk.headingPath.length > 0
			? `${chunk.headingPath.filter((h) => h !== "").join(" > ")}\n${chunk.text}`
			: chunk.text,
		position: chunk.startParagraph,
		tenantId: context.tenantId,
		workspaceId: context.workspaceId,
		ownerId: context.ownerId,
		scope: context.scope,
		knowledgeBaseId: context.knowledgeBaseId,
	}));
}

/**
 * 切分并入库，一步完成。
 *
 * 这是推荐入口 —— 分两步调用容易漏掉归属信息。
 */
export function ingestDocument(
	paragraphs: readonly SourceParagraph[],
	context: IngestContext,
	options: ChunkOptions = {},
): Chunk[] {
	return toChunks(chunkDocument(paragraphs, options), context);
}

/** 描述一个片段的来源位置，用于检索结果展示与溯源。 */
export function describeChunkSource(chunk: Chunk, headingPath?: readonly string[]): string {
	const where =
		headingPath !== undefined && headingPath.length > 0
			? `${headingPath.filter((h) => h !== "").join(" > ")}，第 ${chunk.position} 段`
			: `第 ${chunk.position} 段`;
	return `${chunk.documentName}（${where}）`;
}
