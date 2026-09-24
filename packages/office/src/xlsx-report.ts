/**
 * 对账结果 → xlsx 报告
 *
 * 这是用户最终拿走的东西 —— 他要把它发给供应商、附到审核材料里。
 * 所以它必须是**可直接用的交付物**，不是数据转储：
 *
 *  - 有汇总页，让人三秒内知道「差了几笔、差多少钱」
 *  - 差异用公式计算而非硬编码数字，用户改了数据能自动重算（验收要求保留公式）
 *  - 差异标红、表头冻结、列宽合适 —— 否则用户还要自己排版
 */

import ExcelJS from "exceljs";
import { displayKey, type Difference, type ReconcileResult } from "@tao/core";

export interface ReportOptions {
	/** 报告标题，出现在汇总页。 */
	readonly title: string;
	/** 左表的业务名称，如「我方台账」。 */
	readonly leftLabel: string;
	/** 右表的业务名称，如「供应商对账单」。 */
	readonly rightLabel: string;
	/** 键列名称，用于表头展示。 */
	readonly keyColumns: readonly string[];
	/** 生成时间。注入以便测试可复现。 */
	readonly generatedAt: Date;
}

const RED = "FFCC0000";
const GREY = "FFF2F2F2";
const HEADER_FILL = "FFDCE6F1";

function styleHeader(row: ExcelJS.Row): void {
	row.font = { bold: true };
	row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
	row.alignment = { vertical: "middle" };
}

/** 差异类型的中文说明。用户看的是业务语言，不是枚举值。 */
function describeKind(kind: Difference["kind"], leftLabel: string, rightLabel: string): string {
	switch (kind) {
		case "value_mismatch":
			return "数值不一致";
		case "missing_left":
			return `${leftLabel}缺失`;
		case "missing_right":
			return `${rightLabel}缺失`;
	}
}

/**
 * 生成对账报告。
 *
 * 返回写入的文件路径。
 */
export async function writeReconcileReport(
	path: string,
	result: ReconcileResult,
	options: ReportOptions,
): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	workbook.creator = "Tao Agent";
	workbook.created = options.generatedAt;

	// ── 汇总页 ──
	// 放在第一个，因为用户打开文件最先看到的就是它
	const summary = workbook.addWorksheet("核对汇总");
	summary.columns = [
		{ header: "项目", key: "item", width: 28 },
		{ header: "结果", key: "value", width: 22 },
	];
	styleHeader(summary.getRow(1));

	const rows: Array<[string, string | number]> = [
		["报告标题", options.title],
		["生成时间", options.generatedAt.toISOString().slice(0, 19).replace("T", " ")],
		["核对键", options.keyColumns.join(" + ")],
		[`${options.leftLabel}行数`, result.summary.leftRows],
		[`${options.rightLabel}行数`, result.summary.rightRows],
		["完全一致条数", result.matched],
		["差异条数", result.summary.differenceCount],
		[`仅${options.leftLabel}存在`, result.onlyLeft.length],
		[`仅${options.rightLabel}存在`, result.onlyRight.length],
	];
	for (const [item, value] of rows) summary.addRow({ item, value });

	// 重复键是数据质量问题，必须显式提示 —— 静默处理会让用户误以为核对通过
	if (result.duplicateKeys.length > 0) {
		const row = summary.addRow({
			item: "⚠ 重复的键（已取首次出现）",
			value: result.duplicateKeys.length,
		});
		row.font = { color: { argb: RED }, bold: true };
	}

	// 结论行：让人一眼看到是否通过
	const verdict = summary.addRow({
		item: "核对结论",
		value: result.summary.differenceCount === 0 ? "✓ 完全一致" : "✗ 存在差异，请见明细",
	});
	verdict.font = {
		bold: true,
		color: { argb: result.summary.differenceCount === 0 ? "FF008000" : RED },
	};

	// ── 差异明细页 ──
	const detail = workbook.addWorksheet("差异明细");
	detail.columns = [
		{ header: options.keyColumns.join(" + "), key: "key", width: 26 },
		{ header: "比较列", key: "column", width: 16 },
		{ header: options.leftLabel, key: "left", width: 16 },
		{ header: options.rightLabel, key: "right", width: 16 },
		{ header: "差额", key: "delta", width: 16 },
		{ header: "差异类型", key: "kind", width: 18 },
	];
	styleHeader(detail.getRow(1));
	// 冻结表头，几千行时用户滚动仍知道每列是什么
	detail.views = [{ state: "frozen", ySplit: 1 }];

	result.differences.forEach((diff, index) => {
		const rowNumber = index + 2; // 表头占第 1 行
		const row = detail.addRow({
			key: displayKey(diff.key),
			column: diff.column,
			left: diff.left,
			right: diff.right,
			kind: describeKind(diff.kind, options.leftLabel, options.rightLabel),
		});

		// 差额用**公式**而非硬编码值：用户修正了某侧数字后能自动重算。
		// 这是验收要求「表格类产出保留公式，不退化为纯文本」的落点。
		if (diff.left !== null && diff.right !== null) {
			detail.getCell(`E${rowNumber}`).value = { formula: `C${rowNumber}-D${rowNumber}` };
		} else {
			// 一侧缺失时算不出差额，留空并在类型列说明，不填 0 误导用户
			detail.getCell(`E${rowNumber}`).value = null;
		}

		const numberFormat = "#,##0.00##";
		for (const col of ["C", "D", "E"]) {
			detail.getCell(`${col}${rowNumber}`).numFmt = numberFormat;
		}

		// 差异标红，让人扫一眼就能定位
		row.getCell("kind").font = { color: { argb: RED } };
		if (index % 2 === 1) {
			row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
		}
	});

	if (result.differences.length === 0) {
		const row = detail.addRow({ key: "（无差异）" });
		row.font = { color: { argb: "FF008000" }, italic: true };
	}

	await workbook.xlsx.writeFile(path);
	return path;
}
