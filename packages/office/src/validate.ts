/**
 * 产物校验
 *
 * 验收要求：**生成后必须做打开校验**，确认版式正确，校验不通过则自动重试或降级。
 *
 * 这条要求不是形式主义 —— 直接对手的公开短板正是「导出到 WPS/Office 后
 * 格式跑偏」。我们把它做成可攻击的正面战场，前提是自己先不犯这个错。
 *
 * 一期的校验能力边界要说清楚：我们能验证**文件结构合法、能被重新打开、
 * 公式与格式未退化**；不能验证「在 WPS 里肉眼看着对不对」——
 * 那需要真实 Office 环境，属于交付前的人工抽检范畴。
 */

import ExcelJS from "exceljs";

export interface ValidationIssue {
	readonly severity: "error" | "warning";
	readonly message: string;
}

export interface ValidationResult {
	readonly ok: boolean;
	readonly issues: readonly ValidationIssue[];
	readonly stats: {
		readonly sheets: number;
		readonly totalRows: number;
		readonly formulaCells: number;
		readonly formattedCells: number;
	};
}

/**
 * 校验一个生成的 xlsx。
 *
 * @param expectFormulas 是否预期含公式。为真且实际无公式时报错 ——
 *   公式退化成纯文本是我们明确要防的退化（验收要求）。
 */
export async function validateXlsx(
	path: string,
	options: { expectFormulas?: boolean; expectSheets?: readonly string[] } = {},
): Promise<ValidationResult> {
	const issues: ValidationIssue[] = [];

	const workbook = new ExcelJS.Workbook();
	try {
		// 能否重新打开是最基本的可用性验证 —— 写出去打不开的文件比没有更糟
		await workbook.xlsx.readFile(path);
	} catch (error) {
		return {
			ok: false,
			issues: [
				{
					severity: "error",
					message: `文件无法打开：${error instanceof Error ? error.message : String(error)}`,
				},
			],
			stats: { sheets: 0, totalRows: 0, formulaCells: 0, formattedCells: 0 },
		};
	}

	let totalRows = 0;
	let formulaCells = 0;
	let formattedCells = 0;

	for (const worksheet of workbook.worksheets) {
		let sheetRows = 0;
		worksheet.eachRow({ includeEmpty: false }, (row) => {
			sheetRows += 1;
			row.eachCell({ includeEmpty: false }, (cell) => {
				if (cell.type === ExcelJS.ValueType.Formula) formulaCells += 1;
				if (cell.numFmt !== undefined && cell.numFmt !== "General") formattedCells += 1;
			});
		});
		totalRows += sheetRows;

		if (sheetRows === 0) {
			issues.push({ severity: "warning", message: `工作表「${worksheet.name}」是空的` });
		}
	}

	if (workbook.worksheets.length === 0) {
		issues.push({ severity: "error", message: "工作簿不含任何工作表" });
	}

	for (const expected of options.expectSheets ?? []) {
		if (workbook.getWorksheet(expected) === undefined) {
			issues.push({ severity: "error", message: `缺少预期的工作表「${expected}」` });
		}
	}

	if (options.expectFormulas === true && formulaCells === 0) {
		// 这正是「表格退化为纯文本」的症状
		issues.push({
			severity: "error",
			message: "预期包含公式，但未发现任何公式单元格（表格可能已退化为纯文本）",
		});
	}

	return {
		ok: issues.every((i) => i.severity !== "error"),
		issues,
		stats: {
			sheets: workbook.worksheets.length,
			totalRows,
			formulaCells,
			formattedCells,
		},
	};
}
