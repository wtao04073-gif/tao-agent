/**
 * docx 产物校验
 *
 * 与 [xlsx 校验](./validate.ts) 同一条原则：**生成后必须做打开校验**。
 * 写出去一份 Word 打不开的文件，用户会当着客户或专家组的面发现。
 *
 * 能力边界同样要说清楚：我们能验证**文件能被重新解析、结构完整、
 * 标题与表格未退化**；不能验证「在 WPS 里肉眼看着对不对」——
 * 那需要真实 Office 环境，属于交付前人工抽检。
 */

import { readFile } from "node:fs/promises";
import { readDocx } from "./docx-reader.ts";
import type { ValidationIssue } from "./validate.ts";

export interface DocxValidationResult {
	readonly ok: boolean;
	readonly issues: readonly ValidationIssue[];
	readonly stats: {
		readonly paragraphs: number;
		readonly headings: number;
		readonly tables: number;
		readonly bytes: number;
	};
}

/** docx 是 zip 容器，合法文件以 PK 开头。 */
const ZIP_MAGIC = "PK";

export async function validateDocx(
	path: string,
	options: {
		readonly expectHeadings?: boolean;
		readonly expectTables?: number;
	} = {},
): Promise<DocxValidationResult> {
	const issues: ValidationIssue[] = [];
	const empty = { paragraphs: 0, headings: 0, tables: 0, bytes: 0 };

	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch (error) {
		return {
			ok: false,
			issues: [
				{
					severity: "error",
					message: `文件无法读取：${error instanceof Error ? error.message : String(error)}`,
				},
			],
			stats: empty,
		};
	}

	// 先查容器格式。不合法的话下面的解析会抛一个难懂的底层异常
	if (bytes.subarray(0, 2).toString("latin1") !== ZIP_MAGIC) {
		return {
			ok: false,
			issues: [{ severity: "error", message: "文件不是合法的 docx（缺少 zip 容器标识）" }],
			stats: { ...empty, bytes: bytes.length },
		};
	}

	let parsed: Awaited<ReturnType<typeof readDocx>>;
	try {
		// 能否重新解析回来是最基本的可用性验证
		parsed = await readDocx(path);
	} catch (error) {
		return {
			ok: false,
			issues: [
				{
					severity: "error",
					message: `文件无法解析：${error instanceof Error ? error.message : String(error)}`,
				},
			],
			stats: { ...empty, bytes: bytes.length },
		};
	}

	const headings = parsed.paragraphs.filter((p) => p.isHeading).length;

	if (parsed.total === 0) {
		issues.push({ severity: "error", message: "文档没有任何内容" });
	}

	if (options.expectHeadings === true && headings === 0) {
		// 标题层级是审核材料的骨架，退化成普通段落就没法按指标逐条对照
		issues.push({
			severity: "error",
			message: "预期含标题层级，但未发现任何标题（文档结构可能已退化为纯段落）",
		});
	}

	if (options.expectTables !== undefined && parsed.tableCount < options.expectTables) {
		issues.push({
			severity: "error",
			message: `预期含 ${options.expectTables} 个表格，实际只有 ${parsed.tableCount} 个`,
		});
	}

	return {
		ok: issues.every((i) => i.severity !== "error"),
		issues,
		stats: {
			paragraphs: parsed.total,
			headings,
			tables: parsed.tableCount,
			bytes: bytes.length,
		},
	};
}
