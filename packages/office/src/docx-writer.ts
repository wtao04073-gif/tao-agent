/**
 * docx 渲染
 *
 * 把中立的 [DocModel](./doc-model.ts) 渲染成 Word 文档。
 *
 * 渲染前必过校验（`validateDocModel`）—— docx 库对畸形输入
 * 要么抛底层异常，要么产出 Word 打不开的文件，两种都难排查。
 */

import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	AlignmentType,
	Document,
	HeadingLevel,
	Packer,
	Paragraph,
	Table,
	TableCell,
	TableRow,
	TextRun,
	WidthType,
} from "docx";
import {
	BlockType,
	type DocBlock,
	type DocModel,
	type InlineRun,
	validateDocModel,
} from "./doc-model.ts";

/** 默认正文字体。中文办公文档的事实标准。 */
const DEFAULT_FONT = "宋体";
const DEFAULT_SIZE_PT = 12;

/** docx 的 size 单位是半磅。 */
const halfPoints = (pt: number): number => Math.round(pt * 2);

const HEADING_LEVELS = {
	1: HeadingLevel.HEADING_1,
	2: HeadingLevel.HEADING_2,
	3: HeadingLevel.HEADING_3,
	4: HeadingLevel.HEADING_4,
} as const;

const ALIGNMENTS = {
	left: AlignmentType.LEFT,
	center: AlignmentType.CENTER,
	right: AlignmentType.RIGHT,
} as const;

/** 渲染行内片段。 */
function renderRun(run: InlineRun): TextRun {
	return new TextRun({
		text: run.text,
		...(run.bold === true ? { bold: true } : {}),
		...(run.italic === true ? { italics: true } : {}),
		/**
		 * 「待补充」占位加醒目样式。
		 *
		 * 场景卡要求模型对信息不足处标注待补充而非编造，那这些位置在产出里
		 * 必须显眼 —— 否则用户会连着占位符一起交给审核方。
		 */
		...(run.placeholder === true ? { highlight: "yellow", bold: true } : {}),
	});
}

/** 渲染一个块。返回数组因为表格与分页会产生额外元素。 */
function renderBlock(block: DocBlock): Array<Paragraph | Table> {
	switch (block.type) {
		case BlockType.Heading:
			return [new Paragraph({ text: block.text, heading: HEADING_LEVELS[block.level] })];

		case BlockType.Paragraph: {
			const children =
				block.runs !== undefined
					? block.runs.map(renderRun)
					: [new TextRun(block.text ?? "")];
			return [
				new Paragraph({
					children,
					...(block.align === undefined ? {} : { alignment: ALIGNMENTS[block.align] }),
				}),
			];
		}

		case BlockType.BulletList:
			return block.items.map((item) => new Paragraph({ text: item, bullet: { level: 0 } }));

		case BlockType.NumberedList:
			// numbering 需要在 Document 层声明 reference，这里用内置的有序列表
			return block.items.map(
				(item) => new Paragraph({ text: item, numbering: { reference: "tao-ordered", level: 0 } }),
			);

		case BlockType.Table: {
			const headerRow = new TableRow({
				tableHeader: true, // 跨页时表头重复 —— 台账动辄几十行
				children: block.header.map(
					(text) =>
						new TableCell({
							children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })],
						}),
				),
			});
			const bodyRows = block.rows.map(
				(row) =>
					new TableRow({
						children: row.map(
							(text) => new TableCell({ children: [new Paragraph(String(text))] }),
						),
					}),
			);
			return [
				new Table({
					width: { size: 100, type: WidthType.PERCENTAGE },
					rows: [headerRow, ...bodyRows],
				}),
			];
		}

		case BlockType.PageBreak:
			return [new Paragraph({ children: [], pageBreakBefore: true })];
	}
}

export interface WriteDocxResult {
	readonly path: string;
	readonly bytes: number;
}

/**
 * 渲染并写出 docx。
 *
 * `outputName` 只接受文件名，不接受路径 —— 产物一律落在工作区内。
 * 这不是便利性设计而是安全边界：允许模型指定任意输出路径等于绕过路径策略。
 */
export async function writeDocx(
	doc: DocModel,
	options: { readonly workspace: string; readonly outputName: string },
): Promise<WriteDocxResult> {
	const validation = validateDocModel(doc);
	if (!validation.ok) {
		const detail = validation.issues
			.map((i) => (i.blockIndex < 0 ? i.message : `第 ${i.blockIndex + 1} 块：${i.message}`))
			.join("；");
		throw new Error(`文档结构有误，无法生成：${detail}`);
	}

	if (options.outputName.includes("/") || options.outputName.includes("\\") || isAbsolute(options.outputName)) {
		throw new Error(`产出文件名不能包含路径：${options.outputName}`);
	}

	const font = doc.bodyFont ?? DEFAULT_FONT;
	const sizePt = doc.bodySizePt ?? DEFAULT_SIZE_PT;

	const children: Array<Paragraph | Table> = [
		new Paragraph({
			text: doc.title,
			heading: HeadingLevel.TITLE,
			alignment: AlignmentType.CENTER,
		}),
	];
	for (const block of doc.blocks) children.push(...renderBlock(block));

	const document = new Document({
		title: doc.title,
		styles: {
			default: {
				document: { run: { font, size: halfPoints(sizePt) } },
			},
		},
		numbering: {
			config: [
				{
					reference: "tao-ordered",
					levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }],
				},
			],
		},
		sections: [{ children }],
	});

	const buffer = await Packer.toBuffer(document);
	const path = join(options.workspace, options.outputName);
	await writeFile(path, buffer);

	return { path, bytes: buffer.length };
}
