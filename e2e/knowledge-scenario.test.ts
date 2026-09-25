/**
 * M3-2 验收：知识库场景端到端
 *
 * 验 M2/M3-1 遗留的最后 4 张卡（体系文件、评估自评报告、通知公文、项目申报书），
 * 它们的共同点是**必须引用本单位已有材料**——这正是通用 Chatbot 做不到的事，
 * 也是产品的核心差异化。
 *
 * 最关键的一条断言不是「能跑通」，而是**跨租户不串**：在同一个知识库存储里
 * 放两家公司的制度文件，验证 A 家的任务产出里不出现 B 家的内容。
 * 这种泄漏极隐蔽 —— 产出看起来正常，只是内容里混进了别家的数据。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../vendor/pi/agent/src/harness/session/session.ts";
import {
	activateableTools,
	compilePrompt,
	createPermissionGate,
	isFullyImplemented,
	PRESET_CARDS,
	ProvenanceBuilder,
	resolveCard,
	restrictPolicies,
	Role,
	Scope,
	SourceKind,
	TaskStatus,
	validateProvenance,
	type AuditEntry,
	type IngestContext,
	type Membership,
	type ScenarioCard,
	type SourceParagraph,
} from "@tao/core";
import {
	createDocToolset,
	createOfficeToolset,
	DOC_TOOL_POLICIES,
	OFFICE_TOOL_POLICIES,
	readDocx,
	validateDocx,
} from "@tao/office";
import {
	createKnowledgeToolset,
	ingestIntoStore,
	KNOWLEDGE_TOOL_POLICIES,
	MemoryKnowledgeStore,
} from "@tao/knowledge";
import { InProcessRunnerFactory } from "@tao/agent-host";
import { TaskOrchestrator } from "@tao/orchestrator";
import { afterEach, describe, expect, it } from "vitest";

const TENANT = { tenantId: "univ-001", workspaceId: "academic", userId: "zhao" };
const MEMBER: Membership = {
	tenantId: "univ-001",
	workspaceId: "academic",
	userId: "zhao",
	role: Role.Member,
};

const dirs: string[] = [];
const sessions: StorageBackedSession[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "m3b-e2e-"));
	dirs.push(dir);
	return dir;
}

/** 本单位的制度文件。 */
const OUR_POLICY: SourceParagraph[] = [
	{ index: 1, text: "第三章 实验室安全管理", isHeading: true, headingLevel: 1 },
	{
		index: 2,
		text: "实验室实行准入制度，学生须完成安全培训并考核合格后方可进入。",
		isHeading: false,
		headingLevel: null,
	},
	{ index: 3, text: "3.2 危险化学品管理", isHeading: true, headingLevel: 2 },
	{
		index: 4,
		text: "危险化学品须双人双锁保管，领用登记由实验室负责人审批。",
		isHeading: false,
		headingLevel: null,
	},
];

/** 另一家单位的制度文件，内容刻意与我方相似。 */
const OTHER_POLICY: SourceParagraph[] = [
	{ index: 1, text: "第三章 实验室安全管理", isHeading: true, headingLevel: 1 },
	{
		index: 2,
		text: "实验室由保卫处统一管理，进入须刷卡并全程录像监控。",
		isHeading: false,
		headingLevel: null,
	},
];

function ingestContext(over: Partial<IngestContext> = {}): IngestContext {
	return {
		tenantId: TENANT.tenantId,
		workspaceId: TENANT.workspaceId,
		ownerId: TENANT.userId,
		scope: Scope.Tenant,
		knowledgeBaseId: "kb-policy",
		documentId: "policy-1",
		documentName: "实验室安全管理办法.docx",
		...over,
	};
}

