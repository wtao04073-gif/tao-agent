/**
 * 对账场景的平台工具
 *
 * 一期不开放自由 shell（[安全策略决策 4](../../../docs/security-policy.md)），能力以结构化工具提供、
 * 参数经 schema 校验。这三个工具组成制造业对账场景的完整链路：
 *
 *   list_sheets（看有哪些表）→ read_table（读数据）→ reconcile_tables（核对并产出报告）
 *
 * 工具粒度的取舍：核对与产出**合成一个工具**而非分开。理由是模型若要
 * 先调核对、再把几千条差异原样传给产出工具，token 成本会爆炸，且中间
 * 结果经过模型必然失真。让工具内部完成数据流转，模型只负责决策。
 */

import { join } from "node:path";
import { reconcile, type PlatformTool } from "@tao/core";
import { readSheet, listSheets } from "./xlsx-reader.ts";
import { writeReconcileReport } from "./xlsx-report.ts";
import { validateXlsx } from "./validate.ts";

export interface ToolsetOptions {
	/** 任务工作区绝对路径。产物写在这里。 */
	readonly workspace: string;
	/** 取当前时间。注入以便测试可复现。 */
	readonly now?: () => Date;
}

/** 预览行数上限。给模型看样本即可，不必也不该把整表塞进上下文。 */
const PREVIEW_ROWS = 5;

