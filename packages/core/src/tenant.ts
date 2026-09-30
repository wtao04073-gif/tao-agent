/**
 * 租户上下文
 *
 * **每一条业务数据都必须携带它。** 这不是可选的便利字段 ——
 * [需求 §3.8](../../../docs/requirements.md) 要求所有业务数据无条件带租户标识并施加行级隔离，
 * 且私有化部署（租户数为 1）与 SaaS 使用同一套模型、不做 schema 分叉。
 *
 * 后补租户字段是重写级代价，所以从第一行代码就带上。
 */
export interface TenantContext {
	/** 租户 —— 一所学校或一家企业。私有化部署时恒为单一值，但字段不省略。 */
	readonly tenantId: string;
	/** 工作区 —— 部门或项目组。 */
	readonly workspaceId: string;
	/** 操作者。 */
	readonly userId: string;
}

/** 角色。权限判定的输入之一，具体策略在权限门里。 */
export const Role = {
	PlatformAdmin: "PLATFORM_ADMIN",
	TenantAdmin: "TENANT_ADMIN",
	WorkspaceAdmin: "WORKSPACE_ADMIN",
	Member: "MEMBER",
} as const;

export type Role = (typeof Role)[keyof typeof Role];

/** 资产/资源的生效范围，按优先级从低到高。合并时高优先级覆盖低优先级。 */
export const Scope = {
	Platform: "PLATFORM",
	Tenant: "TENANT",
	Workspace: "WORKSPACE",
	Personal: "PERSONAL",
} as const;

export type Scope = (typeof Scope)[keyof typeof Scope];

/** 优先级顺序，索引越大优先级越高。用于四级资产合并（需求 §3.4）。 */
export const SCOPE_PRIORITY: readonly Scope[] = [
	Scope.Platform,
	Scope.Tenant,
	Scope.Workspace,
	Scope.Personal,
];