async function assemble(ws: string, store: MemoryKnowledgeStore, membership = MEMBER) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const audit: AuditEntry[] = [];

	const factory = new InProcessRunnerFactory({
		async createSession(sessionId) {
			const session = new StorageBackedSession(
				{ id: sessionId, createdAt: 1, storageVersion: 1 },
				new MemoryStorage(),
			);
			sessions.push(session);
			return session;
		},
		models,
		model: faux.getModel(),
		now: () => 1_700_000_000_000,
	});

	const orchestrator = new TaskOrchestrator(factory, { now: () => 1_700_000_000_000 });
	const tools = [
		...createOfficeToolset({ workspace: ws, now: () => new Date("2026-09-25T10:00:00Z") }),
		...createDocToolset({ workspace: ws }),
		// 身份由平台注入，不经模型
		...createKnowledgeToolset({ store, membership }),
	];
	const allPolicies = [
		...OFFICE_TOOL_POLICIES,
		...DOC_TOOL_POLICIES,
		...KNOWLEDGE_TOOL_POLICIES,
	];

	return { orchestrator, faux, tools, allPolicies, audit };
}

function gateFor(
	card: ScenarioCard,
	allPolicies: readonly { tool: string; pathParams?: readonly string[] }[],
	ws: string,
	audit: AuditEntry[],
) {
	return createPermissionGate({
		policies: restrictPolicies(allPolicies, card.tools),
		workspace: ws,
		audit: (entry) => void audit.push(entry),
	});
}

