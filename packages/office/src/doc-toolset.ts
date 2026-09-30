/**
 * 文档工具集
 *
 * `read_document` 与 `write_document`。这两个工具是 M2 那 8 张
 * 「只能提交、跑不到产出」的场景卡的唯一阻塞项。
 *
 * 与表格工具一致的两条原则：
 *  - 产出后必校验。写出去一份 Word 打不开的文件，比没有产出更糟 ——
 *    用户会当着客户或专家组的面发现。
 *  - 报错要可操作。「第 3 块表格第 2 行列数不齐」而不是一句「生成失败」。
 */

import { join } from "node:path";
import type { PlatformTool } from "@tao/core";
import {
	type DocBlock,
	type DocModel,
	describeDocModel,
	validateDocModel,
} from "./doc-model.ts";
import { readDocx, readDocxOutline } from "./docx-reader.ts";
import { writeDocx } from "./docx-writer.ts";
import { validateDocx } from "./validate-docx.ts";

export interface DocToolsetOptions {
	/** 任务工作区绝对路径。产物写在这里。 */
	readonly workspace: string;
}

/** 单次读取返回的最大段落数。长文档要分批，否则挤爆上下文。 */
const READ_PAGE_SIZE = 40;

/**
 * 文档块的 JSON Schema。
 *
 * 写得这么细是必要的：模型要照着它构造结构化文档树。
 * schema 含糊的直接后果是模型随意发挥，产出格式每次都不一样。
 */
const BLOCK_SCHEMA = {
	type: "object",
	properties: {
		type: {
			type: "string",
			enum: ["heading", "paragraph", "bullet_list", "numbered_list", "table", "page_break"],
			description: "块类型",
		},
		level: {
			type: "number",
			description: "标题层级 1-4。type 为 heading 时必填",
		},
		text: {
			type: "string",
			description: "文本内容。heading 必填；paragraph 用它写纯文本段落",
		},
		runs: {
			type: "array",
			description:
				"带格式的文本片段序列，用于段落内混合普通与强调文本。与 text 二选一，不可同时给",
			items: {
				type: "object",
				properties: {
					text: { type: "string" },
					bold: { type: "boolean" },
					italic: { type: "boolean" },
					placeholder: {
						type: "boolean",
						description:
							"标为「待补充」占位内容，渲染时会高亮。信息不足时用它，不要编造数据",
					},
				},
				required: ["text"],
			},
		},
		align: {
			type: "string",
			enum: ["left", "center", "right"],
			description: "对齐方式。公文标题居中、落款右对齐",
		},
		items: {
			type: "array",
			items: { type: "string" },
			description: "列表条目。type 为 bullet_list 或 numbered_list 时必填",
		},
		header: {
			type: "array",
			items: { type: "string" },
			description: "表头列名。type 为 table 时必填",
		},
		rows: {
			type: "array",
			description: "表格数据行。每行的列数必须与表头一致",
			items: { type: "array", items: { type: "string" } },
		},
	},
	required: ["type"],
} as const;

