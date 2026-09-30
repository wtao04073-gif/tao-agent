/**
 * M1 验收：制造业供应商对账场景端到端
 *
 * 这是 M1 的门禁。验收标准（来自[技术方案](../../docs/tech-design.md) §5.2）：
 * **单租户单场景打通：上传 Excel → Agent 核对 → 产出 xlsx。**
 *
 * 全链路用真东西：真实 xlsx 输入、真实 Pi 内核、真实权限门、真实产出文件。
 * 只有模型是假的（离线固定响应）—— 因为要验证的是**我们的**链路是否正确，
 * 而模型输出的随机性会让断言无法稳定。
 *
 * 场景取自真实业务：质量/采购岗每月拿供应商对账单核对自家台账，
 * 差异要出正式报告发回供应商。这类任务的付费动机是「通过审核与客户验厂」。
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../vendor/pi/agent/src/harness/session/session.ts";
import { createPermissionGate, TaskStatus, type AuditEntry, type TaskEvent } from "@tao/core";
import { createOfficeToolset, OFFICE_TOOL_POLICIES, validateXlsx } from "@tao/office";
import { InProcessRunnerFactory } from "@tao/agent-host";
import { TaskOrchestrator } from "@tao/orchestrator";
import { afterEach, describe, expect, it } from "vitest";

const TENANT = { tenantId: "manufacturer-001", workspaceId: "quality-dept", userId: "zhang" };
const dirs: string[] = [];
const sessions: StorageBackedSession[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "m1-e2e-"));
	dirs.push(dir);
	return dir;
}

/**
 * 造两张真实的对账表。
 *
 * 数据刻意包含真实业务里的脏形态，而非理想数据：
 *  - 字符串数字（从 ERP 导出常见）
 *  - 会计格式负数
 *  - 千分位
 *  - 大小写与空白不一致的编码
 *  - 一方独有的行
 */
async function makeReconcileInputs(dir: string): Promise<{ ours: string; theirs: string }> {
	const ours = join(dir, "我方台账.xlsx");
	const theirs = join(dir, "供应商对账单.xlsx");

	const wb1 = new ExcelJS.Workbook();
	const ws1 = wb1.addWorksheet("台账");
	ws1.addRow(["物料编码", "数量", "金额"]);
	ws1.addRow(["M-1001", 500, 12500]);
	ws1.addRow(["M-1002", "1,200", "30,000"]); // 千分位字符串
	ws1.addRow(["m-1003 ", 80, 2400]); // 大小写+空白
	ws1.addRow(["M-1004", 60, 1800]); // 仅我方有
	await wb1.xlsx.writeFile(ours);

	const wb2 = new ExcelJS.Workbook();
	const ws2 = wb2.addWorksheet("对账单");
	ws2.addRow(["物料编码", "数量", "金额"]);
	ws2.addRow(["M-1001", 500, 12500]); // 完全一致
	ws2.addRow(["M-1002", 1200, 29500]); // 金额差 500
	ws2.addRow(["M-1003", 78, 2340]); // 数量差 2、金额差 60
	ws2.addRow(["M-1005", 30, 900]); // 仅对方有
	await wb2.xlsx.writeFile(theirs);

	return { ours, theirs };
}

/** 装配完整的产品链路。 */
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
	const tools = createOfficeToolset({
		workspace: ws,
		now: () => new Date("2026-09-24T10:00:00Z"),
	});

	const gate = createPermissionGate({
		policies: [...OFFICE_TOOL_POLICIES],
		workspace: ws,
		audit: (entry) => void audit.push(entry),
	});

	return { orchestrator, faux, tools, gate, audit };
}

const SYSTEM_PROMPT = "你是制造业办公助手，帮助用户核对供应商对账单与我方台账。";

