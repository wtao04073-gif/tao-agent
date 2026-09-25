/**
 * M3-5 验收：子任务并行端到端
 *
 * 场景取自真实业务：高校「多部门数据交叉核对」要分别核对教务处、学生处、
 * 财务处上报的数据，这些子任务互不依赖，串行做要等三倍时间。
 *
 * 验证重点是**真并行**而非「结果正确」——后者在串行实现下也会通过。
 * 所以断言用时序与并发峰值，不只看产出。
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
	allSucceeded,
	collectArtifacts,
	createPermissionGate,
	describeResults,
	fanOut,
	subSessionId,
	type AuditEntry,
	type SubTask,
	type SubTaskProgress,
} from "@tao/core";
import { createOfficeToolset, OFFICE_TOOL_POLICIES } from "@tao/office";
import { InProcessRunnerFactory } from "@tao/agent-host";
import { afterEach, describe, expect, it } from "vitest";

const TENANT = { tenantId: "univ-004", workspaceId: "data-gov", userId: "wu" };

const dirs: string[] = [];
const sessions: StorageBackedSession[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "m3e-e2e-"));
	dirs.push(dir);
	return dir;
}

/** 造三个部门各自上报的表，与一份基准表。 */
async function makeDeptTables(dir: string): Promise<{ base: string; depts: string[] }> {
	const base = join(dir, "基准表.xlsx");
	const wb = new ExcelJS.Workbook();
	const ws = wb.addWorksheet("基准");
	ws.addRow(["学院", "人数"]);
	ws.addRow(["计算机学院", 1200]);
	ws.addRow(["机械学院", 900]);
	await wb.xlsx.writeFile(base);

	const depts: string[] = [];
	// 每个部门的数字略有差异 —— 真实场景就是这样才需要核对
	for (const [name, cs, ms] of [
		["教务处", 1200, 900],
		["学生处", 1195, 900],
		["财务处", 1200, 898],
	] as const) {
		const path = join(dir, `${name}上报.xlsx`);
		const book = new ExcelJS.Workbook();
		const sheet = book.addWorksheet("上报");
		sheet.addRow(["学院", "人数"]);
		sheet.addRow(["计算机学院", cs]);
		sheet.addRow(["机械学院", ms]);
		await book.xlsx.writeFile(path);
		depts.push(path);
	}

	return { base, depts };
}

/**
 * 为一个子任务装配独立的执行环境。
 *
 * 一子任务一 Session（[Spike 5](../spikes/05-subagent-parallel/) 的设计依据）。
 * 每个子任务也有独立的假模型 —— 否则共用响应队列会让并行变成抢答。
 */
async function runSubTask(
	task: SubTask,
	sessionId: string,
	ws: string,
	audit: AuditEntry[],
	delayMs: number,
	/** 记录模型调用的时间窗，用于判定是否真并行。 */
	window?: Array<{ id: string; start: number; end: number }>,
): Promise<{ status: "succeeded" | "failed"; artifacts: string[]; error?: string }> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);

	const factory = new InProcessRunnerFactory({
		async createSession(id) {
			const session = new StorageBackedSession(
				{ id, createdAt: 1, storageVersion: 1 },
				new MemoryStorage(),
			);
			sessions.push(session);
			return session;
		},
		models,
		model: faux.getModel(),
		now: () => 1_700_000_000_000,
	});

	const tools = createOfficeToolset({ workspace: ws, now: () => new Date("2026-09-25T10:00:00Z") });
	const gate = createPermissionGate({
		policies: [...OFFICE_TOOL_POLICIES],
		workspace: ws,
		audit: (entry) => void audit.push(entry),
	});

	const outputName = `${task.label}核对结果.xlsx`;
	faux.setResponses([
		async () => {
			// 模拟模型思考耗时 —— 时序是并行与串行的唯一区分手段
			const start = Date.now();
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			window?.push({ id: task.id, start, end: Date.now() });
			return fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: task.prompt.split("|")[0],
					rightPath: task.prompt.split("|")[1],
					keyColumns: ["学院"],
					compareColumns: ["人数"],
					leftLabel: "基准",
					rightLabel: task.label,
					outputName,
				}),
			]);
		},
		fauxAssistantMessage("核对完成"),
	]);

	const runner = await factory.createRunner({
		tenant: TENANT,
		taskId: task.id,
		sessionId,
		systemPrompt: "你是数据核对助手",
		tools,
		gate,
	});

	try {
		await runner.prompt(task.prompt);

		/**
		 * 按**产物是否真的存在**判定成功，不是「prompt 没抛错」。
		 *
		 * 这是写测试时查出的一个判断缺陷：工具报错（如文件不存在）时，
		 * 内核把错误返给模型让它重试或告知用户，`prompt()` **正常 resolve**。
		 * 所以「没抛错」只说明任务流程走完了，不说明产出了东西。
		 *
		 * 在扇出场景里这个区别很致命：某个部门的文件坏了却报成功，
		 * 用户拿着缺一份数据的汇总去交付。
		 */
		const output = join(ws, outputName);
		if (!existsSync(output)) {
			return { status: "failed", artifacts: [], error: "子任务未产出文件" };
		}
		return { status: "succeeded", artifacts: [output] };
	} finally {
		await runner.close();
	}
}