export function createOfficeToolset(options: ToolsetOptions): PlatformTool[] {
	const now = options.now ?? (() => new Date());

	const listSheetsTool: PlatformTool = {
		name: "list_sheets",
		label: "查看表格结构",
		description: "列出一个 Excel 文件里的所有工作表名称。当不确定该读哪个表时先用它。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Excel 文件路径" },
			},
			required: ["path"],
		},
		replay: "safe", // 只读，重放安全
		async execute({ args }) {
			const { path } = args as { path: string };
			const sheets = await listSheets(path);
			return {
				text: `${path} 含 ${sheets.length} 个工作表：${sheets.join("、")}`,
				details: { sheets },
			};
		},
	};

	const readTableTool: PlatformTool = {
		name: "read_table",
		label: "读取表格",
		description:
			"读取 Excel 工作表的列名与前几行样本，用于确认表结构与列名。不会返回全部数据。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Excel 文件路径" },
				sheet: { type: "string", description: "工作表名。省略则读第一个表" },
			},
			required: ["path"],
		},
		replay: "safe",
		async execute({ args }) {
			const { path, sheet } = args as { path: string; sheet?: string };
			const data = await readSheet(path, sheet);
			const preview = data.rows.slice(0, PREVIEW_ROWS);
			return {
				// 只给模型列名与少量样本 —— 几千行数据塞进上下文既贵又无用
				text: [
					`工作表「${data.name}」共 ${data.rows.length} 行。`,
					`列：${data.columns.join("、")}`,
					preview.length > 0
						? `前 ${preview.length} 行样本：\n${preview.map((r) => JSON.stringify(r)).join("\n")}`
						: "（无数据行）",
				].join("\n"),
				details: { sheet: data.name, columns: data.columns, rowCount: data.rows.length },
			};
		},
	};

	const reconcileTool: PlatformTool = {
		name: "reconcile_tables",
		label: "核对两张表并产出报告",
		description:
			"按指定的键列匹配两张表的行，比较数值列的差异，产出一份 xlsx 对账报告（含汇总页与差异明细页）。适用于供应商对账、多表数据核对。",
		parameters: {
			type: "object",
			properties: {
				leftPath: { type: "string", description: "左表路径，通常是我方台账" },
				rightPath: { type: "string", description: "右表路径，通常是对方提供的单据" },
				leftSheet: { type: "string", description: "左表工作表名，省略则取第一个" },
				rightSheet: { type: "string", description: "右表工作表名，省略则取第一个" },
				keyColumns: {
					type: "array",
					items: { type: "string" },
					description: "用于匹配行的键列名，可多列组合（如物料编码+批次）",
				},
				compareColumns: {
					type: "array",
					items: { type: "string" },
					description: "需要比较数值的列名",
				},
				leftLabel: { type: "string", description: "左表业务名称，用于报告表头，如「我方台账」" },
				rightLabel: { type: "string", description: "右表业务名称，如「供应商对账单」" },
				tolerance: {
					type: "number",
					description: "数值比较容差，默认 0.01（一分钱）。按件数核对可设 0",
				},
				outputName: { type: "string", description: "输出文件名，省略则自动命名" },
			},
			required: ["leftPath", "rightPath", "keyColumns", "compareColumns"],
		},
		// 会写文件，重放会产生重复产物
		replay: "never",
		async execute({ args, report }) {
			const input = args as {
				leftPath: string;
				rightPath: string;
				leftSheet?: string;
				rightSheet?: string;
				keyColumns: string[];
				compareColumns: string[];
				leftLabel?: string;
				rightLabel?: string;
				tolerance?: number;
				outputName?: string;
			};

			const leftLabel = input.leftLabel ?? "左表";
			const rightLabel = input.rightLabel ?? "右表";

			report("正在读取两张表");
			const [left, right] = await Promise.all([
				readSheet(input.leftPath, input.leftSheet),
				readSheet(input.rightPath, input.rightSheet),
			]);

			// 列名校验必须在核对之前 —— 否则会产出一份「所有行都缺失」的
			// 报告，用户看不出是列名写错了
			const missing: string[] = [];
			for (const column of [...input.keyColumns, ...input.compareColumns]) {
				if (!left.columns.includes(column)) missing.push(`${leftLabel} 缺少列「${column}」`);
				if (!right.columns.includes(column)) missing.push(`${rightLabel} 缺少列「${column}」`);
			}
			if (missing.length > 0) {
				return {
					isError: true,
					text: [
						"列名不匹配，无法核对：",
						...missing,
						`${leftLabel}可用列：${left.columns.join("、")}`,
						`${rightLabel}可用列：${right.columns.join("、")}`,
					].join("\n"),
				};
			}

			report(`正在核对 ${left.rows.length} 行与 ${right.rows.length} 行`);
			const result = reconcile(left.rows, right.rows, {
				keyColumns: input.keyColumns,
				compareColumns: input.compareColumns,
				...(input.tolerance === undefined ? {} : { tolerance: input.tolerance }),
			});

			report("正在生成报告");
			const fileName = input.outputName ?? "对账差异报告.xlsx";
			const outputPath = join(options.workspace, fileName);
			await writeReconcileReport(outputPath, result, {
				title: `${leftLabel} 与 ${rightLabel} 核对报告`,
				leftLabel,
				rightLabel,
				keyColumns: input.keyColumns,
				generatedAt: now(),
			});

			// 生成后校验 —— 验收明确要求，且「写出去打不开的文件」比没有更糟
			const validation = await validateXlsx(outputPath, {
				expectFormulas: result.differences.some((d) => d.left !== null && d.right !== null),
				expectSheets: ["核对汇总", "差异明细"],
			});
			if (!validation.ok) {
				return {
					isError: true,
					text: [
						"报告已生成但校验未通过：",
						...validation.issues.map((i) => `[${i.severity}] ${i.message}`),
					].join("\n"),
					details: { outputPath, validation },
				};
			}

			const lines = [
				`核对完成，报告已生成：${fileName}`,
				`${leftLabel} ${result.summary.leftRows} 行，${rightLabel} ${result.summary.rightRows} 行`,
				`完全一致 ${result.matched} 条，差异 ${result.summary.differenceCount} 处`,
			];
			if (result.onlyLeft.length > 0) lines.push(`仅${leftLabel}存在 ${result.onlyLeft.length} 条`);
			if (result.onlyRight.length > 0) lines.push(`仅${rightLabel}存在 ${result.onlyRight.length} 条`);
			if (result.duplicateKeys.length > 0) {
				lines.push(`⚠ 发现 ${result.duplicateKeys.length} 个重复键，已取首次出现，建议核查源数据`);
			}

			return {
				text: lines.join("\n"),
				details: {
					outputPath,
					summary: result.summary,
					matched: result.matched,
					onlyLeft: result.onlyLeft.length,
					onlyRight: result.onlyRight.length,
					duplicateKeys: result.duplicateKeys,
					validation: validation.stats,
				},
			};
		},
	};

	return [listSheetsTool, readTableTool, reconcileTool];
}

/** 这组工具的权限策略。路径参数必须登记，否则权限门不会校验它们。 */
export const OFFICE_TOOL_POLICIES = [
	{ tool: "list_sheets", pathParams: ["path"] },
	{ tool: "read_table", pathParams: ["path"] },
	{ tool: "reconcile_tables", pathParams: ["leftPath", "rightPath"] },
] as const;
