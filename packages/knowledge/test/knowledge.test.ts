/**
 * 知识库工具测试
 *
 * 最高优先级的两组：
 *
 *  1. **跨租户不召回** —— RAG 系统最典型的泄漏方式，且极隐蔽：
 *     产出看起来正常，只是内容里混进了别家的数据。
 *  2. **跨租户不删除** —— 较少被想到的一面。若删除只按 documentId 匹配，
 *     A 租户就能删掉 B 租户的同名文档，这是跨租户**写入**漏洞。
 *
 * 另有一组验证「身份不从模型参数取」：这是整个设计的要害，
 * 若让模型传租户 id，越狱提示就能读别家知识库。
 */

import { describe, expect, it } from "vitest";
import {
	ingestDocument,
	Role,
	Scope,
	type IngestContext,
	type Membership,
	type PlatformTool,
	type SourceParagraph,
} from "@tao/core";
import { createKnowledgeToolset, ingestIntoStore, KNOWLEDGE_TOOL_POLICIES } from "../src/toolset.ts";
import { MemoryKnowledgeStore } from "../src/memory-store.ts";

const member = (over: Partial<Membership> = {}): Membership => ({
	tenantId: "t1",
	workspaceId: "w1",
	userId: "u1",
	role: Role.Member,
	...over,
});

const context = (over: Partial<IngestContext> = {}): IngestContext => ({
	tenantId: "t1",
	workspaceId: "w1",
	ownerId: "u1",
	scope: Scope.Workspace,
	knowledgeBaseId: "kb1",
	documentId: "doc-1",
	documentName: "质量手册.docx",
	...over,
});

const MANUAL: SourceParagraph[] = [
	{ index: 1, text: "5.2 不合格品控制", isHeading: true, headingLevel: 1 },
	{
		index: 2,
		text: "发现不合格品时应立即标识并隔离，由质量部判定处置方式。",
		isHeading: false,
		headingLevel: null,
	},
];

/** 取出 search_knowledge 工具。 */
function searchTool(store: MemoryKnowledgeStore, membership: Membership): PlatformTool {
	const tools = createKnowledgeToolset({ store, membership });
	const tool = tools.find((t) => t.name === "search_knowledge");
	if (tool === undefined) throw new Error("search_knowledge 未注册");
	return tool;
}

/** 调用工具。模拟内核的调用方式。 */
async function call(tool: PlatformTool, args: Record<string, unknown>) {
	return tool.execute({
		args,
		tenant: { tenantId: "t1", workspaceId: "w1", userId: "u1" },
		taskId: "task-1",
		report: () => {},
		signal: new AbortController().signal,
	});
}

describe("知识库 · 跨租户绝不召回（最高优先级）", () => {
	it("只返回本租户内容", async () => {
		const store = new MemoryKnowledgeStore();
		await store.add(ingestDocument(MANUAL, context()));
		await store.add(ingestDocument(MANUAL, context({ tenantId: "t2", documentId: "d2" })));

		const result = await call(searchTool(store, member()), { query: "不合格品" });
		const citations = (result.details as { citations: Array<{ documentId: string }> }).citations;

		expect(citations).toHaveLength(1);
		expect(citations[0]?.documentId).toBe("doc-1");
	});

	it("内容完全相同也不跨租户召回", async () => {
		// 内容相同时最容易「看起来没问题」
		const store = new MemoryKnowledgeStore();
		await store.add(ingestDocument(MANUAL, context({ tenantId: "other-company" })));

		const result = await call(searchTool(store, member()), { query: "不合格品" });
		expect((result.details as { hits: number }).hits).toBe(0);
	});

	it("平台管理员也不能跨租户召回", async () => {
		const store = new MemoryKnowledgeStore();
		await store.add(ingestDocument(MANUAL, context({ tenantId: "t2" })));

		const result = await call(searchTool(store, member({ role: Role.PlatformAdmin })), {
			query: "不合格品",
		});
		expect((result.details as { hits: number }).hits).toBe(0);
	});

	it("模型指定别家知识库 id 也无效", async () => {
		// 攻击路径：知道别家的 kb id 后直接指定它
		const store = new MemoryKnowledgeStore();
		await store.add(
			ingestDocument(MANUAL, context({ tenantId: "t2", knowledgeBaseId: "their-kb" })),
		);

		const result = await call(searchTool(store, member()), {
			query: "不合格品",
			knowledgeBaseIds: ["their-kb"],
		});
		expect((result.details as { hits: number }).hits).toBe(0);
	});

	it("身份来自平台注入，工具参数无法覆盖", async () => {
		// 这是整个设计的要害。工具的 parameters schema 里根本没有租户字段，
		// 就算模型硬塞一个也不会被读取
		const store = new MemoryKnowledgeStore();
		await store.add(ingestDocument(MANUAL, context({ tenantId: "t2" })));

		const tool = searchTool(store, member()); // 注入的是 t1
		const result = await call(tool, {
			query: "不合格品",
			// 模型尝试伪造身份
			tenantId: "t2",
			membership: { tenantId: "t2", workspaceId: "w1", userId: "x", role: "tenant_admin" },
		});

		expect((result.details as { hits: number }).hits).toBe(0);
		// schema 里没有这些字段，确认它们不是被「接受但忽略」，而是根本不存在
		const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
		expect(Object.keys(props)).toEqual(["query", "limit", "knowledgeBaseIds"]);
	});

	it("多租户混合数据下只返回本租户", async () => {
		const store = new MemoryKnowledgeStore();
		for (const tenantId of ["t1", "t2", "t3"]) {
			await store.add(
				ingestDocument(MANUAL, context({ tenantId, documentId: `doc-${tenantId}` })),
			);
		}

		const result = await call(searchTool(store, member()), { query: "不合格品", limit: 100 });
		const citations = (result.details as { citations: Array<{ documentId: string }> }).citations;
		expect(citations.every((c) => c.documentId === "doc-t1")).toBe(true);
	});
});

