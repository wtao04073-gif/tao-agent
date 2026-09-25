/**
 * docx 读取
 *
 * 读取端的核心设计是**按段落返回并带位置标识**，而不是返回一整块文本。
 *
 * 理由有两个，都很实际：
 *
 *  1. **溯源要能定位到「哪一段」。** 审核员指着自评报告某段问「这句话依据是什么」，
 *     系统要能答出「来自 XX制度.docx 第 12 段」。只返回全文就做不到。
 *  2. **上下文预算。** 评估指标文件动辄几十页，整篇塞进上下文会挤掉真正要处理的数据。
 *     按段落返回让调用方能分批处理。
 */

import mammoth from "mammoth";

/** 一个文档段落。 */
export interface DocParagraph {
	/**
	 * 段落序号，从 1 开始。
	 *
	 * 这是溯源的 locator。用序号而非字符偏移：字符偏移在文档被编辑后
	 * 完全失效，段落序号至少在局部编辑下仍大致可用。
	 */
	readonly index: number;
	readonly text: string;
	/** 是否看起来是标题。用于让调用方重建文档骨架。 */
	readonly isHeading: boolean;
	/** 标题层级。isHeading 为假时是 null。 */
	readonly headingLevel: number | null;
}

export interface ReadDocxResult {
	readonly paragraphs: readonly DocParagraph[];
	/** 段落总数。 */
	readonly total: number;
	/** 文档里的表格数量。 */
	readonly tableCount: number;
}

/** 从 mammoth 产出的 HTML 里判断标题层级。 */
function headingLevelOf(html: string): number | null {
	const match = /^<h([1-6])[^>]*>/.exec(html.trim());
	if (match === null) return null;
	return Number(match[1]);
}

/** 去掉 HTML 标签，还原实体。 */
function stripTags(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replaceAll("&nbsp;", " ")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		// & 必须最后解，否则会把上面解出来的实体再解一遍
		.replaceAll("&amp;", "&")
		.trim();
}

/**
 * 把表格 HTML 转成带分隔符的文本。
 *
 * 必须在去标签**之前**插入分隔符。直接 stripTags 会把单元格拼成
 * 「序号问题描述责任部门完成期限」—— 模型读到这种文本无法还原列边界，
 * 处理台账、检查表时会串列。
 */
function tableToText(html: string): string {
	const rows = html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
	return rows
		.map((row) => {
			const cells = row.match(/<t[hd][\s\S]*?<\/t[hd]>/g) ?? [];
			return cells.map(stripTags).join(" | ");
		})
		.filter((line) => line.replaceAll("|", "").trim() !== "")
		.join("\n");
}

/** 取出列表的各个条目。每个条目单独成段，便于按条引用。 */
function listItems(html: string): string[] {
	const items = html.match(/<li[\s\S]*?<\/li>/g) ?? [];
	return items.map(stripTags).filter((t) => t !== "");
}

export interface ReadDocxOptions {
	/** 从第几段开始读（1 起）。用于分批处理长文档。 */
	readonly fromParagraph?: number;
	/** 最多读多少段。 */
	readonly limit?: number;
}

/**
 * 读取 docx。
 *
 * 损坏的文件会抛错而非返回空 —— 静默返回空会让「文件坏了」
 * 被当成「文档是空的」，用户拿到一份莫名空白的产出还不知道原因。
 */
export async function readDocx(
	path: string,
	options: ReadDocxOptions = {},
): Promise<ReadDocxResult> {
	const { value: html } = await mammoth.convertToHtml({ path });

	// 按块级元素切分。嵌套列表用贪婪匹配会吞掉后续内容，
	// 所以 ul/ol 单独用非贪婪 + 逐个 li 处理
	const blocks = html.match(/<(h[1-6]|p|table|ul|ol)[\s\S]*?<\/\1>/g) ?? [];

	const all: DocParagraph[] = [];
	let tableCount = 0;

	const push = (text: string, level: number | null): void => {
		if (text === "") return; // 空段落是排版产物，不是内容
		all.push({
			index: all.length + 1,
			text,
			isHeading: level !== null,
			headingLevel: level,
		});
	};

	for (const block of blocks) {
		if (block.startsWith("<table")) {
			tableCount += 1;
			// 表格整体算一段，避免把一张表拆成几十段噪声；
			// 但单元格之间要有分隔符，否则模型无法还原列边界
			push(tableToText(block), null);
			continue;
		}

		if (block.startsWith("<ul") || block.startsWith("<ol")) {
			// 列表的每个条目单独成段：整改措施、检查要点都是逐条引用的
			for (const item of listItems(block)) push(item, null);
			continue;
		}

		push(stripTags(block), headingLevelOf(block));
	}

	const from = Math.max(1, options.fromParagraph ?? 1);
	const sliced =
		options.limit === undefined
			? all.slice(from - 1)
			: all.slice(from - 1, from - 1 + options.limit);

	return { paragraphs: sliced, total: all.length, tableCount };
}

/**
 * 提取文档骨架（只要标题）。
 *
 * 用在「按指标体系逐项撰写」这类场景：先拿到指标文件的层级结构，
 * 再逐项取对应内容，比一次读全文省得多。
 */
export async function readDocxOutline(path: string): Promise<readonly DocParagraph[]> {
	const { paragraphs } = await readDocx(path);
	return paragraphs.filter((p) => p.isHeading);
}
