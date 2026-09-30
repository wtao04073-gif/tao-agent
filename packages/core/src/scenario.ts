/**
 * 场景卡
 *
 * 这是产品形态的核心 —— 用场景卡替代空白对话框。
 *
 * 为什么必须这样做：目标用户「会把 AI 当搜索引擎用，但不会写有效 prompt，
 * 更不会写 Agent 指令」（需求 §2）。给他们一个空输入框，等于把产品做废。
 * 场景卡把「构思 prompt」这个他们做不到的动作，换成「填表」这个他们每天都在做的动作。
 *
 * 指令编译（表单 → Agent 指令）刻意放在**平台侧**而非让模型猜：
 * 同一个场景每次执行的指令结构必须稳定，否则产出质量无法收敛，
 * 也无法沉淀「上次被改过哪里」这类经验。
 */

import { Scope } from "./tenant.ts";

/** 字段类型。刻意保持少 —— 每多一种就多一处前端渲染与校验分支。 */
export const FieldType = {
	/** 单行文本 */
	Text: "text",
	/** 多行文本 */
	TextArea: "textarea",
	/** 数字 */
	Number: "number",
	/** 单选 */
	Select: "select",
	/** 多选 */
	MultiSelect: "multiselect",
	/** 文件上传。value 为文件路径。 */
	File: "file",
	/** 多文件上传。value 为路径数组。 */
	FileList: "filelist",
	/** 日期，ISO 格式字符串 */
	Date: "date",
	/** 布尔 */
	Boolean: "boolean",
} as const;

export type FieldType = (typeof FieldType)[keyof typeof FieldType];

export interface FieldOption {
	readonly value: string;
	readonly label: string;
}

export interface ScenarioField {
	readonly name: string;
	/** 面向用户的标签。用业务语言，不是技术名。 */
	readonly label: string;
	readonly type: FieldType;
	/** 必需输入未齐备时不允许提交（需求明确要求）。 */
	readonly required: boolean;
	/** 填写提示。降低「不知道该填什么」的门槛。 */
	readonly hint?: string;
	/** 选项。type 为 Select / MultiSelect 时必填。 */
	readonly options?: readonly FieldOption[];
	/** 默认值。 */
	readonly defaultValue?: unknown;
	/** 数字范围。 */
	readonly min?: number;
	readonly max?: number;
	/** 文件类型限制，如 [".xlsx", ".xls"]。 */
	readonly accept?: readonly string[];
}

export interface ScenarioCard {
	readonly id: string;
	/** 卡片标题，如「核对供应商对账单」。 */
	readonly title: string;
	/** 一句话说明这个场景解决什么问题。 */
	readonly summary: string;
	/** 行业分组，用于首页归类。 */
	readonly industry: "university" | "manufacturing" | "general";
	/** 职能分组，如「质量管理」「教务」。 */
	readonly category: string;
	readonly fields: readonly ScenarioField[];
	/** 该场景需要激活的工具白名单。 */
	readonly tools: readonly string[];
	/** 系统提示词。定义 Agent 在该场景下的角色与产出要求。 */
	readonly systemPrompt: string;
	/**
	 * 指令模板。
	 *
	 * 用 `{{fieldName}}` 占位符引用表单字段。编译时替换为实际值。
	 * 模板而非模型自由发挥 —— 指令结构稳定才能让产出质量收敛。
	 */
	readonly promptTemplate: string;
	/** 生效范围。租户自建可覆盖同名平台场景（需求明确要求）。 */
	readonly scope: Scope;
	/** 归属租户。平台预置场景为 null。 */
	readonly tenantId: string | null;
	/** 是否启用。管理员可停用而不删除。 */
	readonly enabled: boolean;
}

export interface ValidationError {
	readonly field: string;
	readonly label: string;
	readonly message: string;
}

export interface ValidationOutcome {
	readonly valid: boolean;
	readonly errors: readonly ValidationError[];
}

/** 判断一个值是否算「已填写」。 */
function isFilled(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === "string") return value.trim() !== "";
	if (Array.isArray(value)) return value.length > 0;
	// 数字 0 与布尔 false 都是有效输入，不能当成未填
	return true;
}

/**
 * 校验表单输入。
 *
 * **必需输入未齐备时不允许提交** —— 这是需求的硬要求。让用户带着缺失
 * 数据提交，Agent 只能靠猜，产出必然不可用，用户会把这笔账记在产品头上。
 */
