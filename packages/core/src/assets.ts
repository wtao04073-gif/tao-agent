/**
 * 模板与口径资产
 *
 * 解决两个具体问题：
 *
 *  1. **格式不稳定。** 同一类公文每次产出的版式都不一样，用户要反复调。
 *     体系文件、公文、台账在每个单位都有固定格式，这不是模型能猜到的。
 *  2. **字段口径不一致。** 「在校生数」到底含不含留学生、休学生？
 *     高校「一张表工程」的核心痛点就是各部门口径不同。口径必须显式定义，
 *     否则每份报表的同一个数字都对不上。
 *
 * ── 与场景卡、经验的分工 ──
 *
 * 三者容易混淆，边界必须清楚：
 *
 * | 资产 | 回答什么问题 | 谁定义 |
 * |---|---|---|
 * | 场景卡 | 这类任务要收集哪些输入、产出什么 | 平台预置，租户可覆盖 |
 * | **模板** | 产出长什么样（章节、栏目、版式） | 租户上传或维护 |
 * | **口径** | 某个字段/指标怎么算 | 租户维护 |
 * | 经验 | 上次哪里被改了 | 系统从修改中学习 |
 *
 * 模板是**用户主动提供的规范**，经验是**系统被动学到的偏好**。
 * 前者权威、稳定；后者是推测、需要保守对待。所以注入时模板优先于经验，
 * 冲突时以模板为准。
 */

import type { Scope } from "./tenant.ts";

/** 模板的用途。 */
export const TemplateKind = {
	/** 文档模板：公文、报告、程序文件。 */
	Document: "document",
	/** 表格模板：台账、检查表、报表。 */
	Table: "table",
} as const;

export type TemplateKind = (typeof TemplateKind)[keyof typeof TemplateKind];

/** 模板要求的章节。 */
export interface TemplateSection {
	/** 章节标题，如「1 目的」。 */
	readonly title: string;
	/** 是否必需。缺少必需章节的产出会被审核退回。 */
	readonly required: boolean;
	/** 该章节应写什么。给模型的指引。 */
	readonly guidance?: string;
}

/** 模板要求的表格列。 */
export interface TemplateColumn {
	readonly name: string;
	readonly required: boolean;
	/** 该列的填写要求，如「格式 YYYY-MM-DD」。 */
	readonly guidance?: string;
}

/** 版式要求。 */
export interface TemplateLayout {
	readonly bodyFont?: string;
	readonly bodySizePt?: number;
	/** 其他版式说明，如「一级标题黑体三号」。 */
	readonly notes?: readonly string[];
}

/**
 * 一份模板。
 *
 * 刻意**不存原始 docx 文件**，而是存结构化的章节/列定义。理由：
 *
 *  - 存文件的话只能「照着改」，无法让模型理解「这里该写什么」
 *  - 结构化定义可以校验产出是否合规（缺了哪个必需章节）
 *  - 原始文件的样式细节（页边距、页眉）由 `layout` 承载即可
 *
 * 代价是用户上传 docx 后需要一步「解析成模板」的动作。这一步可以
 * 半自动（从标题层级提取章节）+ 人工确认。
 */
export interface Template {
	readonly id: string;
	readonly tenantId: string;
	readonly name: string;
	readonly kind: TemplateKind;
	/** 适用的场景卡。为 null 表示通用模板。 */
	readonly scenarioId: string | null;
	readonly sections?: readonly TemplateSection[];
	readonly columns?: readonly TemplateColumn[];
	readonly layout?: TemplateLayout;
	readonly scope: Scope;
	readonly enabled: boolean;
	readonly updatedAt: number;
}

/**
 * 一条字段口径定义。
 *
 * 这是高校「一张表工程」痛点的直接对策：同一个指标在各部门口径不同，
 * 汇总时永远对不上。把口径显式写下来，产出时注入，用户才能信任数字。
 */
