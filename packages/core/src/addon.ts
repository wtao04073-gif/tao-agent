/**
 * 可由用户上传 / 选择的扩展：技能（Skill）与智能体（Agent）
 *
 * 两者都基于 Pi 内核**原生**能力，不依赖外部程序：
 *
 * - **技能 Skill**：一段可复用的指令（agentskills.io 风格：名称 + 何时使用 +
 *   指令正文，支持 markdown）。通过 harness 的 `resources.skills` 注入，模型在
 *   命中使用场景时自动按该指令执行。
 * - **智能体 Agent**：一个具名的角色设定，核心是一段系统提示词（persona / 规则
 *   /输出要求），可再挂多个技能。选用后覆盖本次任务的 systemPrompt。
 *
 * 存储与长程任务类似：一个对象一个 JSON，按租户工作区隔离。
 */
import type { TenantContext } from "./tenant.ts";

/** 技能（可复用指令）。 */
export interface StoredSkill {
	readonly skillId: string;
	readonly tenant: TenantContext;
	/** 模型可见的稳定名称（短、无空格优先）。 */
	readonly name: string;
	/** 一句话说明「什么时候用这个技能」，供模型选择。 */
	readonly description: string;
	/** 技能指令正文（markdown）。 */
	readonly content: string;
	/** 是否系统预置（预置不可删除）。 */
	readonly builtin: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** 智能体（具名角色 / 系统提示词）。 */
export interface StoredAgent {
	readonly agentId: string;
	readonly tenant: TenantContext;
	/** 展示名。 */
	readonly name: string;
	readonly description: string;
	/** 该智能体的系统提示词（人设、规则、输出要求）。 */
	readonly systemPrompt: string;
	/** 该智能体默认携带的技能 id（可空）。 */
	readonly skillIds: readonly string[];
	readonly builtin: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** 技能存储。 */
export interface SkillStore {
	create(skill: StoredSkill): boolean;
	put(skill: StoredSkill): void;
	get(skillId: string): StoredSkill | undefined;
	listByTenant(tenantId: string, workspaceId: string): readonly StoredSkill[];
	remove(skillId: string): void;
}

/** 智能体存储。 */
export interface AgentStore {
	create(agent: StoredAgent): boolean;
	put(agent: StoredAgent): void;
	get(agentId: string): StoredAgent | undefined;
	listByTenant(tenantId: string, workspaceId: string): readonly StoredAgent[];
	remove(agentId: string): void;
}
