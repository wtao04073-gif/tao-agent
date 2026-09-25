/**
 * 文档切分测试
 *
 * 切分是检索质量的真正瓶颈 —— 切错了再好的算法也召回不到。
 *
 * 断言重点有两处：
 *  1. **标题边界**：条款不能被切开，标题路径不能串
 *  2. **归属注入**：漏一个字段就意味着权限判定出错，这是安全问题
 */

import { describe, expect, it } from "vitest";
import {
	chunkDocument,
	describeChunkSource,
	ingestDocument,
	toChunks,
	type IngestContext,
	type SourceParagraph,
} from "../src/chunking.ts";
import { KeywordRetriever } from "../src/retrieval.ts";
import { Role, Scope } from "../src/tenant.ts";
import type { Membership } from "../src/access.ts";

const CONTEXT: IngestContext = {
	tenantId: "t1",
	workspaceId: "w1",
	ownerId: "u1",
	scope: Scope.Workspace,
	knowledgeBaseId: "kb1",
	documentId: "doc-1",
	documentName: "质量手册.docx",
};

/** 造一份结构接近真实体系文件的文档。 */
const MANUAL: SourceParagraph[] = [
	{ index: 1, text: "第五章 测量、分析和改进", isHeading: true, headingLevel: 1 },
	{ index: 2, text: "本章规定公司测量与改进活动的要求。", isHeading: false, headingLevel: null },
	{ index: 3, text: "5.1 监视和测量", isHeading: true, headingLevel: 2 },
	{ index: 4, text: "各部门应按检验规范实施过程监视。", isHeading: false, headingLevel: null },
	{ index: 5, text: "5.2 不合格品控制", isHeading: true, headingLevel: 2 },
	{
		index: 6,
		text: "发现不合格品时应立即标识并隔离，由质量部判定处置方式。",
		isHeading: false,
		headingLevel: null,
	},
	{ index: 7, text: "处置方式包括返工、返修、让步接收、报废。", isHeading: false, headingLevel: null },
	{ index: 8, text: "第六章 内部审核", isHeading: true, headingLevel: 1 },
	{ index: 9, text: "内审每年至少一次，覆盖全部过程。", isHeading: false, headingLevel: null },
];

describe("切分 · 按标题边界", () => {
	it("每个条款独立成片段", () => {
		const chunks = chunkDocument(MANUAL);
		// 4 个标题 → 各自的内容成片段（第五章自己也有一段引言）
		expect(chunks.length).toBeGreaterThanOrEqual(4);

		const texts = chunks.map((c) => c.text);
		expect(texts.some((t) => t.includes("立即标识并隔离"))).toBe(true);
		expect(texts.some((t) => t.includes("内审每年至少一次"))).toBe(true);
	});

	it("条款内容不被切开", () => {
		// 5.2 的两段正文属于同一条款，必须在同一片段里 ——
		// 用户查「不合格品怎么处置」要的是完整的一条
		const chunks = chunkDocument(MANUAL);
		const target = chunks.find((c) => c.text.includes("立即标识并隔离"));
		expect(target?.text).toContain("返工、返修、让步接收、报废");
	});

	it("标题路径层级正确", () => {
		const chunks = chunkDocument(MANUAL);
		const target = chunks.find((c) => c.text.includes("立即标识并隔离"));
		expect(target?.headingPath).toEqual(["第五章 测量、分析和改进", "5.2 不合格品控制"]);
	});

	it("同级标题替换而非累积", () => {
		// 5.1 与 5.2 是同级，5.2 的路径里不能还带着 5.1
		const chunks = chunkDocument(MANUAL);
		const target = chunks.find((c) => c.text.includes("立即标识并隔离"));
		expect(target?.headingPath).not.toContain("5.1 监视和测量");
	});

	it("一级标题重置二级路径", () => {
		// 进入第六章后，5.2 不应残留在路径里
		const chunks = chunkDocument(MANUAL);
		const target = chunks.find((c) => c.text.includes("内审每年至少一次"));
		expect(target?.headingPath).toEqual(["第六章 内部审核"]);
	});

	it("标题不带上一条的重叠内容（防归属混乱）", () => {
		// 若上一条的尾巴混进下一条，检索结果会显示错误的出处 ——
		// 明明命中 5.2 却标成 5.1
		const chunks = chunkDocument(MANUAL, { overlapParagraphs: 2 });
		const target = chunks.find((c) => c.headingPath.includes("5.2 不合格品控制"));
		expect(target?.text).not.toContain("各部门应按检验规范实施过程监视");
	});

	it("记录起止段落序号（溯源 locator）", () => {
		const chunks = chunkDocument(MANUAL);
		const target = chunks.find((c) => c.text.includes("立即标识并隔离"));
		expect(target?.startParagraph).toBe(6);
		expect(target?.endParagraph).toBe(7);
	});

	it("超长条款被切开但保留同一标题路径", () => {
		const long: SourceParagraph[] = [
			{ index: 1, text: "第十条 培训管理", isHeading: true, headingLevel: 1 },
			...Array.from({ length: 10 }, (_, i) => ({
				index: i + 2,
				text: "培训要求".repeat(50), // 每段 200 字
				isHeading: false,
				headingLevel: null,
			})),
		];
		const chunks = chunkDocument(long, { maxChars: 400 });

		expect(chunks.length).toBeGreaterThan(1);
		// 切开后每片段仍知道自己属于第十条
		for (const chunk of chunks) {
			expect(chunk.headingPath).toEqual(["第十条 培训管理"]);
		}
	});

	it("文档开头没有标题的内容也被保留", () => {
		const noHeading: SourceParagraph[] = [
			{ index: 1, text: "本文件适用于全公司。", isHeading: false, headingLevel: null },
			{ index: 2, text: "第一章 总则", isHeading: true, headingLevel: 1 },
			{ index: 3, text: "总则内容。", isHeading: false, headingLevel: null },
		];
		const chunks = chunkDocument(noHeading);
		expect(chunks.some((c) => c.text.includes("本文件适用于全公司"))).toBe(true);
	});

	it("空文档返回空，不报错", () => {
		expect(chunkDocument([])).toEqual([]);
	});

	it("只有标题没有正文时不产生空片段", () => {
		const onlyHeadings: SourceParagraph[] = [
			{ index: 1, text: "第一章", isHeading: true, headingLevel: 1 },
			{ index: 2, text: "第二章", isHeading: true, headingLevel: 2 },
		];
		// 空片段进了知识库就是噪声，检索时白占名额
		expect(chunkDocument(onlyHeadings)).toEqual([]);
	});

	it("空白段落不产生片段", () => {
		const blank: SourceParagraph[] = [
			{ index: 1, text: "第一章", isHeading: true, headingLevel: 1 },
			{ index: 2, text: "   ", isHeading: false, headingLevel: null },
		];
		expect(chunkDocument(blank)).toEqual([]);
	});
});

