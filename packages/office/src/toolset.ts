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

import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
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

/** 产出路径的校验结论。拒绝原因要能直接回给模型，所以带上说明文本。 */
type OutputPath = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly text: string };

/**
 * 把产出文件名解析成工作区内的绝对路径。
 *
 * `outputName` 由模型给出，而它不是登记在 `OFFICE_TOOL_POLICIES` 里的路径参数，
 * 权限门不会校验它 —— 所以这道约束是产物落盘前唯一的边界：光靠 `join` 拼接，
 * `../../其他租户/凭据` 这类名字会把写入落到工作区之外。
 *
 * 逃逸有两层，必须分别挡：
 *
 *  1. **词法层**：`../` 与绝对路径。与 [writeDocx](./docx-writer.ts) 同口径只接受
 *     纯文件名，再用 resolve 后的结果复核一次，防止规范化层面没想到的写法。
 *  2. **文件系统层**：词法上干净的纯文件名，在工作区里也可能已经是一条指向外部的
 *     链接（前一轮任务的产物、被投毒的输入目录都可能留下）。符号链接跟随写入等于
 *     覆写工作区外的目标；硬链接更隐蔽 —— 它就是同一个 inode 的另一个名字，
 *     `isFile()` 为真、也没有链接形态可查，只有 `nlink > 1` 这一个迹象能说明
 *     「这份数据在工作区外还有别的入口」。字符串比对完全看不到这一层，所以必须
 *     落到 inode 上看。
 *
 * 这里用 `lstat` 而非 `stat` —— `stat` 会跟随链接，看到的是目标而不是链接本身，
 * 正好把要拦的东西隐藏掉。目标文件不存在是首次产出的正常情况，不算失败。
 *
 * 这道校验与 open 之间仍有时间窗，所以它只负责把拒绝原因讲清楚回给模型；写入不越界
 * 由 [writeReconcileReport](./xlsx-report.ts) 的临时文件 + 原子 rename 独立保证。
 */
async function resolveOutputPath(workspace: string, fileName: string): Promise<OutputPath> {
	const rejectLexical = { ok: false, text: `产出文件名不能包含路径：${fileName}。报告一律落在任务工作区内，请只给文件名` } as const;
	if (fileName.includes("/") || fileName.includes("\\") || isAbsolute(fileName)) return rejectLexical;
	const absolute = resolve(workspace, fileName);
	if (!absolute.startsWith(`${resolve(workspace)}${sep}`)) return rejectLexical;

	// 父目录按 realpath 比对：纯文件名的父目录就是工作区，而工作区路径自身也可能
	// 经由链接指进来。把两端都解析成真实路径再比，边界才建立在 inode 上而不是字面量上。
	// realpath 对不存在的路径会抛错，工作区不可用时宁可不产出。
	let realWorkspace: string;
	let realParent: string;
	try {
		realWorkspace = await realpath(resolve(workspace));
		realParent = await realpath(dirname(absolute));
	} catch {
		return { ok: false, text: `任务工作区不可用，无法产出报告：${workspace}` };
	}
	if (realParent !== realWorkspace && !realParent.startsWith(`${realWorkspace}${sep}`)) {
		return { ok: false, text: `产出目录不在任务工作区内，已拒绝写出：${fileName}` };
	}

	try {
		const info = await lstat(absolute);
		if (info.isSymbolicLink()) {
			return {
				ok: false,
				text: `产出位置已是符号链接，拒绝跟随写出：${fileName}。请换一个文件名`,
			};
		}
		if (!info.isFile()) {
			return { ok: false, text: `产出位置已被非普通文件占用：${fileName}。请换一个文件名` };
		}
		if (info.nlink > 1) {
			return {
				ok: false,
				text: `产出位置被多个硬链接共享，拒绝写出：${fileName}。请换一个文件名`,
			};
		}
	} catch (error) {
		// ENOENT 是首次产出的常态；其余错误说明这个位置本身有问题，不该继续写
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return { ok: false, text: `产出位置不可用：${fileName}` };
		}
	}

	return { ok: true, path: absolute };
}

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

			// 在读表之前先把产出路径定下来 —— 名字不合法就不必白跑一趟核对
			const fileName = input.outputName ?? "对账差异报告.xlsx";
			const output = await resolveOutputPath(options.workspace, fileName);
			if (!output.ok) {
				return { isError: true, text: output.text };
			}
			const outputPath = output.path;

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
	// reconcile_tables 的 outputName 不登记为路径参数 —— 它由 resolveOutputPath
	// 强制成工作区内的纯文件名，不给模型指定路径的机会
	{ tool: "reconcile_tables", pathParams: ["leftPath", "rightPath"] },
] as const;
