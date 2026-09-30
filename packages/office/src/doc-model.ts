/**
 * 文档模型
 *
 * 平台侧定义一套中立的文档结构，模型通过工具参数提交**结构化文档树**，
 * 而不是提交 Markdown 字符串由我们解析。
 *
 * 为什么这样取舍：
 *
 *  - Markdown 无法表达审核材料需要的东西 —— 合并单元格、表格列宽、
 *    页眉页脚、字体要求（体系文件常规定「正文宋体小四」）。
 *  - 让模型写 Markdown 再由我们解析，等于把「格式是否正确」变成
 *    解析器的猜测。结构化参数经 JSON Schema 校验，写错直接报错，
 *    不会静默产出一份格式错乱的文件。
 *  - 结构化之后每个块都有稳定身份，溯源才能定位到「哪一段」。
 *
 * 这套模型刻意**只覆盖办公文档实际用到的结构**。不做通用文档模型 ——
 * 每多一种块类型就多一处渲染分支与校验分支。
 */

/** 块类型。 */
export const BlockType = {
	/** 标题。level 1-4。 */
	Heading: "heading",
	/** 正文段落。 */
	Paragraph: "paragraph",
	/** 项目符号列表。 */
	BulletList: "bullet_list",
	/** 有序列表。 */
	NumberedList: "numbered_list",
	/** 表格。 */
	Table: "table",
	/** 分页符。长文档按章节分页是公文与体系文件的常见要求。 */
	PageBreak: "page_break",
} as const;

export type BlockType = (typeof BlockType)[keyof typeof BlockType];

/** 行内文本片段。用于在一段里混合普通与强调文本。 */
export interface InlineRun {
	readonly text: string;
	readonly bold?: boolean;
	readonly italic?: boolean;
	/**
	 * 标为「待补充」类占位内容。
	 *
	 * 渲染时会加醒目样式。这是刻意的产品决策：场景卡的 systemPrompt
	 * 要求模型对信息不足处标注「待补充」而非编造，那么产出里这些地方
	 * 必须**显眼**，否则用户会连着占位符一起交上去。
	 */
	readonly placeholder?: boolean;
}

export interface HeadingBlock {
	readonly type: typeof BlockType.Heading;
	readonly level: 1 | 2 | 3 | 4;
	readonly text: string;
}

export interface ParagraphBlock {
	readonly type: typeof BlockType.Paragraph;
	/** 纯文本，或带格式的片段序列。 */
	readonly text?: string;
	readonly runs?: readonly InlineRun[];
	/** 对齐。公文标题居中、落款右对齐。 */
	readonly align?: "left" | "center" | "right";
}

export interface ListBlock {
	readonly type: typeof BlockType.BulletList | typeof BlockType.NumberedList;
	readonly items: readonly string[];
}

export interface TableBlock {
	readonly type: typeof BlockType.Table;
	/** 表头。台账、检查表都有固定表头。 */
	readonly header: readonly string[];
	readonly rows: readonly (readonly string[])[];
}

export interface PageBreakBlock {
	readonly type: typeof BlockType.PageBreak;
}

export type DocBlock =
	| HeadingBlock
	| ParagraphBlock
	| ListBlock
	| TableBlock
	| PageBreakBlock;

/** 一份文档。 */
export interface DocModel {
	/** 文档标题。渲染为一级标题并写入文件属性。 */
	readonly title: string;
	readonly blocks: readonly DocBlock[];
	/**
	 * 正文字体。默认宋体 12pt。
	 *
	 * 体系文件与公文常有明确字体规定，写死会让产出被审核退回。
	 */
	readonly bodyFont?: string;
	readonly bodySizePt?: number;
}

export interface DocValidationIssue {
	/** 出问题的块序号。-1 表示文档级问题。 */
	readonly blockIndex: number;
	readonly message: string;
}

/**
 * 校验文档模型。
 *
 * 在渲染**之前**跑。理由：docx 库对畸形输入的反应是抛一个底层异常
 * （或更糟 —— 静默产出结构错乱的文件），错误信息指不到「第几块的表格行列数不齐」。
 * 自己先校验才能给出可操作的报错。
 */
export function validateDocModel(doc: DocModel): {
	readonly ok: boolean;
	readonly issues: readonly DocValidationIssue[];
} {
	const issues: DocValidationIssue[] = [];

	if (doc.title.trim() === "") {
		issues.push({ blockIndex: -1, message: "文档标题不能为空" });
	}
	if (doc.blocks.length === 0) {
		issues.push({ blockIndex: -1, message: "文档没有任何内容块" });
	}
	if (doc.bodySizePt !== undefined && (doc.bodySizePt < 5 || doc.bodySizePt > 72)) {
		issues.push({ blockIndex: -1, message: `正文字号 ${doc.bodySizePt}pt 不在合理范围（5-72）` });
	}

	doc.blocks.forEach((block, index) => {
		switch (block.type) {
			case BlockType.Heading: {
				if (block.text.trim() === "") {
					issues.push({ blockIndex: index, message: "标题文本为空" });
				}
				if (![1, 2, 3, 4].includes(block.level)) {
					issues.push({ blockIndex: index, message: `标题层级 ${block.level} 超出 1-4` });
				}
				break;
			}

			case BlockType.Paragraph: {
				const hasText = block.text !== undefined && block.text !== "";
				const hasRuns = block.runs !== undefined && block.runs.length > 0;
				if (!hasText && !hasRuns) {
					issues.push({ blockIndex: index, message: "段落既没有 text 也没有 runs" });
				}
				if (hasText && hasRuns) {
					// 两者都给会产生「哪个生效」的歧义，宁可报错
					issues.push({ blockIndex: index, message: "段落不能同时给 text 与 runs" });
				}
				break;
			}

			case BlockType.BulletList:
			case BlockType.NumberedList: {
				if (block.items.length === 0) {
					issues.push({ blockIndex: index, message: "列表没有条目" });
				}
				break;
			}

			case BlockType.Table: {
				if (block.header.length === 0) {
					issues.push({ blockIndex: index, message: "表格没有表头" });
					break;
				}
				// 列数不齐是最常见的畸形输入，且会让 Word 打开时提示文件损坏
				block.rows.forEach((row, rowIndex) => {
					if (row.length !== block.header.length) {
						issues.push({
							blockIndex: index,
							message: `表格第 ${rowIndex + 1} 行有 ${row.length} 列，表头有 ${block.header.length} 列`,
						});
					}
				});
				break;
			}

			case BlockType.PageBreak:
				break;
		}
	});

	return { ok: issues.length === 0, issues };
}

/**
 * 统计文档结构，用于产出后自检与给用户的概要。
 */
export function describeDocModel(doc: DocModel): {
	readonly headings: number;
	readonly paragraphs: number;
	readonly tables: number;
	readonly placeholders: number;
} {
	let headings = 0;
	let paragraphs = 0;
	let tables = 0;
	let placeholders = 0;

	for (const block of doc.blocks) {
		if (block.type === BlockType.Heading) headings += 1;
		else if (block.type === BlockType.Table) tables += 1;
		else if (block.type === BlockType.Paragraph) {
			paragraphs += 1;
			for (const run of block.runs ?? []) {
				if (run.placeholder === true) placeholders += 1;
			}
		}
	}

	return { headings, paragraphs, tables, placeholders };
}