describe("知识库 · 跨租户不删除（跨租户写入漏洞）", () => {
	it("删除只影响本租户的同名文档", async () => {
		// 若删除只按 documentId 匹配，A 租户就能删掉 B 租户的文档。
		// documentId 若来自文件名，这就是个真实可利用的漏洞。
		const store = new MemoryKnowledgeStore();
		await store.add(ingestDocument(MANUAL, context({ tenantId: "t1" })));
		await store.add(ingestDocument(MANUAL, context({ tenantId: "t2" })));
		const before = store.size;

		const removed = await store.removeDocument("t1", "doc-1");

		expect(removed).toBeGreaterThan(0);
		// t2 的片段还在
		expect(store.size).toBe(before - removed);
		const survivors = await call(searchTool(store, member({ tenantId: "t2" })), {
			query: "不合格品",
		});
		expect((survivors.details as { hits: number }).hits).toBeGreaterThan(0);
	});

	it("删除不存在的文档返回 0，不报错", async () => {
		const store = new MemoryKnowledgeStore();
		expect(await store.removeDocument("t1", "nonexistent")).toBe(0);
	});
});

describe("知识库 · 入库", () => {
	it("入库后可检索到", async () => {
		const store = new MemoryKnowledgeStore();
		const result = await ingestIntoStore(store, MANUAL, context());

		expect(result.chunks).toBeGreaterThan(0);
		const hits = await call(searchTool(store, member()), { query: "不合格品" });
		expect((hits.details as { hits: number }).hits).toBeGreaterThan(0);
	});

	it("重复入库同一文档不会召回两版（先删后加）", async () => {
		// 文档更新后若不删旧片段，会同时召回新旧两版，
		// 用户拿到自相矛盾的引用却不知道原因
		const store = new MemoryKnowledgeStore();
		await ingestIntoStore(store, MANUAL, context());
		const afterFirst = store.size;

		const revised: SourceParagraph[] = [
			{ index: 1, text: "5.2 不合格品控制", isHeading: true, headingLevel: 1 },
			{
				index: 2,
				text: "发现不合格品时应立即标识并隔离，处置方式由质量部与工艺部联合判定。",
				isHeading: false,
				headingLevel: null,
			},
		];
		await ingestIntoStore(store, revised, context());

		// 片段数没有翻倍
		expect(store.size).toBe(afterFirst);

		// 召回的是新版内容
		const hits = await call(searchTool(store, member()), { query: "处置方式" });
		expect(hits.text).toContain("联合判定");
		expect(hits.text).not.toContain("由质量部判定处置方式。");
	});

	it("不同租户的同名文档互不影响", async () => {
		const store = new MemoryKnowledgeStore();
		await ingestIntoStore(store, MANUAL, context({ tenantId: "t1" }));
		await ingestIntoStore(store, MANUAL, context({ tenantId: "t2" }));

		// 两家各自都能检索到自己的
		for (const tenantId of ["t1", "t2"]) {
			const hits = await call(searchTool(store, member({ tenantId })), { query: "不合格品" });
			expect((hits.details as { hits: number }).hits, tenantId).toBeGreaterThan(0);
		}
	});
});

