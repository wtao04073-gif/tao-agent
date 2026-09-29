/**
 * 同名产物跨任务隔离（真实办公工具 + 任务专属产物目录）
 *
 * 对应缺陷：两个任务用相同默认输出名时，产物都写到共享工作区根而互相覆盖，
 * 下载又固定取共享根那一个文件，于是跨任务串档。
 *
 * 本用例直接驱动真实 reconcile_tables 工具，把两个任务的 workspace 指向
 * 同一个共享根下的两个任务产物目录（与 main.ts 的 toolsFor 装配一致），
 * 输入资料放在共享根，断言：
 *  - 两个任务各自产出同名「对账差异报告.xlsx」且内容不同、互不覆盖；
 *  - resolveRegisteredArtifact 分别只返回本任务登记的路径；
 *  - 共享根同名文件不会被误取，越界路径返回 undefined。
 */

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import ExcelJS from "exceljs";
import { createOfficeToolset, OFFICE_TOOL_POLICIES } from "@tao/office";
import { createPermissionGate, type ToolDecision } from "@tao/core";
import { resolveRegisteredArtifact, taskArtifactDir } from "@tao/server";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "tao-artiso-"));
	dirs.push(dir);
	return dir;
}

async function writeLedger(path: string, amount: number): Promise<void> {
	const wb = new ExcelJS.Workbook();
	const ws = wb.addWorksheet("台账");
	ws.addRow(["物料编码", "金额"]);
	ws.addRow(["M-1", amount]);
	await wb.xlsx.writeFile(path);
}

async function writeBill(path: string, amount: number): Promise<void> {
	const wb = new ExcelJS.Workbook();
	const ws = wb.addWorksheet("对账单");
	ws.addRow(["物料编码", "金额"]);
	ws.addRow(["M-1", amount]);
	await wb.xlsx.writeFile(path);
}

/** 在指定产物目录执行真实 reconcile_tables，返回产出的绝对路径。 */
async function runReconcile(
	artifactWorkspace: string,
	leftPath: string,
	rightPath: string,
): Promise<string> {
	const tool = createOfficeToolset({ workspace: artifactWorkspace }).find((t) => t.name === "reconcile_tables");
	if (tool === undefined) throw new Error("缺少 reconcile_tables 工具");
	const outcome = await tool.execute({
		args: {
			leftPath,
			rightPath,
			keyColumns: ["物料编码"],
			compareColumns: ["金额"],
			leftLabel: "我方台账",
			rightLabel: "供应商对账单",
			outputName: "对账差异报告.xlsx",
		},
		tenant: { tenantId: "t", workspaceId: "w", userId: "u" },
		taskId: "ignored",
		report: () => undefined,
		signal: new AbortController().signal,
	});
	if (outcome.isError === true) throw new Error(outcome.text);
	const outputPath = (outcome.details as { outputPath?: string }).outputPath;
	if (outputPath === undefined) throw new Error("工具未返回 outputPath");
	return outputPath;
}

describe("同名产物跨任务隔离", () => {
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("两个任务同名报告分别落在各自产物目录，下载各取本任务内容", async () => {
		const root = workspace();
		const dirA = taskArtifactDir(root, "task-a");
		const dirB = taskArtifactDir(root, "task-b");
		mkdirSync(dirA, { recursive: true });
		mkdirSync(dirB, { recursive: true });
		// 共享根放输入资料（用户上传）：两个任务都从共享根读输入
		const ours = join(root, "我方台账.xlsx");
		await writeLedger(ours, 1000);
		// 任务 A：账单 1000（与台账一致）；任务 B：账单 2000（有差异）
		const billA = join(root, "对账单A.xlsx");
		const billB = join(root, "对账单B.xlsx");
		await writeBill(billA, 1000);
		await writeBill(billB, 2000);

		const outA = await runReconcile(dirA, ours, billA);
		const outB = await runReconcile(dirB, ours, billB);

		expect(outA.startsWith(dirA)).toBe(true);
		expect(outB.startsWith(dirB)).toBe(true);
		expect(basename(outA)).toBe(basename(outB));
		const bytesA = readFileSync(outA);
		const bytesB = readFileSync(outB);
		expect(bytesA.equals(bytesB)).toBe(false);

		// 下载解析各取登记的完整路径，绝不串到另一任务或共享根
		const dlA = resolveRegisteredArtifact({ workspaceRoot: root, artifacts: [outA], name: basename(outA) });
		const dlB = resolveRegisteredArtifact({ workspaceRoot: root, artifacts: [outB], name: basename(outB) });
		expect(dlA).toBe(outA);
		expect(dlB).toBe(outB);
		expect(readFileSync(dlA as string).equals(bytesA)).toBe(true);
		expect(readFileSync(dlB as string).equals(bytesB)).toBe(true);

		// A 任务拿不到 B 的产物（登记列表不含 B 的路径）
		expect(
			resolveRegisteredArtifact({ workspaceRoot: root, artifacts: [outA], name: basename(outB) }),
		).toBe(outA);

		// 越界 / 路径段一律 404 语义
		expect(resolveRegisteredArtifact({ workspaceRoot: root, artifacts: [outA], name: "../x" })).toBeUndefined();
	});
});