export function createDocToolset(options: DocToolsetOptions): PlatformTool[] {
	const readTool: PlatformTool = {
		name: "read_document",
		label: "读取文档",
		description:
			"读取 Word 文档的内容，按段落返回并带段落序号（可用于标注来源）。长文档请配合 fromParagraph 分批读取，或先用 outlineOnly 拿到标题骨架。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Word 文档路径" },
				outlineOnly: {
					type: "boolean",
					description:
						"只返回标题骨架。处理评估指标体系、申报指南这类长文档时先用它了解结构",
				},
				fromParagraph: {
					type: "number",
					description: `从第几段开始读（1 起）。单次最多返回 ${READ_PAGE_SIZE} 段`,
				},
			},
			required: ["path"],
		},
		replay: "safe", // 只读
		async execute({ args }) {
			const { path, outlineOnly, fromParagraph } = args as {
				path: string;
				outlineOnly?: boolean;
				fromParagraph?: number;
			};

			if (outlineOnly === true) {
				const outline = await readDocxOutline(path);
				if (outline.length === 0) {
					return {
						text: "该文档没有可识别的标题层级，请用普通读取方式查看内容。",
						details: { headings: 0 },
					};
				}
				return {
					text: [
						`文档骨架（${outline.length} 个标题）：`,
						...outline.map((p) => `${"  ".repeat((p.headingLevel ?? 1) - 1)}[第${p.index}段] ${p.text}`),
					].join("\n"),
					details: { headings: outline.length, outline },
				};
			}

			const result = await readDocx(path, {
				...(fromParagraph === undefined ? {} : { fromParagraph }),
				limit: READ_PAGE_SIZE,
			});

			const from = fromParagraph ?? 1;
			const to = from + result.paragraphs.length - 1;
			const lines = [
				`文档共 ${result.total} 段${result.tableCount > 0 ? `，含 ${result.tableCount} 个表格` : ""}。`,
				`本次返回第 ${from}-${to} 段：`,
				"",
				...result.paragraphs.map((p) => `[第${p.index}段]${p.isHeading ? "（标题）" : ""} ${p.text}`),
			];
			// 明确告知还有剩余，否则模型会以为读完了
			if (to < result.total) {
				lines.push("", `⚠ 还有 ${result.total - to} 段未读，如需继续请用 fromParagraph=${to + 1}`);
			}

			return {
				text: lines.join("\n"),
				details: {
					total: result.total,
					tableCount: result.tableCount,
					returned: result.paragraphs.length,
					from,
					to,
				},
			};
		},
	};

	const writeTool: PlatformTool = {
		name: "write_document",
		label: "生成文档",
		description:
			"生成 Word 文档。用结构化的块序列描述文档内容（标题、段落、列表、表格），平台负责排版。信息不足的地方用 placeholder 标为待补充，不要编造。",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string", description: "文档标题" },
				outputName: {
					type: "string",
					description: "输出文件名，须以 .docx 结尾。只能是文件名，不能含路径",
				},
				blocks: {
					type: "array",
					description: "文档内容块，按出现顺序排列",
					items: BLOCK_SCHEMA,
				},
				bodyFont: {
					type: "string",
					description: "正文字体，默认宋体。体系文件与公文常有明确字体规定",
				},
				bodySizePt: { type: "number", description: "正文字号（磅），默认 12" },
			},
			required: ["title", "outputName", "blocks"],
		},
		replay: "never", // 写文件，重放会产生重复产物
		async execute({ args, report }) {
			const input = args as {
				title: string;
				outputName: string;
				blocks: DocBlock[];
				bodyFont?: string;
				bodySizePt?: number;
			};

			if (!input.outputName.toLowerCase().endsWith(".docx")) {
				return {
					isError: true,
					text: `输出文件名必须以 .docx 结尾，收到的是「${input.outputName}」`,
				};
			}

			const doc: DocModel = {
				title: input.title,
				blocks: input.blocks,
				...(input.bodyFont === undefined ? {} : { bodyFont: input.bodyFont }),
				...(input.bodySizePt === undefined ? {} : { bodySizePt: input.bodySizePt }),
			};

			// 渲染前校验，报错能指到「第几块」
			const structure = validateDocModel(doc);
			if (!structure.ok) {
				return {
					isError: true,
					text: [
						"文档结构有误，未生成文件：",
						...structure.issues.map((i) =>
							i.blockIndex < 0 ? `· ${i.message}` : `· 第 ${i.blockIndex + 1} 块：${i.message}`,
						),
					].join("\n"),
				};
			}

			report(`正在生成文档（${input.blocks.length} 个内容块）`);
			const written = await writeDocx(doc, {
				workspace: options.workspace,
				outputName: input.outputName,
			});

			// 生成后校验：写出去一份打不开的文件比没有更糟
			report("正在校验产出文件");
			const validation = await validateDocx(written.path);
			if (!validation.ok) {
				return {
					isError: true,
					text: [
						"文档已写出但校验未通过：",
						...validation.issues.map((i) => `[${i.severity}] ${i.message}`),
					].join("\n"),
					details: { outputPath: written.path, validation },
				};
			}

			const stats = describeDocModel(doc);
			const lines = [
				`文档已生成：${input.outputName}`,
				`含 ${stats.headings} 个标题、${stats.paragraphs} 个段落、${stats.tables} 个表格`,
			];
			// 待补充项必须在回复里点出来，否则用户不会注意到高亮
			if (stats.placeholders > 0) {
				lines.push(
					`⚠ 文档中有 ${stats.placeholders} 处标为「待补充」，已高亮标注，请补齐后再对外提交`,
				);
			}

			return {
				text: lines.join("\n"),
				details: {
					outputPath: written.path,
					bytes: written.bytes,
					...stats,
					validation: validation.stats,
				},
			};
		},
	};

	return [readTool, writeTool];
}

/** 文档工具的权限策略。路径参数必须登记，否则权限门不会校验。 */
export const DOC_TOOL_POLICIES = [
	{ tool: "read_document", pathParams: ["path"] },
	// write_document 的 outputName 不是路径参数 —— writeDocx 强制它只能是
	// 文件名且落在工作区内，不给模型指定路径的机会
	{ tool: "write_document" },
] as const;