describe("M3-5 验收 · 子任务并行", () => {
	afterEach(async () => {
		for (const s of sessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("三个部门并行核对：产出齐全且真的并行", async () => {
		const ws = workspace();
		const { base, depts } = await makeDeptTables(ws);
		const audit: AuditEntry[] = [];

		const tasks: SubTask[] = depts.map((path, i) => ({
			id: `dept-${i}`,
			label: ["教务处", "学生处", "财务处"][i] as string,
			prompt: `${base}|${path}`,
		}));

		let running = 0;
		let peak = 0;
		const progress: SubTaskProgress[] = [];
		/** 各子任务的模型调用时间窗。判定并行用它，不用总耗时。 */
		const windows: Array<{ id: string; start: number; end: number }> = [];

		const results = await fanOut(tasks, {
			tenant: TENANT,
			parentTaskId: "parent-crosscheck",
			maxConcurrency: 3,
			onProgress: (e) => void progress.push(e),
			async run(task, sessionId) {
				running += 1;
				peak = Math.max(peak, running);
				try {
					const outcome = await runSubTask(task, sessionId, ws, audit, 40, windows);
					return {
						id: task.id,
						label: task.label,
						status: outcome.status,
						summary: "核对完成",
						artifacts: outcome.artifacts,
					};
				} finally {
					running -= 1;
				}
			},
		});

		// ① 全部成功
		expect(allSucceeded(results)).toBe(true);

		// ② 真的并行 —— 用时间窗重叠判定，而非总耗时。
		//    总耗时含 xlsx 读写的 IO 开销，会让阈值变成对机器性能的断言；
		//    时间窗重叠直接反映「三个模型调用同时在飞」这件事。
		expect(peak).toBe(3);
		expect(windows).toHaveLength(3);
		const latestStart = Math.max(...windows.map((w) => w.start));
		const earliestEnd = Math.min(...windows.map((w) => w.end));
		// 最晚开始的那个，在最早结束的那个之前就已开始 → 三者有共同的重叠区间
		expect(latestStart).toBeLessThan(earliestEnd);

		// ③ 三份产出都在
		const artifacts = collectArtifacts(results);
		expect(artifacts).toHaveLength(3);
		for (const path of artifacts) {
			expect(existsSync(path), path).toBe(true);
		}

		// ④ 各部门的差异被分别识别出来（业务正确性）
		const xuesheng = artifacts.find((p) => p.includes("学生处"));
		expect(xuesheng).toBeDefined();
		const book = new ExcelJS.Workbook();
		await book.xlsx.readFile(xuesheng!);
		let verdict = "";
		book.getWorksheet("核对汇总")?.eachRow({ includeEmpty: false }, (row) => {
			if (String(row.getCell(1).value) === "核对结论") verdict = String(row.getCell(2).value);
		});
		// 学生处的计算机学院人数是 1195 vs 1200
		expect(verdict).toContain("存在差异");

		// ⑤ 进度上报完整
		expect(progress.filter((e) => e.phase === "succeeded")).toHaveLength(3);
		expect(progress.at(-1)?.done).toBe(3);
	});

	it("每个子任务分到独立 Session（Spike 5 的设计依据）", async () => {
		const ws = workspace();
		const { base, depts } = await makeDeptTables(ws);
		const audit: AuditEntry[] = [];

		const tasks: SubTask[] = depts.slice(0, 2).map((path, i) => ({
			id: `d-${i}`,
			label: `部门${i}`,
			prompt: `${base}|${path}`,
		}));

		const seenSessions: string[] = [];
		await fanOut(tasks, {
			tenant: TENANT,
			parentTaskId: "parent-iso",
			async run(task, sessionId) {
				seenSessions.push(sessionId);
				const outcome = await runSubTask(task, sessionId, ws, audit, 5);
				return { id: task.id, label: task.label, status: outcome.status };
			},
		});

		expect(new Set(seenSessions).size).toBe(2);
		// 能从子会话追回父任务
		expect(seenSessions.every((s) => s.includes("parent-iso"))).toBe(true);
		expect(seenSessions).toContain(subSessionId("parent-iso", "d-0"));
	});

	it("一个部门的文件坏了，其他部门的结果仍然保留", async () => {
		// 这是失败隔离的实际价值：用户宁可拿到 2 个部门的结果加一条错误说明，
		// 也不想因为一个部门的文件损坏而什么都没有
		const ws = workspace();
		const { base, depts } = await makeDeptTables(ws);
		const audit: AuditEntry[] = [];

		const tasks: SubTask[] = [
			{ id: "good-1", label: "教务处", prompt: `${base}|${depts[0]}` },
			// 指向不存在的文件
			{ id: "broken", label: "学生处", prompt: `${base}|${join(ws, "不存在.xlsx")}` },
			{ id: "good-2", label: "财务处", prompt: `${base}|${depts[2]}` },
		];

		const results = await fanOut(tasks, {
			tenant: TENANT,
			parentTaskId: "parent-partial",
			maxConcurrency: 3,
			async run(task, sessionId) {
				const outcome = await runSubTask(task, sessionId, ws, audit, 5);
				return {
					id: task.id,
					label: task.label,
					status: outcome.status,
					artifacts: outcome.artifacts,
				};
			},
		});

		// 三条结果都在，顺序与输入一致
		expect(results.map((r) => r.id)).toEqual(["good-1", "broken", "good-2"]);
		expect(allSucceeded(results)).toBe(false);

		// 两个好的部门产出真实存在
		const good = results.filter((r) => r.id !== "broken");
		for (const result of good) {
			for (const path of result.artifacts ?? []) {
				expect(existsSync(path), path).toBe(true);
			}
		}
	});

	it("汇总说明显式警告产出不完整", async () => {
		// 只给成功的结果会让用户以为全做完了，交付时才发现缺数据
		const summary = describeResults([
			{ id: "a", label: "教务处", status: "succeeded", summary: "2 处差异" },
			{ id: "b", label: "学生处", status: "failed", error: "文件无法打开" },
			{ id: "c", label: "财务处", status: "succeeded", summary: "1 处差异" },
		]);

		expect(summary).toContain("成功 2 个");
		expect(summary).toContain("失败 1 个");
		expect(summary).toContain("学生处");
		expect(summary).toContain("请勿直接对外提交");
	});

	it("并发受限时仍然全部完成，只是分批", async () => {
		const ws = workspace();
		const { base, depts } = await makeDeptTables(ws);
		const audit: AuditEntry[] = [];

		const tasks: SubTask[] = depts.map((path, i) => ({
			id: `b-${i}`,
			label: `部门${i}`,
			prompt: `${base}|${path}`,
		}));

		let peak = 0;
		let running = 0;
		const results = await fanOut(tasks, {
			tenant: TENANT,
			parentTaskId: "parent-batched",
			maxConcurrency: 1, // 强制串行
			async run(task, sessionId) {
				running += 1;
				peak = Math.max(peak, running);
				try {
					const outcome = await runSubTask(task, sessionId, ws, audit, 5);
					return { id: task.id, label: task.label, status: outcome.status };
				} finally {
					running -= 1;
				}
			},
		});

		expect(peak).toBe(1);
		expect(allSucceeded(results)).toBe(true);
	});

	it("每个子任务的权限门独立生效", async () => {
		const ws = workspace();
		const { base, depts } = await makeDeptTables(ws);
		const audit: AuditEntry[] = [];

		const tasks: SubTask[] = depts.slice(0, 2).map((path, i) => ({
			id: `p-${i}`,
			label: `部门${i}`,
			prompt: `${base}|${path}`,
		}));

		await fanOut(tasks, {
			tenant: TENANT,
			parentTaskId: "parent-gate",
			async run(task, sessionId) {
				const outcome = await runSubTask(task, sessionId, ws, audit, 5);
				return { id: task.id, label: task.label, status: outcome.status };
			},
		});

		// 每个子任务的工具调用都经过审计，且都带本租户标识
		expect(audit.length).toBeGreaterThanOrEqual(2);
		expect(audit.every((a) => a.decision === "allowed")).toBe(true);
	});
});
