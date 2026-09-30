/**
 * Office 产物的真实文件往返测试
 *
 * 全部用**真实 xlsx 文件**，不 mock。理由：验收要求「产物在 Microsoft Office
 * 与 WPS 中打开版式正确、表格保留公式与数据格式」，而 mock 掉文件层
 * 恰好会把这类退化全部隐藏 —— 公式退化成文本、格式丢失，在 mock 里都看不见。
 */

import {
	mkdtempSync,
	rmSync,
	existsSync,
	readdirSync,
	readFileSync,
	linkSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { reconcile, type PlatformTool, type Row } from "@tao/core";
import { afterEach, describe, expect, it } from "vitest";
import { readSheet, listSheets } from "../src/xlsx-reader.ts";
import { writeReconcileReport } from "../src/xlsx-report.ts";
import { validateXlsx } from "../src/validate.ts";
import { createOfficeToolset } from "../src/toolset.ts";

const dirs: string[] = [];
const FIXED_TIME = new Date("2026-09-24T10:00:00Z");

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "office-test-"));
	dirs.push(dir);
	return dir;
}

/** 造一个真实的 xlsx 输入文件。 */
async function makeWorkbook(
	path: string,
	sheets: Array<{ name: string; columns: string[]; rows: unknown[][] }>,
): Promise<void> {
	const wb = new ExcelJS.Workbook();
	for (const sheet of sheets) {
		const ws = wb.addWorksheet(sheet.name);
		ws.addRow(sheet.columns);
		for (const row of sheet.rows) ws.addRow(row);
	}
	await wb.xlsx.writeFile(path);
}

const REPORT_OPTIONS = {
	title: "测试报告",
	leftLabel: "我方台账",
	rightLabel: "供应商对账单",
	keyColumns: ["物料编码"],
	generatedAt: FIXED_TIME,
};

describe("xlsx 读取", () => {
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("读出列名与数据行", async () => {
		const dir = tempDir();
		const path = join(dir, "in.xlsx");
		await makeWorkbook(path, [
			{ name: "台账", columns: ["物料编码", "数量", "金额"], rows: [["M-001", 100, 1000], ["M-002", 50, 500]] },
		]);

		const data = await readSheet(path);
		expect(data.name).toBe("台账");
		expect(data.columns).toEqual(["物料编码", "数量", "金额"]);
		expect(data.rows).toHaveLength(2);
		expect(data.rows[0]).toEqual({ 物料编码: "M-001", 数量: 100, 金额: 1000 });
	});

	it("公式单元格读出计算结果而非公式文本", async () => {
		// 核对的是数值。若读到 "B2-C2" 字符串，所有数值解析都会失败，
		// 产出一份「全部缺失」的报告。
		const dir = tempDir();
		const path = join(dir, "formula.xlsx");
		const wb = new ExcelJS.Workbook();
		const ws = wb.addWorksheet("表");
		ws.addRow(["物料编码", "数量"]);
		ws.addRow(["M-001", null]);
		// 带缓存结果的公式（真实文件被 Excel 保存后就是这个形态）
		ws.getCell("B2").value = { formula: "10*5", result: 50 };
		await wb.xlsx.writeFile(path);

		const data = await readSheet(path);
		expect(data.rows[0]?.["数量"]).toBe(50);
	});

	it("指定工作表名读取", async () => {
		const dir = tempDir();
		const path = join(dir, "multi.xlsx");
		await makeWorkbook(path, [
			{ name: "第一表", columns: ["a"], rows: [["x"]] },
			{ name: "第二表", columns: ["b"], rows: [["y"]] },
		]);

		expect(await listSheets(path)).toEqual(["第一表", "第二表"]);
		const data = await readSheet(path, "第二表");
		expect(data.columns).toEqual(["b"]);
	});

	it("工作表不存在时报错并列出可用表名", async () => {
		// 用户往往不知道确切表名，报错必须告诉他有哪些可选
		const dir = tempDir();
		const path = join(dir, "multi.xlsx");
		await makeWorkbook(path, [{ name: "台账", columns: ["a"], rows: [["x"]] }]);

		await expect(readSheet(path, "不存在的表")).rejects.toThrow(/台账/);
	});

	it("无表头时给出可读报错", async () => {
		const dir = tempDir();
		const path = join(dir, "empty.xlsx");
		const wb = new ExcelJS.Workbook();
		wb.addWorksheet("空表");
		await wb.xlsx.writeFile(path);

		await expect(readSheet(path)).rejects.toThrow(/表头/);
	});
});

