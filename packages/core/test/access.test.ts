/**
 * 权限判定测试
 *
 * 按攻击性方式测 —— 跨租户泄漏是本产品最不可接受的缺陷，
 * 一次泄漏就会终结商业合作。所以重点不是「正常访问能通过」，
 * 而是穷举各种越权路径确认都被拦住。
 */

import { describe, expect, it } from "vitest";
import {
	Action,
	assertTenantMatches,
	checkAccess,
	filterAccessible,
	hasRoleAtLeast,
	mergeByScope,
	type Membership,
	type ResourceOwnership,
} from "../src/access.ts";
import { Role, Scope } from "../src/tenant.ts";

const member = (over: Partial<Membership> = {}): Membership => ({
	tenantId: "t1",
	workspaceId: "w1",
	userId: "u1",
	role: Role.Member,
	...over,
});

const resource = (over: Partial<ResourceOwnership> = {}): ResourceOwnership => ({
	tenantId: "t1",
	workspaceId: "w1",
	ownerId: "u1",
	scope: Scope.Workspace,
	...over,
});

const ALL_ACTIONS = Object.values(Action);

describe("权限 · 跨租户无条件拒绝", () => {
	it("普通成员不能访问其他租户的任何资源", () => {
		for (const action of ALL_ACTIONS) {
			const verdict = checkAccess(member(), resource({ tenantId: "t2" }), action);
			expect(verdict.allowed).toBe(false);
			expect(verdict.rule).toBe("cross_tenant");
		}
	});

	it("租户管理员也不能跨租户", () => {
		for (const action of ALL_ACTIONS) {
			const verdict = checkAccess(
				member({ role: Role.TenantAdmin }),
				resource({ tenantId: "t2" }),
				action,
			);
			expect(verdict.allowed).toBe(false);
			expect(verdict.rule).toBe("cross_tenant");
		}
	});

	it("平台管理员也不能跨租户读业务数据（关键：不设例外）", () => {
		// 若给平台管理员开后门，「运维需要」会迅速演变成常态化访问，
		// 客户安全审计必然通不过。运维需求应走独立的有审计的通道。
		for (const action of ALL_ACTIONS) {
			const verdict = checkAccess(
				member({ role: Role.PlatformAdmin }),
				resource({ tenantId: "other-tenant" }),
				action,
			);
			expect(verdict.allowed).toBe(false);
			expect(verdict.rule).toBe("cross_tenant");
		}
	});

	it("租户级共享也不能跨租户读取", () => {
		// Scope.Tenant 的含义是「本租户内共享」，不是「所有租户可见」
		const verdict = checkAccess(
			member(),
			resource({ tenantId: "t2", scope: Scope.Tenant }),
			Action.Read,
		);
		expect(verdict.allowed).toBe(false);
		expect(verdict.rule).toBe("cross_tenant");
	});
});

describe("权限 · 工作区边界", () => {
	it("普通成员不能访问其他工作区的工作区级资源", () => {
		const verdict = checkAccess(member(), resource({ workspaceId: "w2" }), Action.Read);
		expect(verdict.allowed).toBe(false);
		expect(verdict.rule).toBe("cross_workspace");
	});

	it("租户级共享的资源可跨工作区读", () => {
		const verdict = checkAccess(
			member(),
			resource({ workspaceId: "w2", scope: Scope.Tenant }),
			Action.Read,
		);
		expect(verdict.allowed).toBe(true);
	});

	it("租户级共享仍不可跨工作区写（读写分离）", () => {
		for (const action of [Action.Write, Action.Delete, Action.Administer]) {
			const verdict = checkAccess(
				member(),
				resource({ workspaceId: "w2", scope: Scope.Tenant }),
				action,
			);
			expect(verdict.allowed).toBe(false);
		}
	});

	it("租户管理员可跨工作区操作（本租户内全权）", () => {
		for (const action of ALL_ACTIONS) {
			expect(
				checkAccess(member({ role: Role.TenantAdmin }), resource({ workspaceId: "w2" }), action)
					.allowed,
			).toBe(true);
		}
	});
});

describe("权限 · 读写分离（需求明确要求）", () => {
	it("同工作区成员可读他人资源，但不能改不能删", () => {
		const other = resource({ ownerId: "u2" });
		expect(checkAccess(member(), other, Action.Read).allowed).toBe(true);
		expect(checkAccess(member(), other, Action.Write).allowed).toBe(false);
		expect(checkAccess(member(), other, Action.Delete).allowed).toBe(false);
	});

	it("创建者可改可删自己的资源", () => {
		const own = resource({ ownerId: "u1" });
		expect(checkAccess(member(), own, Action.Write).allowed).toBe(true);
		expect(checkAccess(member(), own, Action.Delete).allowed).toBe(true);
	});

	it("工作区管理员可改删本工作区内他人资源", () => {
		const other = resource({ ownerId: "u2" });
		const admin = member({ role: Role.WorkspaceAdmin, userId: "u9" });
		expect(checkAccess(admin, other, Action.Write).allowed).toBe(true);
		expect(checkAccess(admin, other, Action.Delete).allowed).toBe(true);
	});

	it("普通成员不能执行管理操作", () => {
		const verdict = checkAccess(member(), resource(), Action.Administer);
		expect(verdict.allowed).toBe(false);
		expect(verdict.rule).toBe("insufficient_role");
	});
});

