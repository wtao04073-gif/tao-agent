/**
 * 组织模型与权限判定
 *
 * 三层结构：租户（一所学校/一家企业）→ 工作区（部门/项目组）→ 用户。
 *
 * 两条不可妥协的规则：
 *
 *  1. **跨租户一律拒绝，没有例外。** 不是「默认拒绝但管理员可放开」——
 *     平台管理员也不能读取租户业务数据。这是 to B 产品的信任基础，
 *     一次跨租户泄漏就会终结商业合作。
 *  2. **私有化部署租户数为 1，但模型不简化。** 简化后若客户要转 SaaS，
 *     或一个集团要多校区隔离，就是重写级代价。
 */

import { Role, Scope, type TenantContext } from "./tenant.ts";

/** 资源的归属。会话、任务、知识资产都用它标记归属。 */
export interface ResourceOwnership {
	readonly tenantId: string;
	readonly workspaceId: string;
	/** 创建者。资源默认只有创建者与工作区管理员可写。 */
	readonly ownerId: string;
	/** 共享范围。默认 Personal（仅创建者）。 */
	readonly scope: Scope;
}

/** 成员身份：某用户在某租户某工作区的角色。 */
export interface Membership {
	readonly tenantId: string;
	/** 平台管理员无工作区归属，此处为 null。 */
	readonly workspaceId: string | null;
	readonly userId: string;
	readonly role: Role;
}

export const Action = {
	Read: "read",
	Write: "write",
	Delete: "delete",
	/** 管理类操作：改成员、改配置、上传技能。 */
	Administer: "administer",
} as const;

export type Action = (typeof Action)[keyof typeof Action];

export interface AccessVerdict {
	readonly allowed: boolean;
	/** 拒绝原因。面向用户，须说清为什么不行。 */
	readonly reason?: string;
	/** 拒绝的类别，用于审计分级。cross_tenant 需要告警。 */
	readonly rule?: "cross_tenant" | "cross_workspace" | "insufficient_role" | "not_owner";
}

const ALLOWED: AccessVerdict = { allowed: true };

/** 角色强弱顺序，索引越大权限越高。 */
const ROLE_RANK: readonly Role[] = [
	Role.Member,
	Role.WorkspaceAdmin,
	Role.TenantAdmin,
	Role.PlatformAdmin,
];

function rankOf(role: Role): number {
	return ROLE_RANK.indexOf(role);
}

/** 判断角色是否达到某个最低要求。 */
export function hasRoleAtLeast(role: Role, minimum: Role): boolean {
	return rankOf(role) >= rankOf(minimum);
}

/**
 * 判定一次资源访问是否允许。
 *
 * @param membership 操作者的成员身份
 * @param resource 被访问资源的归属
 * @param action 要执行的动作
 */
export function checkAccess(
	membership: Membership,
	resource: ResourceOwnership,
	action: Action,
): AccessVerdict {
	// ── 第一道：跨租户无条件拒绝 ──
	// 放在最前面且不设任何例外分支。平台管理员也不能借此读取客户业务数据 ——
	// 运维需求应通过独立的、有审计的运维通道满足，而不是放宽这里。
	if (membership.tenantId !== resource.tenantId) {
		return {
			allowed: false,
			reason: "不允许跨租户访问",
			rule: "cross_tenant",
		};
	}

	// ── 租户管理员：本租户内全权 ──
	if (hasRoleAtLeast(membership.role, Role.TenantAdmin)) {
		return ALLOWED;
	}

	// ── 工作区边界 ──
	const sameWorkspace = membership.workspaceId === resource.workspaceId;

	// 租户级共享的资源，本租户成员都可读
	if (!sameWorkspace) {
		if (action === Action.Read && resource.scope === Scope.Tenant) {
			return ALLOWED;
		}
		return {
			allowed: false,
			reason: "该资源属于其他工作区",
			rule: "cross_workspace",
		};
	}

	// ── 同工作区内 ──
	const isOwner = membership.userId === resource.ownerId;
	const isWorkspaceAdmin = hasRoleAtLeast(membership.role, Role.WorkspaceAdmin);

	switch (action) {
		case Action.Read:
			// 个人私有的资源，同工作区的普通成员也不能读
			if (resource.scope === Scope.Personal && !isOwner && !isWorkspaceAdmin) {
				return {
					allowed: false,
					reason: "该资源为创建者私有",
					rule: "not_owner",
				};
			}
			return ALLOWED;

		case Action.Write:
		case Action.Delete:
			// 读写分离：可查看不等于可编辑或删除（需求 §3.4 明确要求）
			if (isOwner || isWorkspaceAdmin) return ALLOWED;
			return {
				allowed: false,
				reason: action === Action.Delete ? "只有创建者或工作区管理员可删除" : "只有创建者或工作区管理员可修改",
				rule: "not_owner",
			};

		case Action.Administer:
			if (isWorkspaceAdmin) return ALLOWED;
			return {
				allowed: false,
				reason: "需要工作区管理员及以上权限",
				rule: "insufficient_role",
			};
	}
}

/**
 * 按访问权限过滤资源列表。
 *
 * 所有列表查询都应经由它 —— 手写过滤条件是跨租户泄漏最常见的来源。
 */
export function filterAccessible<T extends ResourceOwnership>(
	membership: Membership,
	resources: readonly T[],
	action: Action = Action.Read,
): T[] {
	return resources.filter((r) => checkAccess(membership, r, action).allowed);
}

/**
 * 断言租户上下文与成员身份一致。
 *
 * 用在请求入口：若网关传来的租户上下文与用户实际归属不符，
 * 说明上下文被伪造或拼装错误，必须立即拒绝而非继续处理。
 */
export function assertTenantMatches(context: TenantContext, membership: Membership): void {
	if (context.tenantId !== membership.tenantId) {
		throw new Error(
			`租户上下文与成员身份不一致：上下文 ${context.tenantId}，成员归属 ${membership.tenantId}`,
		);
	}
	if (context.userId !== membership.userId) {
		throw new Error("用户标识与成员身份不一致");
	}
}

/** 四级资产按 Scope 优先级合并，高优先级覆盖低优先级（需求 §3.4）。 */
export function mergeByScope<T extends { scope: Scope }>(items: readonly T[]): T[] {
	const priority = [Scope.Platform, Scope.Tenant, Scope.Workspace, Scope.Personal];
	return [...items].sort((a, b) => priority.indexOf(a.scope) - priority.indexOf(b.scope));
}