export function validateSubmission(
	card: ScenarioCard,
	values: Readonly<Record<string, unknown>>,
): ValidationOutcome {
	const errors: ValidationError[] = [];

	for (const field of card.fields) {
		const value = values[field.name];
		const filled = isFilled(value);

		if (field.required && !filled) {
			errors.push({
				field: field.name,
				label: field.label,
				message: `请填写「${field.label}」`,
			});
			continue;
		}

		if (!filled) continue; // 可选字段未填，跳过后续校验

		switch (field.type) {
			case FieldType.Number: {
				const n = typeof value === "number" ? value : Number(value);
				if (!Number.isFinite(n)) {
					errors.push({ field: field.name, label: field.label, message: `「${field.label}」需要填数字` });
					break;
				}
				if (field.min !== undefined && n < field.min) {
					errors.push({
						field: field.name,
						label: field.label,
						message: `「${field.label}」不能小于 ${field.min}`,
					});
				}
				if (field.max !== undefined && n > field.max) {
					errors.push({
						field: field.name,
						label: field.label,
						message: `「${field.label}」不能大于 ${field.max}`,
					});
				}
				break;
			}

			case FieldType.Select: {
				const allowed = (field.options ?? []).map((o) => o.value);
				if (!allowed.includes(String(value))) {
					errors.push({
						field: field.name,
						label: field.label,
						message: `「${field.label}」的取值不在可选范围内`,
					});
				}
				break;
			}

			case FieldType.MultiSelect: {
				const allowed = new Set((field.options ?? []).map((o) => o.value));
				const picked = Array.isArray(value) ? value : [value];
				const invalid = picked.filter((v) => !allowed.has(String(v)));
				if (invalid.length > 0) {
					errors.push({
						field: field.name,
						label: field.label,
						message: `「${field.label}」含无效选项：${invalid.join("、")}`,
					});
				}
				break;
			}

			case FieldType.File:
			case FieldType.FileList: {
				const paths = Array.isArray(value) ? value.map(String) : [String(value)];
				if (field.accept !== undefined && field.accept.length > 0) {
					const bad = paths.filter(
						(p) => !field.accept?.some((ext) => p.toLowerCase().endsWith(ext.toLowerCase())),
					);
					if (bad.length > 0) {
						errors.push({
							field: field.name,
							label: field.label,
							message: `「${field.label}」只接受 ${field.accept.join("、")} 格式`,
						});
					}
				}
				break;
			}

			case FieldType.Date: {
				if (Number.isNaN(Date.parse(String(value)))) {
					errors.push({
						field: field.name,
						label: field.label,
						message: `「${field.label}」的日期格式不正确`,
					});
				}
				break;
			}

			case FieldType.Boolean: {
				if (typeof value !== "boolean") {
					errors.push({ field: field.name, label: field.label, message: `「${field.label}」需要是布尔值` });
				}
				break;
			}

			case FieldType.Text:
			case FieldType.TextArea:
				break;
		}
	}

	return { valid: errors.length === 0, errors };
}

/**
 * 把表单值编译成 Agent 指令。
 *
 * 未填的可选字段对应的整行会被移除 —— 否则指令里会出现
 * 「备注：」这种空悬内容，模型会把它当成需要补全的信息而产生幻觉。
 */
export function compilePrompt(
	card: ScenarioCard,
	values: Readonly<Record<string, unknown>>,
): string {
	const lines = card.promptTemplate.split("\n");
	const kept: string[] = [];

	for (const line of lines) {
		const placeholders = [...line.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string);

		// 这一行引用的字段若全部未填，整行丢弃
		if (placeholders.length > 0) {
			const anyFilled = placeholders.some((name) => isFilled(values[name]));
			if (!anyFilled) continue;
		}

		let rendered = line;
		for (const name of placeholders) {
			rendered = rendered.replaceAll(`{{${name}}}`, formatValue(values[name], card, name));
		}
		kept.push(rendered);
	}

	return kept.join("\n").trim();
}

/** 把字段值渲染成指令里的文本。 */
function formatValue(value: unknown, card: ScenarioCard, fieldName: string): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "是" : "否";

	const field = card.fields.find((f) => f.name === fieldName);

	/**
	 * 选项类字段渲染 label 而非 value。
	 *
	 * 指令里出现 "code" 对模型无意义，"物料编码" 才有。
	 * 单值与数组都要映射 —— 多选字段的值是数组，若只处理单值，
	 * 多选就会把原始 value 泄漏进指令。
	 */
	const toLabel = (raw: unknown): string => {
		const text = String(raw);
		const option = field?.options?.find((o) => o.value === text);
		return option?.label ?? text;
	};

	if (Array.isArray(value)) return value.map(toLabel).join("、");
	return toLabel(value);
}

/**
 * 解析场景卡：租户自建覆盖同名平台场景。
 *
 * 按 id 匹配。租户版本存在且启用时取它，否则回落到平台版本。
 */
export function resolveCard(
	cards: readonly ScenarioCard[],
	id: string,
	tenantId: string,
): ScenarioCard | undefined {
	const candidates = cards.filter((c) => c.id === id && c.enabled);
	// 租户自建优先
	const tenantOwned = candidates.find((c) => c.tenantId === tenantId);
	if (tenantOwned !== undefined) return tenantOwned;
	return candidates.find((c) => c.tenantId === null);
}

/**
 * 列出某租户可见的场景卡。
 *
 * 同 id 只保留一张（租户自建优先），避免首页出现两张同名卡片。
 */
export function listCards(
	cards: readonly ScenarioCard[],
	tenantId: string,
): ScenarioCard[] {
	const ids = new Set(cards.filter((c) => c.enabled).map((c) => c.id));
	return [...ids]
		.map((id) => resolveCard(cards, id, tenantId))
		.filter((c): c is ScenarioCard => c !== undefined);
}