describe("M1 验收 · 供应商对账端到端", () => {
	afterEach(async () => {
		for (const s of sessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("完整链路：提交任务 → Agent 核对 → 产出可用的 xlsx 报告", async () => {
		const ws = workspace();
		const { ours, theirs } = await makeReconcileInputs(ws);
		const { orchestrator, faux, tools, gate } = await assemble(ws);

		// 模型的决策序列：先看表结构，再核对
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read_table", { path: ours })]),
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
			fauxAssistantMessage("核对完成，已生成差异报告。共发现 5 处差异，请查阅附件。"),
		]);

		const events: TaskEvent[] = [];
		orchestrator.subscribe((e) => void events.push(e));

		// —— 用户提交任务 ——
		const submitted = await orchestrator.submit({
			tenant: TENANT,
			taskId: "task-reconcile-001",
			sessionId: "session-001",
			prompt: "核对我方台账与供应商对账单，按物料编码匹配，比较数量和金额",
			systemPrompt: SYSTEM_PROMPT,
			tools,
			gate,
		});
		expect(submitted.status).toBe(TaskStatus.Queued);

		// —— 执行 ——
		const finished = await orchestrator.run(
			"task-reconcile-001",
			"核对我方台账与供应商对账单，按物料编码匹配，比较数量和金额",
		);

		// ① 任务成功
		expect(finished.status).toBe(TaskStatus.Succeeded);

		// ② 产物真实存在
		const report = join(ws, "对账差异报告.xlsx");
		expect(existsSync(report)).toBe(true);

		// ③ 产物可打开、结构正确、公式未退化（验收核心）
		const validation = await validateXlsx(report, {
			expectFormulas: true,
			expectSheets: ["核对汇总", "差异明细"],
		});
		expect(validation.ok).toBe(true);
		expect(validation.stats.formulaCells).toBeGreaterThan(0);

		// ④ 步骤级进度可见，且用业务语言
		const steps = events.filter((e) => e.type === "step");
		expect(steps.length).toBeGreaterThan(0);
		const actions = steps.map((e) => (e.type === "step" ? e.action : "")).join("|");
		expect(actions).toContain("核对两张表并产出报告");
		// 不泄漏内部工具名
		expect(actions).not.toContain("reconcile_tables");

		// ⑤ 每条事件都带租户标识
		for (const event of events) {
			expect(event.tenant.tenantId).toBe(TENANT.tenantId);
		}
	});

	it("核对结果正确：脏数据被正确规范化，差异与独有行都识别出来", async () => {
		// 这条验的是业务正确性 —— 产物能打开不等于内容对
		const ws = workspace();
		const { ours, theirs } = await makeReconcileInputs(ws);
		const { orchestrator, faux, tools, gate } = await assemble(ws);

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: ours,
					rightPath: theirs,
					keyColumns: ["物料编码"],
					compareColumns: ["数量", "金额"],
					leftLabel: "我方台账",
					rightLabel: "供应商对账单",
					outputName: "结果.xlsx",
				}),
			]),
			fauxAssistantMessage("完成"),
		]);

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "task-2",
			sessionId: "session-2",
			prompt: "核对",
			systemPrompt: SYSTEM_PROMPT,
			tools,
			gate,
		});
		await orchestrator.run("task-2", "核对");

		// 读产出的报告，验证内容
		const wb = new ExcelJS.Workbook();
		await wb.xlsx.readFile(join(ws, "结果.xlsx"));
		const detail = wb.getWorksheet("差异明细");
		expect(detail).toBeDefined();

		const rows: Array<{ key: string; column: string; kind: string }> = [];
		detail?.eachRow({ includeEmpty: false }, (row, n) => {
			if (n === 1) return;
			rows.push({
				key: String(row.getCell(1).value ?? ""),
				column: String(row.getCell(2).value ?? ""),
				kind: String(row.getCell(6).value ?? ""),
			});
		});

		// M-1001 完全一致 → 不应出现在差异里
		expect(rows.some((r) => r.key === "M-1001")).toBe(false);

		// M-1002 金额差 500（千分位字符串被正确解析）
		expect(rows.some((r) => r.key === "M-1002" && r.column === "金额")).toBe(true);
		// 数量 "1,200" 与 1200 应视为相等，不报差异
		expect(rows.some((r) => r.key === "M-1002" && r.column === "数量")).toBe(false);

		// M-1003 两列都有差异（"m-1003 " 与 "M-1003" 被规范化为同一键，
		// 否则会误报成「两边各缺一条」）
		expect(rows.filter((r) => r.key === "M-1003")).toHaveLength(2);

		// 独有行被识别
		expect(rows.some((r) => r.key === "M-1004" && r.kind.includes("缺失"))).toBe(true);
		expect(rows.some((r) => r.key === "M-1005" && r.kind.includes("缺失"))).toBe(true);

		// 汇总页的结论是「存在差异」
		const summary = wb.getWorksheet("核对汇总");
		let verdict = "";
		summary?.eachRow({ includeEmpty: false }, (row) => {
			if (String(row.getCell(1).value) === "核对结论") verdict = String(row.getCell(2).value);
		});
		expect(verdict).toContain("存在差异");
	});

	it("执行中插入追问：任务不中断，消息按「当前步骤完成后送达」入队", async () => {
		// 这是用户最在意的能力。口径必须准确 —— 内核 steering 永不打断
		// 执行中的工具，承诺「立即打断」是无法兑现的。
		const ws = workspace();
		const { ours, theirs } = await makeReconcileInputs(ws);
		const { orchestrator, faux, tools, gate } = await assemble(ws);

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: ours,
					rightPath: theirs,
					keyColumns: ["物料编码"],
					compareColumns: ["数量"],
					outputName: "r.xlsx",
				}),
			]),
			fauxAssistantMessage("核对完成"),
		]);

		const events: TaskEvent[] = [];
		orchestrator.subscribe((e) => void events.push(e));

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "task-3",
			sessionId: "session-3",
			prompt: "核对",
			systemPrompt: SYSTEM_PROMPT,
			tools,
			gate,
		});

		// 任务执行与插话并发发出
		const running = orchestrator.run("task-3", "核对");
		await orchestrator.steer("task-3", "顺便告诉我差异最大的是哪个物料");
		const finished = await running;

		// 任务照常完成，没有被打断
		expect(finished.status).toBe(TaskStatus.Succeeded);
		expect(existsSync(join(ws, "r.xlsx"))).toBe(true);

		// 插话事件的投递语义是「排队等当前步骤完成」
		const messages = events.filter((e) => e.type === "user_message");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.type === "user_message" ? messages[0].delivery : "").toBe(
			"queued_after_current_step",
		);
	});

	it("安全防线在真实链路上生效：索取系统文件被拦下且记审计", async () => {
		const ws = workspace();
		const { orchestrator, faux, tools, gate, audit } = await assemble(ws);

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read_table", { path: "/etc/passwd" })]),
			fauxAssistantMessage("无法读取该文件"),
		]);

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "task-4",
			sessionId: "session-4",
			prompt: "读一下 /etc/passwd",
			systemPrompt: SYSTEM_PROMPT,
			tools,
			gate,
		});
		await orchestrator.run("task-4", "读一下 /etc/passwd");

		expect(audit).toHaveLength(1);
		expect(audit[0]?.decision).toBe("blocked");
		expect(audit[0]?.rule).toBe("system");
	});

	it("列名写错时给出可操作的报错，而非产出一份全是缺失的报告", async () => {
		// 真实场景：用户或模型把列名写错（「数量」vs「件数」）。
		// 若静默核对，会产出一份「所有行都缺失」的报告，用户看不出原因。
		const ws = workspace();
		const { ours, theirs } = await makeReconcileInputs(ws);
		const { orchestrator, faux, tools, gate } = await assemble(ws);

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: ours,
					rightPath: theirs,
					keyColumns: ["物料编码"],
					compareColumns: ["件数"], // 不存在的列
					outputName: "x.xlsx",
				}),
			]),
			fauxAssistantMessage("列名有误，已提示用户"),
		]);

		const ended = await (async () => {
			await orchestrator.submit({
				tenant: TENANT,
				taskId: "task-5",
				sessionId: "session-5",
				prompt: "核对",
				systemPrompt: SYSTEM_PROMPT,
				tools,
				gate,
			});
			return orchestrator.run("task-5", "核对");
		})();

		// 工具返回错误但任务本身完成（模型收到错误后可重试或告知用户）
		expect(ended.status).toBe(TaskStatus.Succeeded);
		// 不产出误导性的报告文件
		expect(existsSync(join(ws, "x.xlsx"))).toBe(false);
	});

	it("完全一致时报告明确写「完全一致」，不让用户猜", async () => {
		const ws = workspace();
		const same = join(ws, "同一份.xlsx");
		const wb = new ExcelJS.Workbook();
		const sheet = wb.addWorksheet("表");
		sheet.addRow(["物料编码", "数量"]);
		sheet.addRow(["M-1", 10]);
		await wb.xlsx.writeFile(same);

		const { orchestrator, faux, tools, gate } = await assemble(ws);
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: same,
					rightPath: same,
					keyColumns: ["物料编码"],
					compareColumns: ["数量"],
					outputName: "一致.xlsx",
				}),
			]),
			fauxAssistantMessage("两表完全一致"),
		]);

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "task-6",
			sessionId: "session-6",
			prompt: "核对",
			systemPrompt: SYSTEM_PROMPT,
			tools,
			gate,
		});
		const done = await orchestrator.run("task-6", "核对");
		expect(done.status).toBe(TaskStatus.Succeeded);

		const out = new ExcelJS.Workbook();
		await out.xlsx.readFile(join(ws, "一致.xlsx"));
		let verdict = "";
		out.getWorksheet("核对汇总")?.eachRow({ includeEmpty: false }, (row) => {
			if (String(row.getCell(1).value) === "核对结论") verdict = String(row.getCell(2).value);
		});
		expect(verdict).toContain("完全一致");
	});
});