export interface FieldDefinition {
	readonly id: string;
	readonly tenantId: string;
	/** 字段名，如「在校生数」「一次合格率」。 */
	readonly name: string;
	/** 口径说明。这是核心内容。 */
	readonly definition: string;
	/** 计算公式，如「合格数 / 投入数」。 */
	readonly formula?: string;
	/** 明确包含什么。 */
	readonly includes?: readonly string[];
	/** 明确排除什么。**这一项往往比 includes 更重要** —— 争议都在边界上。 */
	readonly excludes?: readonly string[];
	/** 统计时点，如「每年 9 月 30 日」。 */
	readonly asOf?: string;
	/** 负责维护该口径的部门。出现分歧时找谁。 */
	readonly owner?: string;
	readonly scope: Scope;
	readonly updatedAt: number;
}

/** 资产存储接口。 */
export interface AssetStore {
	listTemplates(tenantId: string, scenarioId: string | null): Promise<Template[]>;
	getTemplate(tenantId: string, id: string): Promise<Template | undefined>;
	upsertTemplate(template: Template): Promise<Template>;
	removeTemplate(tenantId: string, id: string): Promise<boolean>;

	listDefinitions(tenantId: string): Promise<FieldDefinition[]>;
	upsertDefinition(definition: FieldDefinition): Promise<FieldDefinition>;
	removeDefinition(tenantId: string, id: string): Promise<boolean>;
}

/**
 * 解析模板：场景专用模板优先于通用模板。
 *
 * 与场景卡的 `resolveCard` 同一逻辑 —— 更具体的定义覆盖更泛的。
 */
export function resolveTemplate(
	templates: readonly Template[],
	scenarioId: string,
): Template | undefined {
	const enabled = templates.filter((t) => t.enabled);
	return (
		enabled.find((t) => t.scenarioId === scenarioId) ??
		enabled.find((t) => t.scenarioId === null)
	);
}

/**
 * 把模板编译成注入模型的上下文。
 *
 * 措辞与经验注入相反：模板是**用户主动提供的规范**，所以用命令式
 * （「必须包含」），而经验是系统的推测，用「上次被改为」。
 */
export function compileTemplate(template: Template): string {
	const lines: string[] = [`本次产出须遵循本单位模板《${template.name}》：`, ""];

	const required = (template.sections ?? []).filter((s) => s.required);
	const optional = (template.sections ?? []).filter((s) => !s.required);

	if (required.length > 0) {
		lines.push("必需章节（缺少任一项，产出会被审核退回）：");
		for (const section of required) {
			const guidance = section.guidance === undefined ? "" : ` —— ${section.guidance}`;
			lines.push(`  ${section.title}${guidance}`);
		}
		lines.push("");
	}

	if (optional.length > 0) {
		lines.push("可选章节（视本次内容决定是否包含）：");
		for (const section of optional) {
			const guidance = section.guidance === undefined ? "" : ` —— ${section.guidance}`;
			lines.push(`  ${section.title}${guidance}`);
		}
		lines.push("");
	}

	if (template.columns !== undefined && template.columns.length > 0) {
		lines.push("表格列（顺序与名称须一致）：");
		for (const column of template.columns) {
			const mark = column.required ? "" : "（可选）";
			const guidance = column.guidance === undefined ? "" : ` —— ${column.guidance}`;
			lines.push(`  ${column.name}${mark}${guidance}`);
		}
		lines.push("");
	}

	if (template.layout !== undefined) {
		const layout: string[] = [];
		if (template.layout.bodyFont !== undefined) layout.push(`正文字体 ${template.layout.bodyFont}`);
		if (template.layout.bodySizePt !== undefined) {
			layout.push(`正文字号 ${template.layout.bodySizePt} 磅`);
		}
		layout.push(...(template.layout.notes ?? []));
		if (layout.length > 0) {
			lines.push(`版式要求：${layout.join("；")}`);
			lines.push("");
		}
	}

	return lines.join("\n").trimEnd();
}

/**
 * 把口径定义编译成注入上下文。
 *
 * 只注入**本次任务实际涉及**的字段。全部注入会让上下文塞满几十条
 * 无关口径，真正相关的那几条反被淹没。
 */