describe("xlsx 报告产出", () => {
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const left: Row[] = [
		{ 物料编码: "M-001", 数量: 100 },
		{ 物料编码: "M-002", 数量: 50 },
		{ 物料编码: "ONLY-L", 数量: 7 },
	];
	const right: Row[] = [
		{ 物料编码: "M-001", 数量: 98 },
		{ 物料编码: "M-002", 数量: 50 },
		{ 物料编码: "ONLY-R", 数量: 3 },
	];

	it("产出的文件能被重新打开，含两个预期工作表", async () => {
		const dir = tempDir();
		const out = join(dir, "报告.xlsx");
		const result = reconcile(left, right, { keyColumns: ["物料编码"], compareColumns: ["数量"] });

		await writeReconcileReport(out, result, REPORT_OPTIONS);
		expect(existsSync(out)).toBe(true);

		const validation = await validateXlsx(out, { expectSheets: ["核对汇总", "差异明细"] });
		expect(validation.ok).toBe(true);
		expect(validation.stats.sheets).toBe(2);
	});

	it("目标是符号链接时落盘本身就失败，不跟随到链接目标", async () => {
		// 这一层是调用方前置检查的兜底：检查与 open 之间有时间窗，目标在窗内被换成
		// 链接时只有内核能拦住。所以直接对 writeReconcileReport 施加最坏情况 ——
		// 传进来的路径此刻就是链接，断言它抛错且外部目标一个字节都没动。
		const dir = tempDir();
		const outside = join(tempDir(), "别人的凭据.xlsx");
		writeFileSync(outside, "原始内容");
		const out = join(dir, "报告.xlsx");
		symlinkSync(outside, out);
		const result = reconcile(left, right, { keyColumns: ["物料编码"], compareColumns: ["数量"] });

		await expect(writeReconcileReport(out, result, REPORT_OPTIONS)).rejects.toThrow();
		expect(readFileSync(outside, "utf8")).toBe("原始内容");
	});

	it("目标是指向工作区外的硬链接时外部文件不被改写", async () => {
		// 硬链接是同一个 inode 的另一个名字，没有任何「链接形态」可供 lstat 或
		// O_NOFOLLOW 识别 —— 原地 O_TRUNC 会连带截断工作区外那个名字指向的同一份
		// 数据。断言必须落在「外部内容一字未动」上：只断言抛错不足以证明没写出去。
		const dir = tempDir();
		const outside = join(tempDir(), "别人的凭据.xlsx");
		writeFileSync(outside, "原始内容");
		const before = statSync(outside).ino;
		const out = join(dir, "报告.xlsx");
		linkSync(outside, out); // 同 inode，两个名字
		const result = reconcile(left, right, { keyColumns: ["物料编码"], compareColumns: ["数量"] });

		await expect(writeReconcileReport(out, result, REPORT_OPTIONS)).rejects.toThrow(/硬链接/);
		expect(readFileSync(outside, "utf8")).toBe("原始内容");
		expect(statSync(outside).ino).toBe(before);
	});

	it("覆盖同名报告时换成新 inode，不原地截断旧数据", async () => {
		// 落盘走「临时文件 + 原子 rename」，rename 只改目录项。既有产物的 inode
		// 因此不会被动过，任何指向它的外部名字都保住原内容。
		const dir = tempDir();
		const out = join(dir, "报告.xlsx");
		writeFileSync(out, "上一轮的产物");
		const before = statSync(out).ino;
		const result = reconcile(left, right, { keyColumns: ["物料编码"], compareColumns: ["数量"] });

		await writeReconcileReport(out, result, REPORT_OPTIONS);

		expect(statSync(out).ino).not.toBe(before);
		const validation = await validateXlsx(out, { expectSheets: ["核对汇总", "差异明细"] });
		expect(validation.ok).toBe(true);
	});

	it("产出成功后目录里只剩报告本身，没有临时文件残留", async () => {
		// 临时文件是实现细节，泄漏到工作区会被用户当成产物，也会污染下一轮的目录扫描
		const dir = tempDir();
		const out = join(dir, "报告.xlsx");
		const result = reconcile(left, right, { keyColumns: ["物料编码"], compareColumns: ["数量"] });

		await writeReconcileReport(out, result, REPORT_OPTIONS);

		expect(readdirSync(dir)).toEqual(["报告.xlsx"]);
	});

	it("差额列是公式而非硬编码值（验收要求保留公式）", async () => {
		const dir = tempDir();
		const out = join(dir, "报告.xlsx");
		const result = reconcile(left, right, { keyColumns: ["物料编码"], compareColumns: ["数量"] });
		await writeReconcileReport(out, result, REPORT_OPTIONS);

		const wb = new ExcelJS.Workbook();
		await wb.xlsx.readFile(out);
		const detail = wb.getWorksheet("差异明细");
		expect(detail).toBeDefined();

		// 找到 M-001 那一行（数值不一致，两侧都有值 → 应有公式）
		const cell = detail?.getCell("E2");
		expect(cell?.type).toBe(ExcelJS.ValueType.Formula);
		expect(JSON.stringify(cell?.value)).toContain("C2-D2");
	});

	it("一侧缺失时差额留空而非填 0", async () => {
		// 填 0 会让用户以为「数量相等」，实际是对方根本没有这条
		const dir = tempDir();
		const out = join(dir, "报告.xlsx");
		const result = reconcile(left, right, { keyColumns: ["物料编码"], compareColumns: ["数量"] });
		await writeReconcileReport(out, result, REPORT_OPTIONS);

		const wb = new ExcelJS.Workbook();
		await wb.xlsx.readFile(out);
		const detail = wb.getWorksheet("差异明细");

		// 找出「缺失」类型的行，其差额单元格应为空
		let checked = 0;
		detail?.eachRow({ includeEmpty: false }, (row, rowNumber) => {
			if (rowNumber === 1) return;
			const kind = String(row.getCell(6).value ?? "");
			if (kind.includes("缺失")) {
				const delta = row.getCell(5).value;
				expect(delta === null || delta === undefined).toBe(true);
				checked += 1;
			}
		});
		expect(checked).toBeGreaterThan(0); // 确保真的检查到了缺失行
	});

	it("数字格式被保留（不退化为纯文本）", async () => {
		const dir = tempDir();
		const out = join(dir, "报告.xlsx");
		const result = reconcile(left, right, { keyColumns: ["物料编码"], compareColumns: ["数量"] });
		await writeReconcileReport(out, result, REPORT_OPTIONS);

		const validation = await validateXlsx(out, { expectFormulas: true });
		expect(validation.ok).toBe(true);
		expect(validation.stats.formulaCells).toBeGreaterThan(0);
		expect(validation.stats.formattedCells).toBeGreaterThan(0);
	});

	it("汇总页含结论行，无差异时明确写「完全一致」", async () => {
		const dir = tempDir();
		const out = join(dir, "一致.xlsx");
		const same: Row[] = [{ 物料编码: "M-001", 数量: 100 }];
		const result = reconcile(same, same, { keyColumns: ["物料编码"], compareColumns: ["数量"] });
		await writeReconcileReport(out, result, REPORT_OPTIONS);

		const wb = new ExcelJS.Workbook();
		await wb.xlsx.readFile(out);
		const summary = wb.getWorksheet("核对汇总");
		let found = false;
		summary?.eachRow({ includeEmpty: false }, (row) => {
			if (String(row.getCell(1).value) === "核对结论") {
				expect(String(row.getCell(2).value)).toContain("完全一致");
				found = true;
			}
		});
		expect(found).toBe(true);
	});

	it("重复键在汇总页被显式提示", async () => {
		// 静默处理会让用户误以为核对通过
		const dir = tempDir();
		const out = join(dir, "重复.xlsx");
		const dup: Row[] = [
			{ 物料编码: "M-001", 数量: 10 },
			{ 物料编码: "M-001", 数量: 20 },
		];
		const result = reconcile(dup, [{ 物料编码: "M-001", 数量: 10 }], {
			keyColumns: ["物料编码"],
			compareColumns: ["数量"],
		});
		await writeReconcileReport(out, result, REPORT_OPTIONS);

		const wb = new ExcelJS.Workbook();
		await wb.xlsx.readFile(out);
		const summary = wb.getWorksheet("核对汇总");
		const texts: string[] = [];
		summary?.eachRow({ includeEmpty: false }, (row) => {
			texts.push(String(row.getCell(1).value ?? ""));
		});
		expect(texts.join("|")).toContain("重复");
	});

	it("差异明细页冻结表头（几千行时仍可读）", async () => {
		const dir = tempDir();
		const out = join(dir, "报告.xlsx");
		const result = reconcile(left, right, { keyColumns: ["物料编码"], compareColumns: ["数量"] });
		await writeReconcileReport(out, result, REPORT_OPTIONS);

		const wb = new ExcelJS.Workbook();
		await wb.xlsx.readFile(out);
		const detail = wb.getWorksheet("差异明细");
		expect(detail?.views?.[0]).toMatchObject({ state: "frozen", ySplit: 1 });
	});
});

