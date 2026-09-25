/**
 * M3-4 验收：模板与口径资产端到端
 *
 * 验两件事：
 *
 *  1. **模板让产出格式稳定。** 同一场景两次执行都符合模板，且合规校验
 *     能在交付前拦下缺章节的产出 —— 用户往往到被审核退回时才发现。
 *  2. **模板与经验的优先级在真实链路上生效。** 模板是用户主动提供的规范，
 *     经验是系统的推测。两者冲突时以模板为准。
 *
 * 第 2 点是这一项的难点。测法与 [M3-3](./lesson-feedback.test.ts) 同一思路：
 * 让假模型按**实际收到的上下文**决定产出，而不是硬编码正确答案。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../vendor/pi/agent/src/harness/session/session.ts";
import {
	activateableTools,
	checkTemplateCompliance,
	compileDefinitions,
	compileLessons,
	compilePrompt,
	compileTemplate,
	composeAssetContext,
	createPermissionGate,
	learnFromRevisions,
	PRESET_CARDS,
	resolveCard,
	resolveTemplate,
	restrictPolicies,
	RevisionKind,
	Scope,
	TaskStatus,
	TemplateKind,
	type AuditEntry,
	type FieldDefinition,
	type ScenarioCard,
	type Template,
} from "@tao/core";
import {
	createDocToolset,
	createOfficeToolset,
	DOC_TOOL_POLICIES,
	OFFICE_TOOL_POLICIES,
	readDocx,
} from "@tao/office";
import { MemoryAssetStore, MemoryLessonStore } from "@tao/knowledge";
import { InProcessRunnerFactory } from "@tao/agent-host";
import { TaskOrchestrator } from "@tao/orchestrator";
import { afterEach, describe, expect, it } from "vitest";

const TENANT = { tenantId: "mfg-002", workspaceId: "quality", userId: "chen" };
const SCENARIO_ID = "mfg.system-document";
const clock = () => 1_700_000_000_000;

const dirs: string[] = [];
const sessions: StorageBackedSession[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "m3d-e2e-"));
	dirs.push(dir);
	return dir;
}

const PROCEDURE_TEMPLATE: Template = {
	id: "tpl-procedure",
	tenantId: TENANT.tenantId,
	name: "程序文件模板",
	kind: TemplateKind.Document,
	scenarioId: SCENARIO_ID,
	sections: [
		{ title: "1 目的", required: true },
		{ title: "2 适用范围", required: true },
		{ title: "3 职责", required: true },
		{ title: "4 工作程序", required: true },
		{ title: "5 相关记录", required: true },
	],
	layout: { bodyFont: "仿宋_GB2312", bodySizePt: 12 },
	scope: Scope.Tenant,
	enabled: true,
	updatedAt: clock(),
};

const PASS_RATE: FieldDefinition = {
	id: "def-pass-rate",
	tenantId: TENANT.tenantId,
	name: "一次合格率",
	definition: "首次检验即合格的产品数占投入数的比例",
	formula: "首检合格数 / 投入数 × 100%",
	excludes: ["返工后合格的产品"],
	owner: "质量部",
	scope: Scope.Tenant,
	updatedAt: clock(),
};

async function assemble(ws: string) {
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
	];
	const allPolicies = [...OFFICE_TOOL_POLICIES, ...DOC_TOOL_POLICIES];
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

/** 按模板的五个章节生成文档块。 */
function compliantBlocks() {
	return [
		{ type: "heading", level: 1, text: "1 目的" },
		{ type: "paragraph", text: "规范不合格品的识别、隔离与处置。" },
		{ type: "heading", level: 1, text: "2 适用范围" },
		{ type: "paragraph", text: "适用于本公司所有生产过程。" },
		{ type: "heading", level: 1, text: "3 职责" },
		{ type: "paragraph", text: "质量部负责判定，生产部负责隔离。" },
		{ type: "heading", level: 1, text: "4 工作程序" },
		{ type: "paragraph", text: "识别 → 标识 → 隔离 → 判定 → 处置 → 记录。" },
		{ type: "heading", level: 1, text: "5 相关记录" },
		{
			type: "table",
			header: ["表单编号", "表单名称", "保存期限"],
			rows: [["QR-8.7-01", "不合格品处置记录", "3 年"]],
		},
	];
}

/** 缺两个章节的文档块。 */
function incompleteBlocks() {
	return [
		{ type: "heading", level: 1, text: "1 目的" },
		{ type: "paragraph", text: "规范不合格品处置。" },
		{ type: "heading", level: 1, text: "2 适用范围" },
		{ type: "paragraph", text: "全公司。" },
		{ type: "heading", level: 1, text: "3 职责" },
		{ type: "paragraph", text: "质量部。" },
	];
}