describe("M3-2 验收 · 知识库场景端到端", () => {
	afterEach(async () => {
		for (const s of sessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("十张场景卡全部可跑到产出", () => {
		// M3 的一个里程碑：M2 交付时 2 张，M3-1 后 6 张，M3-2 后全部
		const runnable = PRESET_CARDS.filter((c) => isFullyImplemented([...c.tools]));
		expect(runnable).toHaveLength(10);
	});

	it("起草通知公文：检索本单位制度 → 生成公文 → 引用带来源", async () => {
		const ws = workspace();
		const store = new MemoryKnowledgeStore();
		await ingestIntoStore(store, OUR_POLICY, ingestContext());

		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws, store);
		const card = resolveCard(PRESET_CARDS, "univ.official-notice", TENANT.tenantId) as ScenarioCard;

		const prompt = compilePrompt(card, {
			docType: "通知",
			subject: "关于加强实验室安全管理的通知，面向各学院，要求本月内完成安全培训",
			issuer: "实验室与设备管理处",
		});

		faux.setResponses([
			// 先查本单位已有制度，统一口径
			fauxAssistantMessage([
				fauxToolCall("search_knowledge", { query: "实验室安全准入制度" }),
			]),
			fauxAssistantMessage([
				fauxToolCall("write_document", {
					title: "关于加强实验室安全管理的通知",
					outputName: "安全管理通知.docx",
					blocks: [
						{ type: "paragraph", text: "各学院：", align: "left" },
						{
							type: "paragraph",
							text: "根据《实验室安全管理办法》第三章规定，实验室实行准入制度，学生须完成安全培训并考核合格后方可进入。现就加强实验室安全管理通知如下。",
						},
						{ type: "heading", level: 1, text: "一、工作要求" },
						{
							type: "numbered_list",
							items: [
								"各学院于本月内组织学生完成安全培训与考核",
								"危险化学品按办法 3.2 条实行双人双锁保管",
							],
						},
						{ type: "paragraph", text: "实验室与设备管理处", align: "right" },
						{ type: "paragraph", text: "[成文日期]", align: "right" },
					],
				}),
			]),
			fauxAssistantMessage("通知已起草，引用了本单位《实验室安全管理办法》相关条款。"),
		]);

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3b-notice",
			sessionId: "m3b-s-notice",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		expect((await orchestrator.run("m3b-notice", prompt)).status).toBe(TaskStatus.Succeeded);

		// —— 产物 ——
		const out = join(ws, "安全管理通知.docx");
		expect(existsSync(out)).toBe(true);
		expect((await validateDocx(out)).ok).toBe(true);

		const content = (await readDocx(out)).paragraphs.map((p) => p.text).join("\n");
		// 沿用了本单位制度的原话，不是模型自己编的口径
		expect(content).toContain("完成安全培训并考核合格后方可进入");
		expect(content).toContain("双人双锁");
		// 未提供的信息用占位而非编造
		expect(content).toContain("[成文日期]");

		// —— 检索被放行且真的执行了 ——
		const searches = audit.filter((a) => a.tool === "search_knowledge");
		expect(searches).toHaveLength(1);
		expect(searches[0]?.decision).toBe("allowed");
	});

	it("跨租户不串：另一家的制度不会出现在我方产出里（最高优先级）", async () => {
		// 同一个存储里放两家的制度，内容刻意相似。
		// 这种泄漏极隐蔽 —— 产出看起来正常，只是口径变成了别家的。
		const ws = workspace();
		const store = new MemoryKnowledgeStore();
		await ingestIntoStore(store, OUR_POLICY, ingestContext());
		await ingestIntoStore(
			store,
			OTHER_POLICY,
			ingestContext({ tenantId: "other-univ", documentId: "policy-other" }),
		);

		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws, store);
		const card = resolveCard(PRESET_CARDS, "univ.official-notice", TENANT.tenantId) as ScenarioCard;

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("search_knowledge", { query: "实验室安全管理" })]),
			fauxAssistantMessage("已检索到本单位制度。"),
		]);

		const prompt = compilePrompt(card, { docType: "通知", subject: "实验室安全" });
		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3b-iso",
			sessionId: "m3b-s-iso",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		await orchestrator.run("m3b-iso", prompt);

		// 检查模型实际收到的检索结果
		const search = audit.find((a) => a.tool === "search_knowledge");
		expect(search?.decision).toBe("allowed");

		// 直接查存储，确认隔离
		const mine = await store.search(MEMBER, { query: "实验室安全管理", limit: 50 });
		expect(mine.length).toBeGreaterThan(0);
		for (const hit of mine) {
			expect(hit.chunk.tenantId).toBe(TENANT.tenantId);
			// 别家的特征内容绝不出现
			expect(hit.chunk.text).not.toContain("保卫处统一管理");
			expect(hit.chunk.text).not.toContain("全程录像监控");
		}
	});

	it("知识库无相关材料时，明确提示而非编造制度", async () => {
		// 这是最危险的幻觉场景：编造出来的「制度规定」会被用户当真
		// 写进正式公文，发出去才发现本单位没有这条规定
		const ws = workspace();
		const store = new MemoryKnowledgeStore(); // 空知识库

		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws, store);
		const card = resolveCard(PRESET_CARDS, "univ.official-notice", TENANT.tenantId) as ScenarioCard;

		let searchReply = "";
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("search_knowledge", { query: "实验室安全制度" })]),
			(ctx: { messages: Array<{ role: string; content?: unknown }> }) => {
				// 捕获模型收到的工具结果
				const last = ctx.messages.at(-1);
				searchReply = JSON.stringify(last?.content ?? "");
				return fauxAssistantMessage("知识库中没有相关制度，需请用户提供。");
			},
		]);

		const prompt = compilePrompt(card, { docType: "通知", subject: "实验室安全" });
		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3b-empty",
			sessionId: "m3b-s-empty",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		await orchestrator.run("m3b-empty", prompt);

		// 工具结果明确说了没找到，并告知不要凭记忆编写
		expect(searchReply).toContain("未找到");
		expect(searchReply).toContain("不要凭记忆编写");
	});

	it("体系文件场景：检索 + 生成，产出可追溯到知识库片段", async () => {
		const ws = workspace();
		const store = new MemoryKnowledgeStore();
		await ingestIntoStore(
			store,
			[
				{ index: 1, text: "8.7 不合格输出的控制", isHeading: true, headingLevel: 1 },
				{
					index: 2,
					text: "组织应确保不符合要求的输出得到识别和控制，防止非预期的使用或交付。",
					isHeading: false,
					headingLevel: null,
				},
			],
			ingestContext({ documentId: "iso-1", documentName: "ISO9001标准条款.docx" }),
		);

		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws, store);
		const card = resolveCard(PRESET_CARDS, "mfg.system-document", TENANT.tenantId) as ScenarioCard;

		const prompt = compilePrompt(card, {
			docType: "程序文件",
			subject: "不合格品控制程序",
			standard: ["ISO9001"],
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("search_knowledge", { query: "不合格输出的控制" })]),
			fauxAssistantMessage([
				fauxToolCall("write_document", {
					title: "不合格品控制程序",
					outputName: "不合格品控制程序.docx",
					blocks: [
						{ type: "heading", level: 1, text: "1 目的" },
						{
							type: "paragraph",
							text: "依据 ISO9001 8.7 条「不合格输出的控制」，确保不符合要求的输出得到识别和控制，防止非预期的使用或交付。",
						},
						{ type: "heading", level: 1, text: "2 适用范围" },
						{ type: "paragraph", text: "适用于本公司所有生产过程。" },
						{ type: "heading", level: 1, text: "3 职责" },
						{ type: "paragraph", text: "质量部负责不合格品的判定与处置审批。" },
						{ type: "heading", level: 1, text: "4 流程" },
						{
							type: "numbered_list",
							items: ["识别并标识不合格品", "隔离至指定区域", "质量部判定处置方式", "执行并记录"],
						},
						{ type: "heading", level: 1, text: "5 记录表单" },
						{
							type: "table",
							header: ["表单编号", "表单名称", "保存期限"],
							rows: [["QR-8.7-01", "不合格品处置记录", "3 年"]],
						},
						{ type: "heading", level: 1, text: "6 相关文件" },
						{ type: "paragraph", text: "《ISO9001标准条款》8.7" },
					],
				}),
			]),
			fauxAssistantMessage("程序文件已生成，标注了对应的 ISO9001 条款号。"),
		]);

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3b-iso9001",
			sessionId: "m3b-s-iso9001",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		expect((await orchestrator.run("m3b-iso9001", prompt)).status).toBe(TaskStatus.Succeeded);

		const out = join(ws, "不合格品控制程序.docx");
		expect((await validateDocx(out, { expectHeadings: true, expectTables: 1 })).ok).toBe(true);

		const content = (await readDocx(out)).paragraphs.map((p) => p.text).join("\n");
		// 六个必备部分齐全（场景卡的产出要求）
		for (const section of ["目的", "适用范围", "职责", "流程", "记录表单", "相关文件"]) {
			expect(content, `缺少「${section}」`).toContain(section);
		}
		// 标注了标准条款号 —— 审核员逐条对照时必需
		expect(content).toContain("8.7");

		// —— 溯源：产出可追溯到知识库片段 ——
		const hits = await store.search(MEMBER, { query: "不合格输出的控制" });
		expect(hits.length).toBeGreaterThan(0);
		const hit = hits[0]!;

		const provenance = new ProvenanceBuilder({
			artifactId: "不合格品控制程序.docx",
			artifactName: "不合格品控制程序.docx",
			tenant: TENANT,
			taskId: "m3b-iso9001",
			scenarioId: card.id,
			now: () => 1_700_000_000_000,
		})
			.addLineage({
				target: "1 目的",
				sources: [
					{
						kind: SourceKind.KnowledgeChunk,
						id: hit.chunk.id,
						name: hit.chunk.documentName,
						locator: `第 ${hit.chunk.position} 段`,
					},
				],
				derivation: "引用 ISO9001 8.7 条原文",
			})
			.build();

		expect(validateProvenance(provenance).complete).toBe(true);
		expect(provenance.lineage[0]?.sources[0]?.name).toBe("ISO9001标准条款.docx");
	});

	it("知识库工具未在白名单时被权限门拦下", async () => {
		// 对账场景不该能读知识库 —— 最小权限原则
		const ws = workspace();
		const store = new MemoryKnowledgeStore();
		await ingestIntoStore(store, OUR_POLICY, ingestContext());

		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws, store);
		const card = resolveCard(
			PRESET_CARDS,
			"mfg.supplier-reconcile",
			TENANT.tenantId,
		) as ScenarioCard;
		expect(card.tools).not.toContain("search_knowledge");

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("search_knowledge", { query: "实验室安全" })]),
			fauxAssistantMessage("该操作不在当前场景允许范围内。"),
		]);

		const prompt = compilePrompt(card, {
			ourLedger: "/ws/a.xlsx",
			supplierBill: "/ws/b.xlsx",
			keyColumns: ["物料编码"],
			compareColumns: ["金额"],
		});
		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3b-deny",
			sessionId: "m3b-s-deny",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
		});
		await orchestrator.run("m3b-deny", prompt);

		const denied = audit.find((a) => a.tool === "search_knowledge");
		expect(denied?.decision).toBe("blocked");
	});
});
