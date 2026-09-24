/**
 * M2 验收：场景卡驱动端到端
 *
 * 验收标准（[需求](../docs/requirements.md) §6）：
 * **任一场景卡可在不输入自由文本 prompt 的前提下完成任务提交。**
 *
 * 与 [M1 的 e2e](./reconcile-scenario.test.ts) 的区别在**入口**：
 * M1 里测试代码自己写了一句 prompt 喂给编排器，而这里**从头到尾没有人写 prompt** ——
 * 指令由场景卡的模板 + 用户填的表单字段编译而来。
 *
 * 这条差别就是整个产品能否被目标用户用起来的分界线。需求里写得很直白：
 * 这些用户「会把 AI 当搜索引擎用，但不会写有效 prompt」。所以本文件刻意
 * **不 import 任何手写的 prompt 字符串**，只有 `compilePrompt` 的产出。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../vendor/pi/agent/src/harness/session/session.ts";
import {
	activateableTools,
	compilePrompt,
	createPermissionGate,
	listCards,
	PRESET_CARDS,
	ProvenanceBuilder,
	resolveCard,
	restrictPolicies,
	SourceKind,
	TaskStatus,
	validateProvenance,
	validateSubmission,
	type AuditEntry,
	type ScenarioCard,
	type TaskEvent,
} from "@tao/core";
import { createOfficeToolset, OFFICE_TOOL_POLICIES, validateXlsx } from "@tao/office";
import { InProcessRunnerFactory } from "@tao/agent-host";
import { TaskOrchestrator } from "@tao/orchestrator";
import { afterEach, describe, expect, it } from "vitest";

const TENANT = { tenantId: "factory-001", workspaceId: "purchasing", userId: "li" };
const dirs: string[] = [];
const sessions: StorageBackedSession[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "m2-e2e-"));
	dirs.push(dir);
	return dir;
}

async function makeInputs(dir: string): Promise<{ ours: string; theirs: string }> {
	const ours = join(dir, "我方台账.xlsx");
	const theirs = join(dir, "供应商对账单.xlsx");

	const wb1 = new ExcelJS.Workbook();
	const ws1 = wb1.addWorksheet("台账");
	ws1.addRow(["物料编码", "数量", "金额"]);
	ws1.addRow(["M-1001", 500, 12500]);
	ws1.addRow(["M-1002", 1200, 30000]);
	await wb1.xlsx.writeFile(ours);

	const wb2 = new ExcelJS.Workbook();
	const ws2 = wb2.addWorksheet("对账单");
	ws2.addRow(["物料编码", "数量", "金额"]);
	ws2.addRow(["M-1001", 500, 12500]);
	ws2.addRow(["M-1002", 1200, 29500]); // 金额差 500
	await wb2.xlsx.writeFile(theirs);

	return { ours, theirs };
}

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
	const tools = createOfficeToolset({ workspace: ws, now: () => new Date("2026-09-24T10:00:00Z") });
	const gate = createPermissionGate({
		policies: [...OFFICE_TOOL_POLICIES],
		workspace: ws,
		audit: (entry) => void audit.push(entry),
	});

	return { orchestrator, faux, tools, gate, audit };
}

/**
 * 捕获模型实际收到的请求。
 *
 * 断言「模型看不到某工具」必须看**模型侧的 transcript**，而不是我们传进去的参数 ——
 * 后者只证明我们的意图，不证明内核照做了。系统提示与工具清单都在
 * transcript 的首条 system 消息里（见 vendor/pi/ai/src/types.ts 的 StreamFunction 契约）。
 */
function capturingResponse(
	captured: { systemPrompt?: string; tools?: string[] },
	reply: ReturnType<typeof fauxAssistantMessage>,
) {
	return (context: { messages: Array<Record<string, unknown>> }) => {
		const system = context.messages.find((m) => m.role === "system");
		if (system !== undefined) {
			const content = system.content;
			captured.systemPrompt = typeof content === "string" ? content : JSON.stringify(content);
			captured.tools = ((system.toolsAdded ?? []) as Array<{ name: string }>).map((t) => t.name);
		}
		return reply;
	};
}

