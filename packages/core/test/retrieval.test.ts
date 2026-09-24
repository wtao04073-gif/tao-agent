/**
 * 知识库检索测试
 *
 * 最重要的一组：**跨租户不召回**。RAG 系统最典型的泄漏方式就是
 * 检索时漏掉租户过滤，而且这种泄漏很隐蔽 —— 产出看起来正常，
 * 只是内容里混进了别家的数据。
 */

import { describe, expect, it } from "vitest";
import {
	citationsOf,
	formatCitations,
	KeywordRetriever,
	tokenize,
	type Chunk,
} from "../src/retrieval.ts";
import { Role, Scope } from "../src/tenant.ts";
import type { Membership } from "../src/access.ts";

const member = (over: Partial<Membership> = {}): Membership => ({
	tenantId: "t1",
	workspaceId: "w1",
	userId: "u1",
	role: Role.Member,
	...over,
});

const chunk = (over: Partial<Chunk> = {}): Chunk => ({
	id: "c1",
	documentId: "d1",
	documentName: "质量手册.docx",
	text: "8D报告的第一步是成立跨职能小组",
	position: 1,
	tenantId: "t1",
	workspaceId: "w1",
	ownerId: "u1",
	scope: Scope.Workspace,
	knowledgeBaseId: "kb1",
	...over,
});

describe("检索 · 跨租户绝不召回（最高优先级）", () => {
	it("其他租户的片段不出现在结果里", async () => {
		const retriever = new KeywordRetriever([
			chunk({ id: "mine", text: "8D报告流程说明" }),
			chunk({ id: "theirs", tenantId: "t2", text: "8D报告流程说明" }),
		]);

		const hits = await retriever.search(member(), { query: "8D报告" });
		expect(hits.map((h) => h.chunk.id)).toEqual(["mine"]);
	});

	it("即使内容完全相同也不跨租户召回", async () => {
		// 内容相同时最容易「看起来没问题」，所以单独验
		const retriever = new KeywordRetriever([
			chunk({ id: "theirs", tenantId: "other-company", text: "8D报告流程说明" }),
		]);
		const hits = await retriever.search(member(), { query: "8D报告" });
		expect(hits).toEqual([]);
	});

	it("平台管理员也不能跨租户召回", async () => {
		const retriever = new KeywordRetriever([chunk({ tenantId: "t2" })]);
		const hits = await retriever.search(member({ role: Role.PlatformAdmin }), { query: "8D报告" });
		expect(hits).toEqual([]);
	});

	it("多租户混合数据下只返回本租户内容", async () => {
		const chunks: Chunk[] = [];
		for (const tenant of ["t1", "t2", "t3"]) {
			for (let i = 0; i < 5; i++) {
				chunks.push(chunk({ id: `${tenant}-${i}`, tenantId: tenant, text: "安全检查记录表" }));
			}
		}
		const hits = await new KeywordRetriever(chunks).search(member(), {
			query: "安全检查",
			limit: 100,
		});
		expect(hits).toHaveLength(5);
		expect(hits.every((h) => h.chunk.tenantId === "t1")).toBe(true);
	});
});

describe("检索 · 工作区与个人隔离", () => {
	it("其他工作区的工作区级片段不召回", async () => {
		const retriever = new KeywordRetriever([
			chunk({ id: "mine", workspaceId: "w1" }),
			chunk({ id: "other-ws", workspaceId: "w2" }),
		]);
		const hits = await retriever.search(member(), { query: "8D报告" });
		expect(hits.map((h) => h.chunk.id)).toEqual(["mine"]);
	});

	it("租户级共享的片段可跨工作区召回", async () => {
		const retriever = new KeywordRetriever([
			chunk({ id: "shared", workspaceId: "w2", scope: Scope.Tenant }),
		]);
		const hits = await retriever.search(member(), { query: "8D报告" });
		expect(hits.map((h) => h.chunk.id)).toEqual(["shared"]);
	});

	it("他人的个人私有片段不召回", async () => {
		const retriever = new KeywordRetriever([
			chunk({ id: "private", ownerId: "u2", scope: Scope.Personal }),
		]);
		const hits = await retriever.search(member(), { query: "8D报告" });
		expect(hits).toEqual([]);
	});

	it("自己的个人私有片段可召回", async () => {
		const retriever = new KeywordRetriever([
			chunk({ id: "mine", ownerId: "u1", scope: Scope.Personal }),
		]);
		const hits = await retriever.search(member(), { query: "8D报告" });
		expect(hits.map((h) => h.chunk.id)).toEqual(["mine"]);
	});
});

