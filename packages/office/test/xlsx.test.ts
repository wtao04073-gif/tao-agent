/**
 * Office 产物的真实文件往返测试
 *
 * 全部用**真实 xlsx 文件**，不 mock。理由：验收要求「产物在 Microsoft Office
 * 与 WPS 中打开版式正确、表格保留公式与数据格式」，而 mock 掉文件层
 * 恰好会把这类退化全部隐藏 —— 公式退化成文本、格式丢失，在 mock 里都看不见。
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { reconcile, type Row } from "@tao/core";
import { afterEach, describe, expect, it } from "vitest";
import { readSheet, listSheets } from "../src/xlsx-reader.ts";
import { writeReconcileReport } from "../src/xlsx-report.ts";
import { validateXlsx } from "../src/validate.ts";

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