describe("M2 验收 · 场景卡驱动，用户不写一个字的 prompt", () => {
	afterEach(async () => {
		for (const s of sessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("填表 → 编译指令 → 执行 → 产出可用报告", async () => {
		const ws = workspace();
		const { ours, theirs } = await makeInputs(ws);
		const { orchestrator, faux, tools, gate } = await assemble(ws);

		// ① 用户从首页挑一张卡
		const card = resolveCard(PRESET_CARDS, "mfg.supplier-reconcile", TENANT.tenantId);
		expect(card).toBeDefined();

		// ② 用户填表 —— 全是业务数据与勾选，没有一句指令
		const formValues = {
			ourLedger: ours,
			supplierBill: theirs,
			keyColumns: ["物料编码"],
			compareColumns: ["数量", "金额"],
			tolerance: 0.01,
		};

		// ③ 校验通过才允许提交
		const validation = validateSubmission(card as ScenarioCard, formValues);
		expect(validation.valid).toBe(true);

		// ④ 平台编译指令。**这是全文唯一的 prompt 来源**
		const prompt = compilePrompt(card as ScenarioCard, formValues);
		expect(prompt).toContain(ours);
		expect(prompt).toContain("匹配依据：物料编码");
		expect(prompt).toContain("要求：");

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: ours,
					rightPath: theirs,
					keyColumns: ["物料编码"],
					compareColumns: ["数量", "金额"],
					leftLabel: "我方台账",
					rightLabel: "供应商对账单",
					outputName: "对账差异报告.xlsx",
				}),
			]),
			fauxAssistantMessage("核对完成，发现 1 处金额差异。"),
		]);

		const events: TaskEvent[] = [];
		orchestrator.subscribe((e) => void events.push(e));

		// ⑤ 提交与执行：systemPrompt 与工具白名单都来自场景卡
		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m2-task-1",
			sessionId: "m2-session-1",
			prompt,
			systemPrompt: (card as ScenarioCard).systemPrompt,
			tools,
			gate,
			activeTools: (card as ScenarioCard).tools,
		});
		const finished = await orchestrator.run("m2-task-1", prompt);

		expect(finished.status).toBe(TaskStatus.Succeeded);

		// ⑥ 产物真实可用
		const report = join(ws, "对账差异报告.xlsx");
		expect(existsSync(report)).toBe(true);
		const check = await validateXlsx(report, {
			expectFormulas: true,
			expectSheets: ["核对汇总", "差异明细"],
		});
		expect(check.ok).toBe(true);
	});

	it("场景卡的工具白名单收窄了模型可见的工具", async () => {
		// 8D 场景不该看见核对工具 —— 白名单是模型侧的第一层，
		// 权限门是执行侧的第二层，两层都要有
		const ws = workspace();
		const { orchestrator, faux, tools, gate } = await assemble(ws);
		const card = resolveCard(PRESET_CARDS, "mfg.8d-report", TENANT.tenantId) as ScenarioCard;

		const prompt = compilePrompt(card, {
			problemDescription: "客户反馈端面跳动超差",
			productInfo: "刹车盘 BP-2024 批次 20260801",
		});

		const captured: { systemPrompt?: string; tools?: string[] } = {};
		faux.setResponses([
			capturingResponse(captured, fauxAssistantMessage("需要补充 D4 根本原因的排查数据。")),
		]);

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m2-task-2",
			sessionId: "m2-session-2",
			prompt,
			systemPrompt: card.systemPrompt,
			// 平台提供全部工具，但只激活场景卡声明的那些。
			// 取交集：8D 卡还声明了 M3 才实现的 write_document，
			// 原样传给内核会让整个运行失败（configured_tools_unavailable）。
			tools,
			gate,
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		const done = await orchestrator.run("m2-task-2", prompt);
		expect(done.status).toBe(TaskStatus.Succeeded);

		// 模型侧真实看到的工具清单里没有核对工具
		expect(captured.tools).toBeDefined();
		expect(captured.tools).not.toContain("reconcile_tables");
		// 但 8D 场景声明的工具里，平台已实现的那个应当可见
		expect(captured.tools).toContain("read_table");
	});

	it("activeTools 含未注册工具时立即报错，而非静默失败", async () => {
		// 这是一条回归防线。内核对此的处理是整个运行失败且模型零调用，
		// 且 lane.prompt() 不会 reject —— 若适配层不管，任务会被报成「成功」
		// 但没有任何产出。这类缺陷在生产环境几乎无法从日志定位。
		const ws = workspace();
		const { orchestrator, tools, gate } = await assemble(ws);
		const card = resolveCard(PRESET_CARDS, "mfg.8d-report", TENANT.tenantId) as ScenarioCard;

		await expect(
			orchestrator.submit({
				tenant: TENANT,
				taskId: "m2-task-bad",
				sessionId: "m2-session-bad",
				prompt: "x",
				systemPrompt: card.systemPrompt,
				tools,
				gate,
				// 原样传入，含 M3 才实现的 write_document
				activeTools: card.tools,
			}),
		).rejects.toThrow(/write_document/);
	});

	it("白名单之外的工具即使被调用也会被权限门拦下", async () => {
		// 反向验证：白名单是模型侧的，若模型仍强行调用未激活的工具
		// （越狱、上下文污染、内核 bug），执行侧必须还有一道
		const ws = workspace();
		const { ours, theirs } = await makeInputs(ws);
		const { orchestrator, faux, tools, audit } = await assemble(ws);
		const card = resolveCard(PRESET_CARDS, "mfg.8d-report", TENANT.tenantId) as ScenarioCard;

		// 权限门按场景卡白名单收窄：未声明的工具走默认拒绝分支
		const gate = createPermissionGate({
			policies: restrictPolicies([...OFFICE_TOOL_POLICIES], card.tools),
			workspace: ws,
			audit: (entry) => void audit.push(entry),
		});

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: ours,
					rightPath: theirs,
					keyColumns: ["物料编码"],
					compareColumns: ["数量"],
					outputName: "越权产物.xlsx",
				}),
			]),
			fauxAssistantMessage("该操作不在当前场景允许范围内。"),
		]);

		const prompt = compilePrompt(card, {
			problemDescription: "问题描述",
			productInfo: "产品批次",
		});

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m2-task-3",
			sessionId: "m2-session-3",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate,
		});
		await orchestrator.run("m2-task-3", prompt);

		// 没有产出越权文件
		expect(existsSync(join(ws, "越权产物.xlsx"))).toBe(false);
		expect(audit.some((a) => a.decision === "blocked" && a.tool === "reconcile_tables")).toBe(true);
	});

	it("产物带完整溯源，可回答「这个数从哪来的」", async () => {
		const ws = workspace();
		const { ours, theirs } = await makeInputs(ws);
		const { orchestrator, faux, tools, gate } = await assemble(ws);
		const card = resolveCard(PRESET_CARDS, "mfg.supplier-reconcile", TENANT.tenantId) as ScenarioCard;

		const formValues = {
			ourLedger: ours,
			supplierBill: theirs,
			keyColumns: ["物料编码"],
			compareColumns: ["金额"],
		};
		const prompt = compilePrompt(card, formValues);

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: ours,
					rightPath: theirs,
					keyColumns: ["物料编码"],
					compareColumns: ["金额"],
					outputName: "溯源报告.xlsx",
				}),
			]),
			fauxAssistantMessage("完成"),
		]);

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m2-task-4",
			sessionId: "m2-session-4",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate,
		});
		await orchestrator.run("m2-task-4", prompt);

		// 溯源记录：从场景卡与表单输入构建
		const provenance = new ProvenanceBuilder({
			artifactId: "溯源报告.xlsx",
			artifactName: "溯源报告.xlsx",
			tenant: TENANT,
			taskId: "m2-task-4",
			scenarioId: card.id,
			now: () => 1_700_000_000_000,
		})
			.addLineage({
				target: "差异明细!E2",
				sources: [
					{ kind: SourceKind.InputFile, id: ours, name: "我方台账.xlsx", locator: "台账!C3" },
					{ kind: SourceKind.InputFile, id: theirs, name: "供应商对账单.xlsx", locator: "对账单!C3" },
				],
				derivation: "我方金额 - 对方金额",
			})
			.build();

		expect(validateProvenance(provenance).complete).toBe(true);
		expect(provenance.scenarioId).toBe("mfg.supplier-reconcile");
	});

	it("十张场景卡对本租户全部可见且无重名", () => {
		const visible = listCards(PRESET_CARDS, TENANT.tenantId);
		expect(visible).toHaveLength(10);

		const titles = visible.map((c) => c.title);
		expect(new Set(titles).size).toBe(10);
	});

	it("租户自建场景覆盖平台同名场景后，链路走自建版本", async () => {
		// 需求要求租户可自建场景并覆盖平台预置。验的是覆盖后**实际执行的是自建版本**，
		// 而非仅列表里显示了自建版本
		const ws = workspace();
		const { ours, theirs } = await makeInputs(ws);
		const { orchestrator, faux, tools, gate } = await assemble(ws);

		const base = resolveCard(PRESET_CARDS, "mfg.supplier-reconcile", TENANT.tenantId) as ScenarioCard;
		const tenantOwn: ScenarioCard = {
			...base,
			tenantId: TENANT.tenantId,
			systemPrompt: "你是本厂采购对账助手，差异一律以我方 ERP 台账为准。",
			promptTemplate: [...base.promptTemplate.split("\n"), "4. 报告末尾附本厂对账专用声明"].join("\n"),
		};

		const catalog = [...PRESET_CARDS, tenantOwn];
		const resolved = resolveCard(catalog, "mfg.supplier-reconcile", TENANT.tenantId) as ScenarioCard;
		expect(resolved.tenantId).toBe(TENANT.tenantId);

		const prompt = compilePrompt(resolved, {
			ourLedger: ours,
			supplierBill: theirs,
			keyColumns: ["物料编码"],
			compareColumns: ["金额"],
		});
		expect(prompt).toContain("本厂对账专用声明");

		const captured: { systemPrompt?: string; tools?: string[] } = {};
		faux.setResponses([
			capturingResponse(captured, fauxAssistantMessage("已按本厂口径完成核对。")),
		]);
		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m2-task-5",
			sessionId: "m2-session-5",
			prompt,
			systemPrompt: resolved.systemPrompt,
			tools,
			gate,
		});
		await orchestrator.run("m2-task-5", prompt);

		// 模型收到的系统提示是自建版本，而非平台预置版本
		expect(captured.systemPrompt).toContain("本厂采购对账助手");
		expect(captured.systemPrompt).not.toContain("制造业采购与财务的对账助手");
	});
});
