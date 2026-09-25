/**
 * 知识库检索
 *
 * 这是产品的核心差异化能力之一 —— 通用 Chatbot「不记住本单位的口径、
 * 模板与历史修改意见」，每次都要重新喂上下文。知识库解决这个结构性缺陷。
 *
 * 一条不可绕过的安全约束：**检索必须强制携带租户与权限过滤，
 * 不允许跨租户召回**（需求 §3.4）。这里的设计刻意让「忘记传租户」
 * 变成类型错误而非静默的全库检索 —— 后者是 RAG 系统最典型的泄漏方式。
 */

import { checkAccess, type Membership } from "./access.ts";
import type { Scope } from "./tenant.ts";

/** 一个文档片段。检索的最小单位。 */
export interface Chunk {
	readonly id: string;
	readonly documentId: string;
	readonly documentName: string;
	/** 片段正文。 */
	readonly text: string;
	/** 在原文中的位置，用于「跳转到原文」。 */
	readonly position: number;
	readonly tenantId: string;
	readonly workspaceId: string;
	readonly ownerId: string;
	readonly scope: Scope;
	/** 知识库标识。 */
	readonly knowledgeBaseId: string;
}

/** 检索命中。 */
export interface SearchHit {
	readonly chunk: Chunk;
	/** 相关度，越大越相关。 */
	readonly score: number;
}

export interface SearchOptions {
	readonly query: string;
	/** 返回条数上限。 */
	readonly limit?: number;
	/** 限定在某几个知识库内检索。省略则搜全部可见知识库。 */
	readonly knowledgeBaseIds?: readonly string[];
	/** 最低相关度阈值。低于此值的命中不返回 —— 宁缺勿滥。 */
	readonly minScore?: number;
}

export const DEFAULT_LIMIT = 8;
export const DEFAULT_MIN_SCORE = 0.05;

/**
 * 检索器接口。
 *
 * 注意签名：`membership` 是**必填的第一个参数**，不是可选项。
 * 这样「忘记传租户」会直接编译失败，而不是静默返回全库结果。
 */
export interface Retriever {
	search(membership: Membership, options: SearchOptions): Promise<SearchHit[]>;
}

/**
 * 关键词检索器。
 *
 * 一期用关键词匹配而非向量检索。理由：
 *  - 行业用户的查询多是明确的名词（「8D 报告模板」「实验室安全管理办法」），
 *    关键词召回已能覆盖大部分场景
 *  - 向量检索需要 embedding 服务，私有化部署时又是一个外部依赖
 *  - 检索质量的瓶颈在**文档切分与权限过滤**，不在相似度算法
 *
 * 二期按需引入向量检索时，只需实现同一个 Retriever 接口。
 */
export class KeywordRetriever implements Retriever {
	private readonly chunks: readonly Chunk[];

	constructor(chunks: readonly Chunk[]) {
		this.chunks = chunks;
	}

	async search(membership: Membership, options: SearchOptions): Promise<SearchHit[]> {
		const terms = tokenize(options.query);
		if (terms.length === 0) return [];

		const limit = options.limit ?? DEFAULT_LIMIT;
		const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
		const allowedBases =
			options.knowledgeBaseIds === undefined ? undefined : new Set(options.knowledgeBaseIds);

		const hits: SearchHit[] = [];
		for (const chunk of this.chunks) {
			// ── 权限过滤在打分之前 ──
			// 顺序很重要：先过滤再打分，不可能出现「算完分数才发现没权限」
			// 而导致的信息泄漏（例如通过返回条数推断他人有多少文档）。
			if (!checkAccess(membership, chunk, "read").allowed) continue;

			if (allowedBases !== undefined && !allowedBases.has(chunk.knowledgeBaseId)) continue;

			const score = scoreChunk(chunk.text, terms);
			if (score < minScore) continue;
			hits.push({ chunk, score });
		}

		return hits.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}

/**
 * 切词。
 *
 * 中文按字切分 + 英文数字按词切分。对行业术语（「8D报告」「IATF16949」）
 * 这类中英数混排的查询，按字/词混合切分比纯分词库更稳 ——
 * 分词库常把「8D报告」切成「8」「D」「报告」而丢掉语义。
 *
 * **按字切分的已知局限**（写 chunking 测试时由变异测试暴露）：中文查询会被
 * 拆成单字，所以「某个词只出现在标题里、正文没有」这种区分在中文里几乎不成立 ——
 * 任何一段中文都可能与查询共享若干单字。后果是：
 *
 *  - 相关度是**渐变**的，没有「完全不匹配」的清晰边界，靠 `minScore` 卡阈值
 *  - 单字噪声会让长文档更容易蒙到低分命中，故 `scoreChunk` 加了长度惩罚
 *
 * 二期引入向量检索能根本改善这一点。一期接受这个局限 ——
 * 行业用户的查询多是明确名词，覆盖率打分已足够把最相关的排到前面。
 */
export function tokenize(text: string): string[] {
	const terms: string[] = [];
	// 英文单词与数字串（含版本号形态如 16949、8D）
	for (const match of text.matchAll(/[a-zA-Z]+\d*|\d+[a-zA-Z]*/g)) {
		terms.push(match[0].toLowerCase());
	}
	// 中文按字
	for (const char of text) {
		if (/[一-龥]/.test(char)) terms.push(char);
	}
	return [...new Set(terms)];
}

/**
 * 给片段打分。
 *
 * 用「命中词数占查询词数的比例」而非词频 —— 词频会让长文档因为
 * 反复出现某个词而排到前面，而用户要的是**覆盖了查询意图**的片段。
 */
function scoreChunk(text: string, terms: readonly string[]): number {
	const lower = text.toLowerCase();
	let matched = 0;
	for (const term of terms) {
		if (lower.includes(term)) matched += 1;
	}
	if (matched === 0) return 0;

	const coverage = matched / terms.length;
	// 短片段更可能是精准命中，给一点长度惩罚（但不主导排序）
	const lengthPenalty = Math.min(1, 600 / Math.max(text.length, 1));
	return coverage * (0.85 + 0.15 * lengthPenalty);
}

/**
 * 把检索命中格式化成可注入上下文的文本。
 *
 * **必须带来源标注** —— 验收要求「产出中标注来源」。用户拿产出去
 * 过审核时，「这句话出自哪份文件」是必答问题。
 */
export function formatCitations(hits: readonly SearchHit[]): string {
	if (hits.length === 0) return "";
	const blocks = hits.map((hit, index) => {
		const ref = index + 1;
		return [
			`[${ref}] 来源：${hit.chunk.documentName}（位置 ${hit.chunk.position}）`,
			hit.chunk.text,
		].join("\n");
	});
	return ["以下是知识库检索到的相关内容，引用时请标注来源编号：", "", ...blocks].join("\n\n");
}

/** 从命中里提取溯源信息，供产物溯源链路使用。 */
export function citationsOf(hits: readonly SearchHit[]): Array<{
	readonly chunkId: string;
	readonly documentId: string;
	readonly documentName: string;
	readonly position: number;
}> {
	return hits.map((h) => ({
		chunkId: h.chunk.id,
		documentId: h.chunk.documentId,
		documentName: h.chunk.documentName,
		position: h.chunk.position,
	}));
}