describe("产物校验", () => {
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("损坏的文件校验失败而非抛异常", async () => {
		// 校验器自己崩掉的话，调用方无法区分「文件坏」与「校验器坏」
		const dir = tempDir();
		const bad = join(dir, "坏文件.xlsx");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(bad, "这不是一个 xlsx 文件");

		const result = await validateXlsx(bad);
		expect(result.ok).toBe(false);
		expect(result.issues[0]?.severity).toBe("error");
	});

	it("不存在的文件校验失败", async () => {
		const result = await validateXlsx("/tmp/根本不存在的文件.xlsx");
		expect(result.ok).toBe(false);
	});

	it("预期有公式但实际没有时报错（检出退化为纯文本）", async () => {
		const dir = tempDir();
		const plain = join(dir, "无公式.xlsx");
		await makeWorkbook(plain, [{ name: "表", columns: ["a"], rows: [["x"]] }]);

		const result = await validateXlsx(plain, { expectFormulas: true });
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => i.message.includes("纯文本"))).toBe(true);
	});

	it("缺少预期工作表时报错", async () => {
		const dir = tempDir();
		const path = join(dir, "少表.xlsx");
		await makeWorkbook(path, [{ name: "只有这个", columns: ["a"], rows: [["x"]] }]);

		const result = await validateXlsx(path, { expectSheets: ["核对汇总"] });
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => i.message.includes("核对汇总"))).toBe(true);
	});
});

