/**
 * M3-1 验收：文档场景端到端
 *
 * 验证 M2 遗留的「只能提交、跑不到产出」的场景卡现在真能产出文件。
 *
 * 与 [M2 的 e2e](./scenario-card-flow.test.ts) 同样的纪律：入口是场景卡 + 表单值，
 * 全文没有一句手写 prompt。区别在于这次验的是**文档产出的业务正确性** ——
 * 8D 报告缺了 D4 章节、整改台账缺了责任部门列，交上去就是不合格。
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
	PRESET_CARDS,
	resolveCard,
	restrictPolicies,
	TaskStatus,
	validateSubmission,
	type AuditEntry,
	type ScenarioCard,
} from "@tao/core";
import {
	createDocToolset,
	createOfficeToolset,
	DOC_TOOL_POLICIES,
	OFFICE_TOOL_POLICIES,
	readDocx,
	validateDocx,
	writeDocx,
	BlockType,
} from "@tao/office";
import { InProcessRunnerFactory } from "@tao/agent-host";
import { TaskOrchestrator } from "@tao/orchestrator";
import { afterEach, describe, expect, it } from "vitest";

const TENANT = { tenantId: "factory-002", workspaceId: "quality", userId: "wang" };
const dirs: string[] = [];
const sessions: StorageBackedSession[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "m3-e2e-"));
	dirs.push(dir);
	return dir;
}

/** 装配含文档工具的完整链路。 */
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
	// 表格工具 + 文档工具 —— 平台提供全集，场景卡按需激活
	const tools = [
		...createOfficeToolset({ workspace: ws, now: () => new Date("2026-09-25T10:00:00Z") }),
		...createDocToolset({ workspace: ws }),
	];
	const allPolicies = [...OFFICE_TOOL_POLICIES, ...DOC_TOOL_POLICIES];

	return { orchestrator, faux, tools, allPolicies, audit };
}

/** 按场景卡收窄的权限门。 */
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