describe("检索 · 切词", () => {
	it("中英数混排的行业术语被正确切分", () => {
		// 分词库常把「8D报告」切成「8」「D」「报告」而丢语义
		const terms = tokenize("8D报告");
		expect(terms).toContain("8d");
		expect(terms).toContain("报");
		expect(terms).toContain("告");
	});

	it("体系标准编号被当成整体", () => {
		expect(tokenize("IATF16949")).toContain("iatf16949");
	});

	it("去重", () => {
		const terms = tokenize("报告报告报告");
		expect(terms.filter((t) => t === "报")).toHaveLength(1);
	});

	it("忽略标点与空白", () => {
		const terms = tokenize("质量，安全。");
		expect(terms).not.toContain("，");
		expect(terms).not.toContain(" ");
	});
});

describe("检索 · 相关度与排序", () => {
	it("覆盖更多查询词的片段排在前面", async () => {
		const retriever = new KeywordRetriever([
			chunk({ id: "partial", text: "关于质量的说明" }),
			chunk({ id: "full", text: "质量安全检查表" }),
		]);
		const hits = await retriever.search(member(), { query: "质量安全" });
		expect(hits[0]?.chunk.id).toBe("full");
	});

	it("完全不匹配的片段不返回", async () => {
		const retriever = new KeywordRetriever([chunk({ text: "完全无关的内容" })]);
		const hits = await retriever.search(member(), { query: "xyz" });
		expect(hits).toEqual([]);
	});

	it("limit 生效", async () => {
		const chunks = Array.from({ length: 20 }, (_, i) =>
			chunk({ id: `c${i}`, text: "质量管理体系文件" }),
		);
		const hits = await new KeywordRetriever(chunks).search(member(), {
			query: "质量",
			limit: 3,
		});
		expect(hits).toHaveLength(3);
	});

	it("minScore 过滤低相关命中（宁缺勿滥）", async () => {
		const retriever = new KeywordRetriever([chunk({ text: "质量" })]);
		// 查询词多但只命中一个 → 覆盖率低
		const loose = await retriever.search(member(), { query: "质量安全环境健康管理体系" });
		const strict = await retriever.search(member(), {
			query: "质量安全环境健康管理体系",
			minScore: 0.9,
		});
		expect(loose.length).toBeGreaterThan(0);
		expect(strict).toEqual([]);
	});

	it("空查询返回空结果而非全部", async () => {
		// 常见 bug：空查询退化成「返回所有文档」
		const retriever = new KeywordRetriever([chunk(), chunk({ id: "c2" })]);
		expect(await retriever.search(member(), { query: "" })).toEqual([]);
		expect(await retriever.search(member(), { query: "   " })).toEqual([]);
	});
});

describe("检索 · 知识库范围限定", () => {
	it("限定知识库时只搜指定的", async () => {
		const retriever = new KeywordRetriever([
			chunk({ id: "in-kb1", knowledgeBaseId: "kb1" }),
			chunk({ id: "in-kb2", knowledgeBaseId: "kb2" }),
		]);
		const hits = await retriever.search(member(), {
			query: "8D报告",
			knowledgeBaseIds: ["kb2"],
		});
		expect(hits.map((h) => h.chunk.id)).toEqual(["in-kb2"]);
	});

	it("限定不存在的知识库返回空", async () => {
		const retriever = new KeywordRetriever([chunk()]);
		const hits = await retriever.search(member(), {
			query: "8D报告",
			knowledgeBaseIds: ["nonexistent"],
		});
		expect(hits).toEqual([]);
	});

	it("知识库限定不能绕过租户隔离", async () => {
		// 攻击路径：知道别家的 kb id 后直接指定它
		const retriever = new KeywordRetriever([
			chunk({ id: "theirs", tenantId: "t2", knowledgeBaseId: "their-kb" }),
		]);
		const hits = await retriever.search(member(), {
			query: "8D报告",
			knowledgeBaseIds: ["their-kb"],
		});
		expect(hits).toEqual([]);
	});
});

describe("检索 · 来源标注（验收要求）", () => {
	it("格式化结果含文档名与位置", async () => {
		const retriever = new KeywordRetriever([
			chunk({ documentName: "IATF16949体系文件.docx", position: 42 }),
		]);
		const hits = await retriever.search(member(), { query: "8D报告" });
		const text = formatCitations(hits);

		expect(text).toContain("IATF16949体系文件.docx");
		expect(text).toContain("42");
		// 有编号，便于模型在产出里引用
		expect(text).toContain("[1]");
	});

	it("无命中时返回空字符串（不注入无意义内容）", () => {
		expect(formatCitations([])).toBe("");
	});

	it("citationsOf 提取溯源信息", async () => {
		const retriever = new KeywordRetriever([chunk({ id: "c1", documentId: "d1" })]);
		const hits = await retriever.search(member(), { query: "8D报告" });
		const citations = citationsOf(hits);

		expect(citations).toEqual([
			{ chunkId: "c1", documentId: "d1", documentName: "质量手册.docx", position: 1 },
		]);
	});
});