describe("reconcile_tables 的产出边界", () => {
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

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

	/** 备好工作区与两张可核对的输入表，返回工具与路径。 */
	async function setup(): Promise<{ ws: string; tool: PlatformTool; args: Record<string, unknown> }> {
		const ws = tempDir();
		const ours = join(ws, "台账.xlsx");
		const theirs = join(ws, "对账单.xlsx");
		await makeWorkbook(ours, [
			{ name: "表", columns: ["物料编码", "数量"], rows: [["M-001", 100]] },
		]);
		await makeWorkbook(theirs, [
			{ name: "表", columns: ["物料编码", "数量"], rows: [["M-001", 98]] },
		]);

		const tool = createOfficeToolset({ workspace: ws, now: () => FIXED_TIME }).find(
			(t) => t.name === "reconcile_tables",
		);
		if (tool === undefined) throw new Error("reconcile_tables 未注册");

		return {
			ws,
			tool,
			args: {
				leftPath: ours,
				rightPath: theirs,
				keyColumns: ["物料编码"],
				compareColumns: ["数量"],
			},
		};
	}

	it("输出名含路径时被拒绝（安全边界）", async () => {
		// outputName 不是登记的路径参数，权限门不看它 —— 这里是唯一的拦截点。
		// 放过去就能覆写工作区外的任意文件（别的租户产物、凭据）。
		const { ws, tool, args } = await setup();
		const escapes = ["../../逃逸.xlsx", "子目录/报告.xlsx", "..\\逃逸.xlsx", "/tmp/逃逸.xlsx"];

		for (const outputName of escapes) {
			const result = await call(tool, { ...args, outputName });
			expect(result.isError).toBe(true);
			expect(result.text).toContain("不能包含路径");
		}

		// 反向确认：一个文件都没写出去
		expect(existsSync(join(ws, "..", "逃逸.xlsx"))).toBe(false);
		expect(existsSync("/tmp/逃逸.xlsx")).toBe(false);
	});

	it("纯文件名正常产出在工作区内", async () => {
		// 与上一条成对 —— 否则「全都拒绝」也能让上一条通过
		const { ws, tool, args } = await setup();
		const result = await call(tool, { ...args, outputName: "对账结果.xlsx" });

		expect(result.isError).toBeUndefined();
		expect(existsSync(join(ws, "对账结果.xlsx"))).toBe(true);
	});

	it("产出位置是指向工作区外的符号链接时被拒绝", async () => {
		// 词法校验只看字符串，看不到工作区里已经躺着一条同名链接 —— 模型给一个
		// 完全干净的纯文件名就能穿过去。断言必须落到「外部目标内容没变」上：
		// 只断言返回错误无法排除「先写出去、再报错」。
		const { ws, tool, args } = await setup();
		const outside = join(tempDir(), "别人的凭据.xlsx");
		writeFileSync(outside, "原始内容");
		symlinkSync(outside, join(ws, "报告.xlsx"));

		const result = await call(tool, { ...args, outputName: "报告.xlsx" });

		expect(result.isError).toBe(true);
		expect(result.text).toContain("符号链接");
		expect(readFileSync(outside, "utf8")).toBe("原始内容");
	});

	it("工作区内的子目录是外部链接时不接受产出", async () => {
		// 链接可以出现在父目录这一层。这里的 outputName 本身含 `/` 会先被词法层拦下，
		// 但仍要确认外部目录没有被写进任何东西 —— 两层校验的结论应当一致。
		const { ws, tool, args } = await setup();
		const outsideDir = tempDir();
		symlinkSync(outsideDir, join(ws, "外链"));

		const result = await call(tool, { ...args, outputName: "外链/报告.xlsx" });

		expect(result.isError).toBe(true);
		expect(existsSync(join(outsideDir, "报告.xlsx"))).toBe(false);
	});

	it("产出位置是指向工作区外的硬链接时被拒绝，外部文件不被改写", async () => {
		// 词法层、realpath 父目录、lstat 符号链接、O_NOFOLLOW 全都放硬链接过去 ——
		// 它在文件系统里跟一个普通文件长得一模一样。唯一的迹象是 nlink > 1，说明
		// 这份数据在工作区外还有入口。关键断言仍是外部内容与 inode 都没动。
		const { ws, tool, args } = await setup();
		const outside = join(tempDir(), "别人的凭据.xlsx");
		writeFileSync(outside, "原始内容");
		const before = statSync(outside).ino;
		linkSync(outside, join(ws, "报告.xlsx"));

		const result = await call(tool, { ...args, outputName: "报告.xlsx" });

		expect(result.isError).toBe(true);
		expect(result.text).toContain("硬链接");
		expect(readFileSync(outside, "utf8")).toBe("原始内容");
		expect(statSync(outside).ino).toBe(before);
	});

	it("工作区自身经由符号链接给出时仍能正常产出", async () => {
		// realpath 比对的反面用例：调用方传进来的 workspace 本身是链接（容器里挂载
		// 目录常见），此时父目录的真实路径与 workspace 字面量不同，不能因此误拒。
		const real = tempDir();
		const link = join(tempDir(), "工作区");
		symlinkSync(real, link);

		const ours = join(real, "台账.xlsx");
		const theirs = join(real, "对账单.xlsx");
		await makeWorkbook(ours, [
			{ name: "表", columns: ["物料编码", "数量"], rows: [["M-001", 100]] },
		]);
		await makeWorkbook(theirs, [
			{ name: "表", columns: ["物料编码", "数量"], rows: [["M-001", 98]] },
		]);

		const tool = createOfficeToolset({ workspace: link, now: () => FIXED_TIME }).find(
			(t) => t.name === "reconcile_tables",
		);
		if (tool === undefined) throw new Error("reconcile_tables 未注册");

		const result = await call(tool, {
			leftPath: ours,
			rightPath: theirs,
			keyColumns: ["物料编码"],
			compareColumns: ["数量"],
			outputName: "对账结果.xlsx",
		});

		expect(result.isError).toBeUndefined();
		expect(existsSync(join(real, "对账结果.xlsx"))).toBe(true);
	});

	it("覆盖同名的已有报告仍然允许", async () => {
		// 加链接校验不能把「重跑一次核对」这种正常用法一起挡掉
		const { ws, tool, args } = await setup();
		const first = await call(tool, { ...args, outputName: "对账结果.xlsx" });
		expect(first.isError).toBeUndefined();

		const second = await call(tool, { ...args, outputName: "对账结果.xlsx" });
		expect(second.isError).toBeUndefined();
		expect(existsSync(join(ws, "对账结果.xlsx"))).toBe(true);

		// 覆盖走的是 rename 而非原地截断，所以要确认顶上去的确实是完整可用的报告，
		// 而不是一个空壳或半截文件 —— 「没报错」本身证明不了这件事
		const validation = await validateXlsx(join(ws, "对账结果.xlsx"), {
			expectSheets: ["核对汇总", "差异明细"],
			expectFormulas: true,
		});
		expect(validation.ok).toBe(true);
	});
});