/**
 * 执行侧隔离（缺陷 b42875facf58）：权限门 workspace 收窄到本任务产物目录、
 * 输入仅文件级白名单后，知道其他任务产物路径也读不到。
 *
 * 与 main.ts submitTask 的装配同口径：
 *   createPermissionGate({ workspace: taskArtifactDir(root, taskA),
 *                          grantedDirs: [], allowedFiles: [表单引用的上传文件] })
 */
describe("执行侧跨任务隔离 · 权限门收窄 + 文件级白名单", () => {
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	async function buildGateForTaskA(root: string) {
		const dirA = taskArtifactDir(root, "task-a");
		const dirB = taskArtifactDir(root, "task-b");
		mkdirSync(dirA, { recursive: true });
		mkdirSync(dirB, { recursive: true });

		// 共享根层的上传文件：A 表单只引用「我方台账.xlsx」
		const referenced = join(root, "我方台账.xlsx");
		const unreferenced = join(root, "别人的台账.xlsx");
		await writeLedger(referenced, 1000);
		writeFileSync(unreferenced, "not-for-a");
		// B 任务的产物
		const bArtifact = join(dirB, "对账差异报告.xlsx");
		writeFileSync(bArtifact, "B-SECRET");
		const aArtifact = join(dirA, "对账差异报告.xlsx");
		writeFileSync(aArtifact, "A-OWN");

		const gate = createPermissionGate({
			policies: [...OFFICE_TOOL_POLICIES],
			workspace: dirA,
			grantedDirs: [],
			allowedFiles: [referenced],
		});
		const decide = (path: string): Promise<ToolDecision> =>
			gate({
				toolName: "read_table",
				args: { path },
				tenant: { tenantId: "t", workspaceId: "w", userId: "u" },
				taskId: "task-a",
			});
		return { decide, referenced, unreferenced, bArtifact, aArtifact };
	}

	it("读不到其他任务的产物，读得到本任务产物与表单引用的输入", async () => {
		const root = workspace();
		const { decide, referenced, unreferenced, bArtifact, aArtifact } = await buildGateForTaskA(root);

		// 其他任务产物：知道绝对路径也必须被执行侧拦下
		expect((await decide(bArtifact)).kind).toBe("block");
		// 同目录未被表单引用的上传文件：文件级白名单不扩权
		expect((await decide(unreferenced)).kind).toBe("block");
		// 本任务表单引用的上传输入：精确命中白名单
		expect((await decide(referenced)).kind).toBe("allow");
		// 本任务自己的产物：workspace 子树命中
		expect((await decide(aArtifact)).kind).toBe("allow");
	});

	it("真实 read_table 对其他任务产物在工具执行前即被门拒绝", async () => {
		const root = workspace();
		const { decide, referenced, bArtifact } = await buildGateForTaskA(root);

		// 门返回 block 时，内核不会调用工具 execute（M0 Spike 3 已验证），
		// 这里直接断言决策为 blocked，确保越权读取在执行前被切断。
		const blocked = await decide(bArtifact);
		expect(blocked.kind).toBe("block");

		// 白名单输入可被真实 list_sheets 工具读取（经门放行）
		expect((await decide(referenced)).kind).toBe("allow");
		const tool = createOfficeToolset({
			workspace: taskArtifactDir(root, "task-a"),
		}).find((t) => t.name === "list_sheets");
		if (tool === undefined) throw new Error("缺少 list_sheets");
		const outcome = await tool.execute({
			args: { path: referenced },
			tenant: { tenantId: "t", workspaceId: "w", userId: "u" },
			taskId: "task-a",
			report: () => undefined,
			signal: new AbortController().signal,
		});
		expect(outcome.isError !== true).toBe(true);
	});
});