describe("权限 · 个人私有资源", () => {
	it("同工作区普通成员不能读他人的个人私有资源", () => {
		const personal = resource({ ownerId: "u2", scope: Scope.Personal });
		const verdict = checkAccess(member(), personal, Action.Read);
		expect(verdict.allowed).toBe(false);
		expect(verdict.rule).toBe("not_owner");
	});

	it("创建者可读自己的个人私有资源", () => {
		const personal = resource({ ownerId: "u1", scope: Scope.Personal });
		expect(checkAccess(member(), personal, Action.Read).allowed).toBe(true);
	});

	it("工作区管理员可读本工作区内的个人私有资源", () => {
		// 管理责任需要可见性，但这属于有意的设计选择而非疏漏
		const personal = resource({ ownerId: "u2", scope: Scope.Personal });
		const admin = member({ role: Role.WorkspaceAdmin, userId: "u9" });
		expect(checkAccess(admin, personal, Action.Read).allowed).toBe(true);
	});
});

describe("权限 · 列表过滤", () => {
	it("filterAccessible 滤掉全部不可访问项", () => {
		const resources = [
			resource({ workspaceId: "w1" }), // 可读
			resource({ tenantId: "t2" }), // 跨租户
			resource({ workspaceId: "w2" }), // 跨工作区
			resource({ workspaceId: "w2", scope: Scope.Tenant }), // 租户共享，可读
			resource({ ownerId: "u2", scope: Scope.Personal }), // 他人私有
		];
		const visible = filterAccessible(member(), resources);
		expect(visible).toHaveLength(2);
		// 确认没有任何跨租户项漏出
		expect(visible.every((r) => r.tenantId === "t1")).toBe(true);
	});

	it("按写权限过滤比按读权限更严", () => {
		const resources = [resource({ ownerId: "u1" }), resource({ ownerId: "u2" })];
		expect(filterAccessible(member(), resources, Action.Read)).toHaveLength(2);
		expect(filterAccessible(member(), resources, Action.Write)).toHaveLength(1);
	});

	it("空列表与全不可访问都返回空数组而非报错", () => {
		expect(filterAccessible(member(), [])).toEqual([]);
		expect(filterAccessible(member(), [resource({ tenantId: "other" })])).toEqual([]);
	});
});

describe("权限 · 角色强弱", () => {
	it("角色排序正确", () => {
		expect(hasRoleAtLeast(Role.PlatformAdmin, Role.TenantAdmin)).toBe(true);
		expect(hasRoleAtLeast(Role.TenantAdmin, Role.WorkspaceAdmin)).toBe(true);
		expect(hasRoleAtLeast(Role.WorkspaceAdmin, Role.Member)).toBe(true);
		expect(hasRoleAtLeast(Role.Member, Role.WorkspaceAdmin)).toBe(false);
	});

	it("同级视为满足", () => {
		expect(hasRoleAtLeast(Role.Member, Role.Member)).toBe(true);
	});
});

describe("权限 · 上下文一致性", () => {
	it("租户上下文与成员身份不符时抛错", () => {
		// 网关传来的上下文若被伪造或拼装错误，必须立即拒绝
		expect(() =>
			assertTenantMatches({ tenantId: "t2", workspaceId: "w1", userId: "u1" }, member()),
		).toThrow(/不一致/);
	});

	it("用户标识不符时抛错", () => {
		expect(() =>
			assertTenantMatches({ tenantId: "t1", workspaceId: "w1", userId: "attacker" }, member()),
		).toThrow(/用户标识/);
	});

	it("一致时不抛错", () => {
		expect(() =>
			assertTenantMatches({ tenantId: "t1", workspaceId: "w1", userId: "u1" }, member()),
		).not.toThrow();
	});
});

describe("权限 · 四级资产合并", () => {
	it("按 Platform → Tenant → Workspace → Personal 排序", () => {
		const items = [
			{ scope: Scope.Personal, v: "个人" },
			{ scope: Scope.Platform, v: "平台" },
			{ scope: Scope.Workspace, v: "工作区" },
			{ scope: Scope.Tenant, v: "租户" },
		];
		expect(mergeByScope(items).map((i) => i.v)).toEqual(["平台", "租户", "工作区", "个人"]);
	});

	it("不改变原数组", () => {
		const items = [{ scope: Scope.Personal }, { scope: Scope.Platform }];
		const before = [...items];
		mergeByScope(items);
		expect(items).toEqual(before);
	});
});

describe("权限 · 私有化单租户场景", () => {
	it("租户数为 1 时模型照常工作（不简化）", () => {
		// 私有化部署只有一个租户，但三层模型与权限判定完全一致 ——
		// 简化后若客户要转 SaaS 或集团要多校区隔离，就是重写级代价
		const single = member({ tenantId: "the-only-tenant" });
		const own = resource({ tenantId: "the-only-tenant" });
		expect(checkAccess(single, own, Action.Read).allowed).toBe(true);

		// 隔离机制依然生效
		expect(checkAccess(single, resource({ tenantId: "ghost" }), Action.Read).allowed).toBe(false);
	});
});