describe("M3-1 验收 · 文档场景端到端", () => {
	afterEach(async () => {
		for (const s of sessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("8D 报告：填表 → 生成 docx → 八个步骤齐全", async () => {
		const ws = workspace();
		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws);
		const card = resolveCard(PRESET_CARDS, "mfg.8d-report", TENANT.tenantId) as ScenarioCard;

		// 用户填表，没有一句指令
		const formValues = {
			problemDescription: "客户反馈刹车盘端面跳动超差，2026 年 9 月来货批次",
			productInfo: "刹车盘 BP-2024，批次 20260801-20260815",
			customer: "某整车厂",
		};
		expect(validateSubmission(card, formValues).valid).toBe(true);
		const prompt = compilePrompt(card, formValues);

		// 模型按场景卡要求构造结构化文档树
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("write_document", {
					title: "8D 问题解决报告",
					outputName: "8D报告.docx",
					blocks: [
						{ type: "heading", level: 1, text: "D1 成立跨职能小组" },
						{ type: "paragraph", text: "组长由质量部担任，成员含工艺、生产、采购。" },
						{ type: "heading", level: 1, text: "D2 问题描述" },
						{ type: "paragraph", text: "客户反馈刹车盘端面跳动超差，批次 20260801-20260815。" },
						{ type: "heading", level: 1, text: "D3 临时措施" },
						{ type: "paragraph", text: "已对在库品全检，隔离不合格品。" },
						{ type: "heading", level: 1, text: "D4 根本原因" },
						{
							type: "paragraph",
							runs: [
								{ text: "根本原因分析" },
								{ text: "待补充：需提供 SPC 数据与设备点检记录", placeholder: true },
							],
						},
						{ type: "heading", level: 1, text: "D5 永久措施" },
						{ type: "paragraph", runs: [{ text: "待补充", placeholder: true }] },
						{ type: "heading", level: 1, text: "D6 效果验证" },
						{ type: "paragraph", runs: [{ text: "待补充", placeholder: true }] },
						{ type: "heading", level: 1, text: "D7 预防再发" },
						{ type: "paragraph", text: "将端面跳动纳入首件检验必检项。" },
						{ type: "heading", level: 1, text: "D8 小组表彰" },
						{ type: "paragraph", text: "问题闭环后由质量部提报表彰。" },
					],
				}),
			]),
			fauxAssistantMessage("8D 报告已生成，D4-D6 需补充数据后方可提交客户。"),
		]);

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3-8d",
			sessionId: "m3-s-8d",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		const finished = await orchestrator.run("m3-8d", prompt);

		expect(finished.status).toBe(TaskStatus.Succeeded);

		// —— 产物业务正确性 ——
		const out = join(ws, "8D报告.docx");
		expect(existsSync(out)).toBe(true);

		const validation = await validateDocx(out, { expectHeadings: true });
		expect(validation.ok).toBe(true);

		// 八个步骤必须齐全，缺一个就会被客户退回
		const content = (await readDocx(out)).paragraphs.map((p) => p.text).join("\n");
		for (const step of ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"]) {
			expect(content, `缺少 ${step}`).toContain(step);
		}
		// 待补充项如实保留，没有被编造成看似完整的内容
		expect(content).toContain("待补充");
	});

	it("整改台账：产出含表格且列完整可切分", async () => {
		const ws = workspace();
		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws);
		const card = resolveCard(
			PRESET_CARDS,
			"univ.rectification-ledger",
			TENANT.tenantId,
		) as ScenarioCard;

		const prompt = compilePrompt(card, {
			feedback: ["/ws/检查反馈函.docx"],
			deadline: "2026-12-31",
		});

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("write_document", {
					title: "整改台账",
					outputName: "整改台账.docx",
					blocks: [
						{
							type: "table",
							header: ["序号", "问题描述", "反馈来源", "责任部门", "完成期限", "当前进度"],
							rows: [
								["1", "部分课程大纲未及时更新", "检查反馈函第 3 条", "教务处", "2026-12-31", "未开始"],
								["2", "实验室安全制度需完善", "检查反馈函第 5 条", "待分工", "2026-11-30", "未开始"],
							],
						},
					],
				}),
			]),
			fauxAssistantMessage("台账已生成，第 2 项责任部门待分工。"),
		]);

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3-ledger",
			sessionId: "m3-s-ledger",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		expect((await orchestrator.run("m3-ledger", prompt)).status).toBe(TaskStatus.Succeeded);

		const out = join(ws, "整改台账.docx");
		const validation = await validateDocx(out, { expectTables: 1 });
		expect(validation.ok).toBe(true);

		// 表格的列必须能切回来 —— 粘成一串的话用户拿到的台账是废的
		const table = (await readDocx(out)).paragraphs.find((p) => p.text.includes("责任部门"));
		expect(table).toBeDefined();
		const header = table?.text.split("\n")[0]?.split("|").map((s) => s.trim());
		expect(header).toEqual(["序号", "问题描述", "反馈来源", "责任部门", "完成期限", "当前进度"]);
		// 每条问题可追溯到原始反馈
		expect(table?.text).toContain("检查反馈函第 3 条");
	});

	it("读取长文档：先取骨架再分批读，不会一次塞爆上下文", async () => {
		const ws = workspace();
		// 先造一份长的评估指标文件
		const blocks = Array.from({ length: 80 }, (_, i) =>
			i % 8 === 0
				? ({ type: BlockType.Heading, level: 2, text: `指标 ${i / 8 + 1} 师资队伍` } as const)
				: ({ type: BlockType.Paragraph, text: `指标内涵说明第 ${i} 条。` } as const),
		);
		await writeDocx({ title: "评估指标体系", blocks }, { workspace: ws, outputName: "指标.docx" });

		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws);
		const card = resolveCard(PRESET_CARDS, "univ.self-assessment", TENANT.tenantId) as ScenarioCard;

		const indicatorPath = join(ws, "指标.docx");
		const prompt = compilePrompt(card, {
			indicatorSystem: indicatorPath,
			materials: [join(ws, "指标.docx")],
			scope: "本科教学工作合格评估",
		});

		faux.setResponses([
			// 先拿骨架
			fauxAssistantMessage([
				fauxToolCall("read_document", { path: indicatorPath, outlineOnly: true }),
			]),
			// 再读具体段落
			fauxAssistantMessage([
				fauxToolCall("read_document", { path: indicatorPath, fromParagraph: 1 }),
			]),
			fauxAssistantMessage("已了解指标结构，共 10 个一级指标。"),
		]);

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3-read",
			sessionId: "m3-s-read",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		expect((await orchestrator.run("m3-read", prompt)).status).toBe(TaskStatus.Succeeded);

		// 两次读取都被放行
		const reads = audit.filter((a) => a.tool === "read_document");
		expect(reads).toHaveLength(2);
		expect(reads.every((a) => a.decision === "allowed")).toBe(true);
	});

	it("模型给出畸形表格时报错且不产出误导性文件", async () => {
		// 真实场景：模型漏了一列。若静默产出，用户拿到一份错位的台账
		// 却不知道哪里错了 —— 比直接失败糟得多
		const ws = workspace();
		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws);
		const card = resolveCard(
			PRESET_CARDS,
			"univ.rectification-ledger",
			TENANT.tenantId,
		) as ScenarioCard;

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("write_document", {
					title: "台账",
					outputName: "坏台账.docx",
					blocks: [
						{
							type: "table",
							header: ["序号", "问题", "部门"],
							rows: [["1", "问题一"]], // 少一列
						},
					],
				}),
			]),
			fauxAssistantMessage("表格列数不齐，已修正后重新生成。"),
		]);

		const prompt = compilePrompt(card, { feedback: ["/ws/反馈.docx"] });
		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3-bad",
			sessionId: "m3-s-bad",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		// 工具返回错误，模型收到后可重试 —— 任务本身不算失败
		expect((await orchestrator.run("m3-bad", prompt)).status).toBe(TaskStatus.Succeeded);

		// 关键：没有产出那份错位的文件
		expect(existsSync(join(ws, "坏台账.docx"))).toBe(false);
	});

	it("文档工具的安全边界在真实链路上生效", async () => {
		const ws = workspace();
		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws);
		const card = resolveCard(PRESET_CARDS, "univ.official-notice", TENANT.tenantId) as ScenarioCard;

		faux.setResponses([
			// ① 试图读系统文件
			fauxAssistantMessage([fauxToolCall("read_document", { path: "/etc/shadow" })]),
			// ② 试图把产物写到工作区外
			fauxAssistantMessage([
				fauxToolCall("write_document", {
					title: "逃逸",
					outputName: "../../逃逸.docx",
					blocks: [{ type: "paragraph", text: "x" }],
				}),
			]),
			fauxAssistantMessage("这些操作不被允许。"),
		]);

		const prompt = compilePrompt(card, { docType: "通知", subject: "关于开展检查的通知" });
		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m3-sec",
			sessionId: "m3-s-sec",
			prompt,
			systemPrompt: card.systemPrompt,
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		await orchestrator.run("m3-sec", prompt);

		// 读系统文件被权限门拦下
		const blocked = audit.filter((a) => a.decision === "blocked");
		expect(blocked.some((a) => a.tool === "read_document" && a.rule === "system")).toBe(true);

		// 写逃逸路径没有产出文件到工作区外
		expect(existsSync(join(ws, "..", "..", "逃逸.docx"))).toBe(false);
	});
});