describe("M3-4 验收 · 模板与口径资产", () => {
	afterEach(async () => {
		for (const s of sessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("模板注入后产出合规，且能通过合规校验", async () => {
		const ws = workspace();
		const assetStore = new MemoryAssetStore();
		await assetStore.upsertTemplate(PROCEDURE_TEMPLATE);

		const card = resolveCard(PRESET_CARDS, SCENARIO_ID, TENANT.tenantId) as ScenarioCard;
		const templates = await assetStore.listTemplates(TENANT.tenantId, SCENARIO_ID);
		const template = resolveTemplate(templates, SCENARIO_ID);
		expect(template).toBeDefined();

		const assetContext = composeAssetContext({ template: compileTemplate(template!) });
		expect(assetContext).toContain("必需章节");

		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws);
		let sawTemplate = false;
		faux.setResponses([
			(ctx: { messages: Array<{ role: string; content?: unknown }> }) => {
				const system = ctx.messages.find((m) => m.role === "system");
				const text =
					typeof system?.content === "string"
						? system.content
						: JSON.stringify(system?.content ?? "");
				// 模型按实际收到的模板决定产出 —— 没收到就只写三章
				sawTemplate = text.includes("必需章节");
				return fauxAssistantMessage([
					fauxToolCall("write_document", {
						title: "不合格品控制程序",
						outputName: "程序文件.docx",
						blocks: sawTemplate ? compliantBlocks() : incompleteBlocks(),
						// 版式也照模板走
						...(sawTemplate ? { bodyFont: "仿宋_GB2312", bodySizePt: 12 } : {}),
					}),
				]);
			},
			fauxAssistantMessage("程序文件已生成。"),
		]);

		const prompt = compilePrompt(card, {
			docType: "程序文件",
			subject: "不合格品控制程序",
			standard: ["ISO9001"],
		});

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3d-1",
			sessionId: "m3d-s-1",
			prompt,
			systemPrompt: [card.systemPrompt, "", assetContext].join("\n"),
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		expect((await orchestrator.run("m3d-1", prompt)).status).toBe(TaskStatus.Succeeded);
		expect(sawTemplate).toBe(true);

		// —— 合规校验 ——
		const { paragraphs } = await readDocx(join(ws, "程序文件.docx"));
		const headings = paragraphs.filter((p) => p.isHeading).map((p) => p.text);

		const compliance = checkTemplateCompliance(template!, { headings });
		expect(compliance.ok).toBe(true);
		expect(compliance.issues).toEqual([]);
	});

	it("合规校验在交付前拦下缺章节的产出", async () => {
		// 这是模板资产的核心价值：缺章节的程序文件交给审核员会被开不符合项，
		// 而用户往往到那时才发现
		const ws = workspace();
		const card = resolveCard(PRESET_CARDS, SCENARIO_ID, TENANT.tenantId) as ScenarioCard;
		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws);

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("write_document", {
					title: "不合格品控制程序",
					outputName: "残缺文件.docx",
					blocks: incompleteBlocks(),
				}),
			]),
			fauxAssistantMessage("已生成。"),
		]);

		const prompt = compilePrompt(card, {
			docType: "程序文件",
			subject: "不合格品控制程序",
			standard: ["ISO9001"],
		});
		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3d-2",
			sessionId: "m3d-s-2",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		await orchestrator.run("m3d-2", prompt);

		const { paragraphs } = await readDocx(join(ws, "残缺文件.docx"));
		const headings = paragraphs.filter((p) => p.isHeading).map((p) => p.text);

		const compliance = checkTemplateCompliance(PROCEDURE_TEMPLATE, { headings });
		expect(compliance.ok).toBe(false);
		const messages = compliance.issues.map((i) => i.message).join("|");
		expect(messages).toContain("工作程序");
		expect(messages).toContain("相关记录");
	});

	it("口径定义注入后，模型能按本单位口径计算", async () => {
		const ws = workspace();
		const assetStore = new MemoryAssetStore();
		await assetStore.upsertDefinition(PASS_RATE);

		const card = resolveCard(PRESET_CARDS, "mfg.production-report", TENANT.tenantId) as ScenarioCard;
		const definitions = await assetStore.listDefinitions(TENANT.tenantId);
		const prompt = compilePrompt(card, {
			productionData: ["/ws/产量记录.xlsx"],
			period: "周报",
			metrics: ["良率"],
		});

		// 按本次任务内容过滤口径 —— 只注入相关的
		const defContext = compileDefinitions(definitions, `${prompt} 一次合格率`);
		expect(defContext).toContain("返工后合格的产品");

		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws);
		let sawDefinition = false;
		faux.setResponses([
			(ctx: { messages: Array<{ role: string; content?: unknown }> }) => {
				const system = ctx.messages.find((m) => m.role === "system");
				const text =
					typeof system?.content === "string"
						? system.content
						: JSON.stringify(system?.content ?? "");
				sawDefinition = text.includes("返工后合格的产品");
				return fauxAssistantMessage([
					fauxToolCall("write_document", {
						title: "生产周报",
						outputName: "周报.docx",
						blocks: [
							{ type: "heading", level: 1, text: "一、指标口径" },
							{
								type: "paragraph",
								text: sawDefinition
									? "一次合格率 = 首检合格数 / 投入数 × 100%，不含返工后合格的产品。"
									: "一次合格率按合格数除以总数计算。",
							},
						],
					}),
				]);
			},
			fauxAssistantMessage("周报已生成。"),
		]);

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3d-3",
			sessionId: "m3d-s-3",
			prompt,
			systemPrompt: [card.systemPrompt, "", composeAssetContext({ definitions: defContext })].join(
				"\n",
			),
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		await orchestrator.run("m3d-3", prompt);

		expect(sawDefinition).toBe(true);
		const content = (await readDocx(join(ws, "周报.docx"))).paragraphs
			.map((p) => p.text)
			.join("\n");
		// 产出里写明了口径，用户才能信任这个数字
		expect(content).toContain("不含返工后合格的产品");
	});

	it("模板与经验同时存在时，优先级声明到达模型", async () => {
		const ws = workspace();
		const lessonStore = new MemoryLessonStore();
		await learnFromRevisions(
			lessonStore,
			[
				{
					kind: RevisionKind.Structure,
					target: "第1段",
					before: "1 目的",
					after: "一、编制目的",
				},
			],
			{ tenantId: TENANT.tenantId, scenarioId: SCENARIO_ID, now: clock },
		);

		const assetContext = composeAssetContext({
			template: compileTemplate(PROCEDURE_TEMPLATE),
			lessons: compileLessons(await lessonStore.list(TENANT.tenantId, SCENARIO_ID)),
		});
		// 顺序即优先级
		expect(assetContext.indexOf("程序文件模板")).toBeLessThan(
			assetContext.indexOf("历史修改记录"),
		);
		expect(assetContext).toContain("模板与口径定义 > 历史修改记录");

		const card = resolveCard(PRESET_CARDS, SCENARIO_ID, TENANT.tenantId) as ScenarioCard;
		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws);

		let sawPrecedence = false;
		faux.setResponses([
			(ctx: { messages: Array<{ role: string; content?: unknown }> }) => {
				const system = ctx.messages.find((m) => m.role === "system");
				const text =
					typeof system?.content === "string"
						? system.content
						: JSON.stringify(system?.content ?? "");
				sawPrecedence = text.includes("模板与口径定义 > 历史修改记录");
				return fauxAssistantMessage("已了解模板与历史偏好的优先级。");
			},
		]);

		const prompt = compilePrompt(card, {
			docType: "程序文件",
			subject: "不合格品控制程序",
			standard: ["ISO9001"],
		});
		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3d-4",
			sessionId: "m3d-s-4",
			prompt,
			systemPrompt: [card.systemPrompt, "", assetContext].join("\n"),
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		await orchestrator.run("m3d-4", prompt);

		// 模型确实收到了优先级声明 —— 面对矛盾指令时有据可依
		expect(sawPrecedence).toBe(true);
	});

	it("别家租户的模板与口径不会进入我方上下文", async () => {
		const assetStore = new MemoryAssetStore();
		await assetStore.upsertTemplate({ ...PROCEDURE_TEMPLATE, tenantId: "other-mfg" });
		await assetStore.upsertDefinition({ ...PASS_RATE, tenantId: "other-mfg" });

		const templates = await assetStore.listTemplates(TENANT.tenantId, SCENARIO_ID);
		const definitions = await assetStore.listDefinitions(TENANT.tenantId);

		expect(templates).toEqual([]);
		expect(definitions).toEqual([]);
		expect(
			composeAssetContext({
				definitions: compileDefinitions(definitions, "一次合格率"),
			}),
		).toBe("");
	});
});