describe("入库 · 归属信息注入（安全要害）", () => {
	it("每个片段都带齐归属字段", () => {
		const chunks = ingestDocument(MANUAL, CONTEXT);
		expect(chunks.length).toBeGreaterThan(0);

		for (const chunk of chunks) {
			// 漏任何一个都会让权限判定出错
			expect(chunk.tenantId).toBe("t1");
			expect(chunk.workspaceId).toBe("w1");
			expect(chunk.ownerId).toBe("u1");
			expect(chunk.scope).toBe(Scope.Workspace);
			expect(chunk.knowledgeBaseId).toBe("kb1");
			expect(chunk.documentId).toBe("doc-1");
			expect(chunk.documentName).toBe("质量手册.docx");
		}
	});

	it("片段 id 唯一", () => {
		const chunks = ingestDocument(MANUAL, CONTEXT);
		const ids = chunks.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("position 是原文段落序号，可用于跳转原文", () => {
		const chunks = ingestDocument(MANUAL, CONTEXT);
		const target = chunks.find((c) => c.text.includes("立即标识并隔离"));
		expect(target?.position).toBe(6);
	});

	it("标题路径拼进正文，提升标题词查询的相关度", async () => {
		// 这条断言的措辞与构造方式都经过修正，两次都是变异测试逼出来的：
		//
		// ① 最初写「只在标题里的词也能检索到」—— 假通过。中文按**单字**切分
		//    （见 tokenize），「内部审核」拆成 内/部/审/核，正文
		//    「内审每年…覆盖全部过程」本身就含 内/审/部，不拼标题也能部分命中。
		//    按字切分让「某词只出现在标题里」这个概念在中文里几乎不成立。
		//
		// ② 改成比较两组分数后仍然假通过 —— 因为对照组也是用 toChunks 构造的，
		//    变异后两组同时退化成一样的东西，分数自然相等。
		//
		// 所以这里用**固定期望值**而非动态对照组：不拼标题时最高分是 0.429
		// （查询 7 字里命中 3 字），拼了标题后应显著更高。
		const chunks = ingestDocument(MANUAL, CONTEXT);
		const member: Membership = {
			tenantId: "t1",
			workspaceId: "w1",
			userId: "u1",
			role: Role.Member,
		};

		const hits = await new KeywordRetriever(chunks).search(member, { query: "第六章内部审核" });

		expect(hits[0]?.chunk.text).toContain("内审每年至少一次");
		// 标题拼进正文后查询词被完整覆盖 → 接近满分；
		// 不拼的话只能命中正文里恰好重合的几个字（约 0.43）
		expect(hits[0]?.score).toBeGreaterThan(0.8);
	});

	it("入库后立刻受租户隔离保护", async () => {
		const chunks = ingestDocument(MANUAL, CONTEXT);
		const retriever = new KeywordRetriever(chunks);

		const outsider: Membership = {
			tenantId: "other-company",
			workspaceId: "w1",
			userId: "x",
			role: Role.TenantAdmin,
		};
		expect(await retriever.search(outsider, { query: "不合格品" })).toEqual([]);
	});

	it("不同文档的片段 id 不冲突", () => {
		const a = ingestDocument(MANUAL, CONTEXT);
		const b = ingestDocument(MANUAL, { ...CONTEXT, documentId: "doc-2" });
		const all = new Set([...a, ...b].map((c) => c.id));
		expect(all.size).toBe(a.length + b.length);
	});

	it("toChunks 与 ingestDocument 结果一致", () => {
		const viaTwoSteps = toChunks(chunkDocument(MANUAL), CONTEXT);
		expect(ingestDocument(MANUAL, CONTEXT)).toEqual(viaTwoSteps);
	});
});

describe("来源描述", () => {
	it("含文档名与段落位置", () => {
		const chunk = ingestDocument(MANUAL, CONTEXT)[0];
		expect(chunk).toBeDefined();
		const text = describeChunkSource(chunk!, ["第五章 测量、分析和改进"]);
		expect(text).toContain("质量手册.docx");
		expect(text).toContain("第五章");
	});

	it("无标题路径时只给段落位置", () => {
		const chunk = ingestDocument(MANUAL, CONTEXT)[0];
		const text = describeChunkSource(chunk!);
		expect(text).toContain("质量手册.docx");
		expect(text).toMatch(/第 \d+ 段/);
	});
});