export function compileDefinitions(
	definitions: readonly FieldDefinition[],
	relevantTo?: string,
): string {
	const relevant =
		relevantTo === undefined
			? definitions
			: definitions.filter((d) => relevantTo.includes(d.name));

	if (relevant.length === 0) return "";

	const lines: string[] = ["本单位的字段口径定义。涉及这些指标时必须按此口径计算：", ""];

	for (const def of relevant) {
		lines.push(`【${def.name}】${def.definition}`);
		if (def.formula !== undefined) lines.push(`  计算方式：${def.formula}`);
		if (def.includes !== undefined && def.includes.length > 0) {
			lines.push(`  包含：${def.includes.join("、")}`);
		}
		if (def.excludes !== undefined && def.excludes.length > 0) {
			// 排除项单独强调 —— 争议都在边界上
			lines.push(`  不包含：${def.excludes.join("、")}`);
		}
		if (def.asOf !== undefined) lines.push(`  统计时点：${def.asOf}`);
		if (def.owner !== undefined) lines.push(`  口径负责部门：${def.owner}`);
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

export interface ComplianceIssue {
	readonly severity: "error" | "warning";
	readonly message: string;
}

/**
 * 校验产出是否符合模板。
 *
 * 用在交付前自检。缺少必需章节的产出交上去会被退回，
 * 而用户往往到那时才发现。
 */
export function checkTemplateCompliance(
	template: Template,
	output: { readonly headings?: readonly string[]; readonly columns?: readonly string[] },
): { readonly ok: boolean; readonly issues: readonly ComplianceIssue[] } {
	const issues: ComplianceIssue[] = [];

	const headings = output.headings ?? [];
	for (const section of template.sections ?? []) {
		if (!section.required) continue;
		/**
		 * 用包含匹配而非精确相等。
		 *
		 * 模板写「1 目的」，产出可能是「一、目的」或「1. 目的」——
		 * 编号风格的差异不该算不合规。取标题里的实词来判断。
		 */
		const keyword = section.title.replace(/^[\d.、（）()一二三四五六七八九十\s]+/, "").trim();
		const found = headings.some((h) => h.includes(keyword === "" ? section.title : keyword));
		if (!found) {
			issues.push({ severity: "error", message: `缺少必需章节「${section.title}」` });
		}
	}

	const columns = output.columns ?? [];
	for (const column of template.columns ?? []) {
		if (!column.required) continue;
		if (!columns.some((c) => c.trim() === column.name.trim())) {
			issues.push({ severity: "error", message: `缺少必需列「${column.name}」` });
		}
	}

	// 多出来的列是警告而非错误 —— 本次任务可能确实需要额外信息
	if (template.columns !== undefined && template.columns.length > 0 && columns.length > 0) {
		const expected = new Set(template.columns.map((c) => c.name.trim()));
		for (const actual of columns) {
			if (!expected.has(actual.trim())) {
				issues.push({ severity: "warning", message: `列「${actual}」不在模板定义中` });
			}
		}
	}

	return { ok: issues.every((i) => i.severity !== "error"), issues };
}

/**
 * 把模板、口径、经验三者合成一份注入上下文。
 *
 * **顺序即优先级**：模板 → 口径 → 经验。
 *
 * 模板与口径是用户主动提供的规范，经验是系统的推测。冲突时以前者为准，
 * 这一点在拼接文本里显式写明 —— 否则模型面对矛盾指令时行为不可预测。
 */
export function composeAssetContext(parts: {
	readonly template?: string;
	readonly definitions?: string;
	readonly lessons?: string;
}): string {
	const blocks = [parts.template, parts.definitions, parts.lessons].filter(
		(b): b is string => b !== undefined && b.trim() !== "",
	);
	if (blocks.length === 0) return "";

	// 只有同时存在规范与经验时才需要说明优先级
	const needsPrecedence =
		(parts.template !== undefined && parts.template.trim() !== "" ||
			parts.definitions !== undefined && parts.definitions.trim() !== "") &&
		parts.lessons !== undefined &&
		parts.lessons.trim() !== "";

	const tail = needsPrecedence
		? ["", "以上内容若相互冲突，优先级为：模板与口径定义 > 历史修改记录 > 本次任务的其他说明。"]
		: [];

	return [...blocks.flatMap((b, i) => (i === 0 ? [b] : ["", b])), ...tail].join("\n");
}
