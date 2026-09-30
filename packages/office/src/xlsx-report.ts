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

import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
 *
 * 落盘不走 `workbook.xlsx.writeFile` —— 它内部是 `fs.createWriteStream(path)`，
 * 会跟随符号链接，且直接对目标 `O_TRUNC`。而目标是否安全这件事，字符串层面
 * 根本判定不了：
 *
 *  - 符号链接：调用方虽已拒过「目标是链接」，但那次检查与真正打开之间存在
 *    时间窗，期间目标被换成链接就能把写入引到工作区外。
 *  - **硬链接**：它就是同一个 inode 的另一个名字，文件系统层面与「原始文件」
 *    完全无从区分 —— `lstat`/`isFile`/`O_NOFOLLOW` 全都照过，`O_TRUNC` 却会
 *    连带截断工作区外那个名字指向的同一份数据。
 *
 * 所以这里不去「判断目标安不安全再原地截断」，而是**根本不碰既有目标**：在同
 * 目录内用 `O_EXCL` 建一个随机名临时文件（`O_EXCL` 保证不会撞上已存在的任何
 * 链接），写完再 `rename` 顶上去。`rename` 只改目录项、不动旧 inode，硬链接
 * 指向的外部数据因此毫发无伤；顺带产出也变成原子的，中途失败不会留半截文件。
 * 临时文件与目标同目录，`rename` 才保证在同一文件系统内、不会退化成跨设备拷贝。
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

	// 目标此刻的形态先看一眼。下面的临时文件 + rename 已经保证写入不可能越界，
	// 这里显式拒绝是为了把「这个位置本来就不该被当成报告覆盖」如实报给调用方，
	// 而不是悄悄把别人的目录项顶掉。目标不存在是首次产出的常态。
	let existing: Stats | undefined;
	try {
		existing = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existing?.isSymbolicLink() === true) {
		throw new Error(`产出位置是符号链接，拒绝写出：${path}`);
	}
	if (existing !== undefined && existing.nlink > 1) {
		// 多于一个名字意味着这份数据在工作区外还有入口，动它等于改写别处的文件。
		throw new Error(`产出位置被多个硬链接共享，拒绝写出：${path}`);
	}

	// 临时名必须随机，否则攻击者能预先在这个名字上放好链接等我们写进去；
	// 必须与目标同目录，rename 才保证在同一文件系统内、不会退化成跨设备拷贝。
	// O_EXCL 则保证这个名字此刻确实是空的，撞上任何已存在的条目都直接失败。
	const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
	const handle = await open(
		temporary,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
		0o666,
	);
	try {
		try {
			// 刚建出来的文件只该有一个名字。真有人抢在写入前给它再挂一个，报告内容
			// 就同时暴露在工作区外，此时宁可作废这次产出。
			const opened = await handle.stat();
			if (opened.nlink !== 1) {
				throw new Error(`临时产出文件被额外硬链接，已放弃写出：${path}`);
			}
			const stream = handle.createWriteStream();
			await new Promise<void>((settle, fail) => {
				stream.on("finish", () => settle());
				stream.on("error", fail);
				workbook.xlsx
					.write(stream)
					.then(() => stream.end())
					.catch(fail);
			});
		} finally {
			// 流关闭 fd 后重复 close 是幂等的，放在 finally 里保证中途出错也不泄漏
			await handle.close();
		}
		// rename 只改目录项、不碰目标原来的 inode —— 外部硬链接仍指向旧数据，
		// 同时读取方看到的要么是旧报告要么是新报告，不会撞上半截文件。
		await rename(temporary, path);
	} catch (error) {
		// 失败路径不留垃圾：临时文件对用户毫无意义，清不掉也不该盖过真正的错误
		await unlink(temporary).catch(() => {});
		throw error;
	}
	return path;
}