describe("知识库 · 检索结果的可用性", () => {
	it("结果带来源标注（验收要求）", async () => {
		const store = new MemoryKnowledgeStore();
		await store.add(
			ingestDocument(MANUAL, context({ documentName: "IATF16949体系文件.docx" })),
		);

		const result = await call(searchTool(store, member()), { query: "不合格品" });
		expect(result.text).toContain("IATF16949体系文件.docx");
		// 有编号，便于模型在产出里引用
		expect(result.text).toContain("[1]");
		expect(result.text).toContain("引用时请标注来源编号");
	});

	it("无命中时明确告知，并提示不要凭记忆编写", async () => {
		// 返回空字符串会让模型自行想象制度内容 —— 这是最危险的幻觉场景，
		// 编造出来的「制度规定」会被用户当真写进正式文件
		const store = new MemoryKnowledgeStore();
		const result = await call(searchTool(store, member()), { query: "完全不存在的东西" });

		expect(result.text).toContain("未找到");
		expect(result.text).toContain("不要凭记忆编写");
		expect((result.details as { hits: number }).hits).toBe(0);
	});

	it("details 里带溯源信息", async () => {
		const store = new MemoryKnowledgeStore();
		await store.add(ingestDocument(MANUAL, context()));

		const result = await call(searchTool(store, member()), { query: "不合格品" });
		const citations = (
			result.details as {
				citations: Array<{ chunkId: string; documentId: string; documentName: string; position: number }>;
			}
		).citations;

		expect(citations[0]?.documentId).toBe("doc-1");
		expect(citations[0]?.documentName).toBe("质量手册.docx");
		expect(typeof citations[0]?.position).toBe("number");
	});

	it("limit 被钳制在上限内", async () => {
		// 给模型太多召回结果反而干扰判断
		const store = new MemoryKnowledgeStore();
		for (let i = 0; i < 30; i++) {
			await store.add(ingestDocument(MANUAL, context({ documentId: `doc-${i}` })));
		}

		const result = await call(searchTool(store, member()), { query: "不合格品", limit: 999 });
		expect((result.details as { hits: number }).hits).toBeLessThanOrEqual(6);
	});

	it("默认知识库范围生效", async () => {
		const store = new MemoryKnowledgeStore();
		await store.add(ingestDocument(MANUAL, context({ knowledgeBaseId: "kb1" })));
		await store.add(
			ingestDocument(MANUAL, context({ knowledgeBaseId: "kb2", documentId: "doc-2" })),
		);

		const tools = createKnowledgeToolset({
			store,
			membership: member(),
			defaultKnowledgeBaseIds: ["kb2"],
		});
		const result = await call(tools[0]!, { query: "不合格品" });
		const citations = (result.details as { citations: Array<{ documentId: string }> }).citations;

		expect(citations.every((c) => c.documentId === "doc-2")).toBe(true);
	});
});

describe("知识库 · 统计与权限", () => {
	it("统计只算本租户可见的片段", async () => {
		// 否则通过「某知识库有多少片段」能推断别家有多少文档
		const store = new MemoryKnowledgeStore();
		await store.add(ingestDocument(MANUAL, context({ tenantId: "t1" })));
		await store.add(ingestDocument(MANUAL, context({ tenantId: "t2" })));

		const stats = await store.stats(member());
		const total = stats.reduce((sum, s) => sum + s.chunks, 0);
		expect(total).toBeLessThan(store.size);
	});

	it("他人的个人私有文档不计入统计", async () => {
		const store = new MemoryKnowledgeStore();
		await store.add(
			ingestDocument(MANUAL, context({ ownerId: "u2", scope: Scope.Personal })),
		);
		expect(await store.stats(member())).toEqual([]);
	});
});

describe("知识库 · 工具注册", () => {
	it("工具名与权限策略一致", () => {
		const tools = createKnowledgeToolset({
			store: new MemoryKnowledgeStore(),
			membership: member(),
		});
		const names = tools.map((t) => t.name);
		for (const policy of KNOWLEDGE_TOOL_POLICIES) {
			expect(names).toContain(policy.tool);
		}
	});

	it("检索工具标为可安全重放", () => {
		// 只读工具重放安全；标错会导致崩溃恢复时跳过必要的检索
		const tools = createKnowledgeToolset({
			store: new MemoryKnowledgeStore(),
			membership: member(),
		});
		expect(tools[0]?.replay).toBe("safe");
	});

	it("入库不作为工具暴露给模型", () => {
		// 入库是管理动作，不该由 Agent 在任务执行中自行决定往知识库里写
		const tools = createKnowledgeToolset({
			store: new MemoryKnowledgeStore(),
			membership: member(),
		});
		expect(tools.map((t) => t.name)).toEqual(["search_knowledge"]);
	});
});
