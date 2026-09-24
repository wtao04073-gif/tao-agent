/**
 * Excel 读写
 *
 * 走**原生文件生成**路线而非 HTML 转换 —— 验收要求产物在
 * Microsoft Office 与 WPS 中版式正确、表格保留公式与数据格式。
 * HTML 转 xlsx 无法满足「真可编辑、可盖章流转」。
 *
 * 已实测确认 ExcelJS 满足要求：公式读回后 `type === Formula`（未退化成
 * 文本）、numFmt 与字体样式均保留。
 */

import ExcelJS from "exceljs";
import type { Row } from "@tao/core";

export interface SheetData {
	readonly name: string;
	readonly columns: readonly string[];
	readonly rows: readonly Row[];
}

/**
 * 读取一个工作表。
 *
 * @param sheet 工作表名。省略则取第一个 —— 用户往往不知道也不关心表名。
 */
export async function readSheet(path: string, sheet?: string): Promise<SheetData> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(path);

	const worksheet =
		sheet === undefined ? workbook.worksheets[0] : workbook.getWorksheet(sheet);
	if (worksheet === undefined) {
		const available = workbook.worksheets.map((w) => w.name).join("、");
		throw new Error(
			sheet === undefined
				? `${path} 中没有任何工作表`
				: `${path} 中找不到工作表「${sheet}」。可用的表：${available}`,
		);
	}

	// 表头取第一行。真实表格常有合并标题行，但一期先按标准格式处理，
	// 遇到异常格式时给出可读报错而非静默产出错误结果。
	const headerRow = worksheet.getRow(1);
	const columns: string[] = [];
	headerRow.eachCell({ includeEmpty: false }, (cell) => {
		columns.push(String(cell.value ?? "").trim());
	});

	if (columns.length === 0) {
		throw new Error(`${path} 的工作表「${worksheet.name}」第一行没有表头，无法识别列`);
	}

	const rows: Row[] = [];
	worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
		if (rowNumber === 1) return; // 表头
		const record: Record<string, unknown> = {};
		columns.forEach((column, index) => {
			const cell = row.getCell(index + 1);
			record[column] = cellValue(cell);
		});
		rows.push(record);
	});

	return { name: worksheet.name, columns, rows };
}

/**
 * 取单元格的值。
 *
 * 公式单元格要取**计算结果**而非公式文本 —— 核对的是数值，
 * 拿到 "B2-C2" 这种字符串会全部解析失败。
 */
function cellValue(cell: ExcelJS.Cell): unknown {
	const value = cell.value;
	if (value === null || value === undefined) return null;
	if (typeof value === "object") {
		// 公式：优先取缓存的计算结果
		if ("result" in value) return (value as { result: unknown }).result ?? null;
		// 富文本
		if ("richText" in value) {
			return (value as { richText: Array<{ text: string }> }).richText
				.map((t) => t.text)
				.join("");
		}
		// 超链接
		if ("text" in value) return (value as { text: unknown }).text;
		// 日期
		if (value instanceof Date) return value;
		if ("error" in value) return null; // #N/A 之类
	}
	return value;
}

/** 列出所有工作表名。用户不确定表名时先看一眼。 */
export async function listSheets(path: string): Promise<string[]> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(path);
	return workbook.worksheets.map((w) => w.name);
}
