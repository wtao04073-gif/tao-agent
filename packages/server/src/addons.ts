import {EXPERT_TEMPLATES} from "./connector-catalog.ts";
/**
 * 技能 / 智能体扩展的内置种子与解析
 *
 * 两类来源：
 *  - **内置（builtin）**：代码常量，对所有租户可见，不可删除、不占租户存储；
 *  - **租户上传**：FileJsonStore 中按 tenant/workspace 隔离的记录。
 *
 * 文件 store 按精确 tenantId/workspaceId 过滤，装不下「全局内置」这层语义，
 * 所以内置项不写进 store，而在列表与解析时与租户记录合并。
 */
import type { StoredAgent, StoredSkill, TenantContext, RunnerSkill } from "@tao/core";
import type { FileJsonStore } from "@tao/knowledge";

/** 内置项不带租户（全局）；落库项必须带。 */
type BuiltinSkill = Omit<StoredSkill, "tenant">;
type BuiltinAgent = Omit<StoredAgent, "tenant">;

/**
 * 预置技能。内容遵循 agentskills.io 风格（何时使用 + 指令正文），
 * 经内核 harness 的 resources.skills 注入，模型命中场景时自动套用。
 */
const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
	{
		skillId: "skill-builtin-official-writing",
		name: "公文写作",
		description: "撰写通知、请示、报告、函件等正式公文时使用，保证格式规范、措辞得体。",
		content: [
			"# 公文写作",
			"",
			"当用户需要起草通知、请示、报告、批复、函、纪要等正式公文时遵循本技能。",
			"",
			"## 要求",
			"1. 符合党政机关 / 企事业单位公文格式：标题（发文机关+事由+文种）、主送机关、正文、落款、日期。",
			"2. 语言庄重、准确、简明，使用书面语，避免口语与网络用语。",
			"3. 结构按「缘由—事项—要求」展开，条理清楚，必要时分条列项。",
			"4. 不虚构发文机关、文号、日期等要素；信息缺失时用占位符标注并提示用户补充。",
		].join("\n"),
		builtin: true,
		createdAt: 0,
		updatedAt: 0,
	},
	{
		skillId: "skill-builtin-meeting-minutes",
		name: "会议纪要",
		description: "把会议记录 / 录音整理成结构化会议纪要（议题、结论、待办、责任人、时限）。",
		content: [
			"# 会议纪要",
			"",
			"把用户提供的会议内容整理为纪要，包含：会议时间地点（可缺省）、参会人、议题、讨论要点、",
			"决议事项、待办任务（责任人 + 完成时限）。",
			"",
			"## 要求",
			"1. 只提炼已发生的结论与分工，不臆造未提及的责任人或时间。",
			"2. 待办用清单逐条列出，责任人和时限缺失时留空并提示补充。",
			"3. 客观中立，不加入个人评价。",
		].join("\n"),
		builtin: true,
		createdAt: 0,
		updatedAt: 0,
	},
	{
		skillId: "skill-builtin-data-report",
		name: "数据汇总分析",
		description: "对表格 / 报表数据做汇总、核对、差异分析并产出结论时使用。",
		content: [
			"# 数据汇总分析",
			"",
			"处理用户给出的表格或报表数据时：先核对口径与完整性，再做汇总 / 差异分析，最后给结论。",
			"",
			"## 要求",
			"1. 明确统计口径（范围、时间、单位），口径不一致先指出再计算。",
			"2. 差异要给出数值与可能原因；金额、数量保留合理精度并带单位。",
			"3. 结论与数据分离：先摆数据，后下结论；无法从数据支撑的结论不写。",
		].join("\n"),
		builtin: true,
		createdAt: 0,
		updatedAt: 0,
	},
];

/** 预置智能体：具名角色 + 系统提示词，可挂内置技能。 */
const BUILTIN_AGENTS: readonly BuiltinAgent[] = [
 ...EXPERT_TEMPLATES.map(t=>({agentId:"agent-builtin-"+t.id,name:t.name,description:t.description,systemPrompt:t.systemPrompt,skillIds:t.skillIds,builtin:true,createdAt:0,updatedAt:0})),
	{
		agentId: "agent-builtin-office-assistant",
		name: "行政办公助手",
		description: "面向高校 / 企业行政事务：公文、通知、报表、会务，规范稳妥。",
		systemPrompt: [
			"你是一名经验丰富的行政办公助手，服务于高校服务机构与传统企业的行政岗位。",
			"你的表达规范、稳妥、简洁，擅长公文写作、通知起草、数据汇总与会务材料整理。",
			"处理任务时：先确认口径与必填信息，再动手；涉及正式文稿时遵循标准格式；",
			"不臆造单位名称、文号、日期、数字等事实要素，缺失项明确提示用户补充。",
		].join("\n"),
		skillIds: ["skill-builtin-official-writing", "skill-builtin-data-report"],
		builtin: true,
		createdAt: 0,
		updatedAt: 0,
	},
	{
		agentId: "agent-builtin-manufacturing-analyst",
		name: "制造业数据分析员",
		description: "生产、质量、库存、对账等制造场景的数据核对与差异分析。",
		systemPrompt: [
			"你是一名制造业数据分析员，熟悉生产日报、质量统计、库存台账与供应商对账。",
			"你对数字严谨：先统一统计口径与单位，再做汇总、勾稽与差异核对，",
			"差异要列出数值、定位到具体行项并给出可核查的原因方向。",
			"输出以表格和分条结论为主，所有结论必须能追溯到数据，不做无依据的推断。",
		].join("\n"),
		skillIds: ["skill-builtin-data-report"],
		builtin: true,
		createdAt: 0,
		updatedAt: 0,
	},
];

const builtinSkillMap = new Map(BUILTIN_SKILLS.map((s) => [s.skillId, s]));
const builtinAgentMap = new Map(BUILTIN_AGENTS.map((a) => [a.agentId, a]));

/** 列出某租户可见的全部技能：内置在前（补当前租户上下文），租户上传在后。 */
export function listVisibleSkills(
	store: FileJsonStore<StoredSkill>,
	tenant: TenantContext,
): readonly StoredSkill[] {
	return [
		...BUILTIN_SKILLS.map((s) => ({ ...s, tenant })),
		...store.listByTenant(tenant.tenantId, tenant.workspaceId),
	];
}

/** 列出某租户可见的全部智能体。 */
export function listVisibleAgents(
	store: FileJsonStore<StoredAgent>,
	tenant: TenantContext,
): readonly StoredAgent[] {
	return [
		...BUILTIN_AGENTS.map((a) => ({ ...a, tenant, skillIds: [...a.skillIds] })),
		...store.listByTenant(tenant.tenantId, tenant.workspaceId),
	];
}

/** 取租户可见的技能（先内置后租户）；不可见返回 undefined。 */
function getVisibleSkill(
	store: FileJsonStore<StoredSkill>,
	tenant: TenantContext,
	skillId: string,
): StoredSkill | undefined {
	const builtin = builtinSkillMap.get(skillId);
	if (builtin !== undefined) return { ...builtin, tenant };
	const owned = store.get(skillId);
	if (
		owned !== undefined &&
		owned.tenant.tenantId === tenant.tenantId &&
		owned.tenant.workspaceId === tenant.workspaceId
	) {
		return owned;
	}
	return undefined;
}

/** 取租户可见的智能体（先内置后租户）；不可见返回 undefined。 */
function getVisibleAgent(
	store: FileJsonStore<StoredAgent>,
	tenant: TenantContext,
	agentId: string,
): StoredAgent | undefined {
	const builtin = builtinAgentMap.get(agentId);
	if (builtin !== undefined) return { ...builtin, tenant, skillIds: [...builtin.skillIds] };
	const owned = store.get(agentId);
	if (
		owned !== undefined &&
		owned.tenant.tenantId === tenant.tenantId &&
		owned.tenant.workspaceId === tenant.workspaceId
	) {
		return owned;
	}
	return undefined;
}

export interface ResolvedAddons {
	/** 本次运行要注入内核的技能（已按 id 去重）。 */
	readonly skills: RunnerSkill[];
	/** 选用智能体时，用其系统提示词覆盖本次 systemPrompt。 */
	readonly systemPromptOverride?: string;
}

/**
 * 解析一次任务选用的智能体 / 技能。
 *
 * - agentId：命中则其 systemPrompt 覆盖默认系统提示词，其 skillIds 一并注入；
 * - skillId：本次显式追加的技能，与智能体挂载的技能合并去重；
 * - 任一 id 不存在或越权（非本租户、非内置）→ 抛错，任务不创建。
 */
export function resolveAddons(input: {
	readonly tenant: TenantContext;
	readonly skillStore: FileJsonStore<StoredSkill>;
	readonly agentStore: FileJsonStore<StoredAgent>;
	readonly skillId?: string;
	readonly agentId?: string;
}): ResolvedAddons {
	const { tenant, skillStore, agentStore } = input;
	const skillIds: string[] = [];
	let systemPromptOverride: string | undefined;

	if (input.agentId !== undefined) {
		const agent = getVisibleAgent(agentStore, tenant, input.agentId);
		if (agent === undefined) throw new Error("智能体不存在或无权使用");
		systemPromptOverride = agent.systemPrompt;
		for (const id of agent.skillIds) if (!skillIds.includes(id)) skillIds.push(id);
	}
	if (input.skillId !== undefined) {
		if (!skillIds.includes(input.skillId)) skillIds.push(input.skillId);
	}

	const skills: RunnerSkill[] = [];
	for (const id of skillIds) {
		const skill = getVisibleSkill(skillStore, tenant, id);
		if (skill === undefined) throw new Error(`技能不存在或无权使用：${id}`);
		skills.push({ name: skill.name, description: skill.description, content: skill.content });
	}
	return { skills, ...(systemPromptOverride === undefined ? {} : { systemPromptOverride }) };
}

/** 生成租户上传的技能 / 智能体 id（安全字符，FileJsonStore 白名单接受）。 */
export function newAddonId(kind: "skill" | "agent"): string {
	return `${kind}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
