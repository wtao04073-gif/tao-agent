/**
 * 账号目录测试（M5-2）
 *
 * 守住的核心：token 精确查表映射身份与角色，查不到就是匿名；
 * 不再有「任意非空 token 进默认租户」「admin: 前缀判管理员」。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@tao/core";
import {
	authenticateToken,
	defaultAccounts,
	hasDefaultTokens,
	isSafeSegment,
	loadAccounts,
	resolveWorkspaceDir,
	validateAccounts,
} from "../src/accounts.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tao-accounts-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("账号目录 · 查表鉴权", () => {
	it("用正确 token 查到身份与角色，租户字段来自账号而非 token", () => {
		const hit = authenticateToken(defaultAccounts(), "change-me-admin-token-0001");
		expect(hit?.role).toBe(Role.TenantAdmin);
		expect(hit?.tenant).toEqual({ tenantId: "default", workspaceId: "default", userId: "admin" });
	});

	it("普通成员 token 不会被当成管理员", () => {
		const hit = authenticateToken(defaultAccounts(), "change-me-member-token-001");
		expect(hit?.role).toBe(Role.Member);
	});

	it("查不到 / 空 token 都是匿名（undefined）", () => {
		expect(authenticateToken(defaultAccounts(), "")).toBeUndefined();
		expect(authenticateToken(defaultAccounts(), "not-a-real-token")).toBeUndefined();
	});

	it("admin: 前缀不再授予任何权限 —— 必须精确匹配", () => {
		// M4 的旧规则：admin:<任意> 即管理员。新规则下它只是个不认识的 token
		expect(authenticateToken(defaultAccounts(), "admin:anything")).toBeUndefined();
	});
});

describe("账号目录 · 加载与校验", () => {
	it("首次启动落默认种子，含占位 token 警告", () => {
		const loaded = loadAccounts(dir);
		expect(loaded.accounts.length).toBe(2);
		expect(hasDefaultTokens(loaded)).toBe(true);
		// 文件已落盘且权限收紧
		const again = loadAccounts(dir);
		expect(again.accounts.length).toBe(2);
	});

	it("坏 JSON 启动即抛错（不静默用空目录）", () => {
		writeFileSync(join(dir, "accounts.json"), "{ not json");
		expect(() => loadAccounts(dir)).toThrow(/JSON/);
	});

	it("短 token / 重复 token / 空字段 / 非法角色都进错误清单", () => {
		const errors = validateAccounts({
			accounts: [
				{ name: "a", token: "short", tenantId: "t", workspaceId: "w", userId: "u", role: Role.Member },
				{
					name: "b",
					token: "short",
					tenantId: "t",
					workspaceId: "w",
					userId: "u2",
					role: "NOT_A_ROLE" as Role,
				},
				{ name: "", token: "0123456789abcdef", tenantId: "", workspaceId: "w", userId: "u3", role: Role.Member },
			],
		});
		expect(errors.join(" ")).toContain("token 至少 16");
		expect(errors.join(" ")).toContain("重复");
		expect(errors.join(" ")).toContain("role 非法");
		expect(errors.join(" ")).toContain("tenantId 为空");
	});

	it("改过的账号文件（无占位 token）不再警告", () => {
		const custom = {
			accounts: [
				{
					name: "李管理",
					token: "a-very-long-random-token-value-9f8e7d",
					tenantId: "school-1",
					workspaceId: "jiaowu",
					userId: "u-li",
					role: Role.TenantAdmin,
				},
			],
		};
		writeFileSync(join(dir, "accounts.json"), JSON.stringify(custom));
		const loaded = loadAccounts(dir);
		expect(hasDefaultTokens(loaded)).toBe(false);
		const hit = authenticateToken(loaded, "a-very-long-random-token-value-9f8e7d");
		expect(hit?.tenant.tenantId).toBe("school-1");
		expect(hit?.tenant.userId).toBe("u-li");
	});

	it("空账号数组启动即报错（不放行无人可登录的配置）", () => {
		const errors = validateAccounts({ accounts: [] });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain("至少需要一个账号");
		writeFileSync(join(dir, "accounts.json"), JSON.stringify({ accounts: [] }));
		expect(() => loadAccounts(dir)).toThrow(/至少需要一个账号/);
	});

	it("非法标识在启动时被拦，且错误能指明是哪个字段", () => {
		const bad = ["a/b", "..", ".", "a\\b", "a b", "a\tb", "a.b"];
		for (const value of bad) {
			const errors = validateAccounts({
				accounts: [
					{ name: "x", token: "0123456789abcdef", tenantId: value, workspaceId: "w", userId: "u", role: Role.Member },
				],
			});
			expect(errors.join(" "), `tenantId=${value}`).toContain("tenantId");
		}
		const errors = validateAccounts({
			accounts: [
				{ name: "x", token: "0123456789abcdef", tenantId: "t", workspaceId: "../escape", userId: "u", role: Role.Member },
			],
		});
		expect(errors.join(" ")).toContain("workspaceId");
	});

	it("合法的单段标识（字母数字 / 连字符 / 下划线）通过校验", () => {
		for (const value of ["abc", "school-1", "work_space", "A1_b-2", "default"]) {
			expect(isSafeSegment(value)).toBe(true);
		}
		const errors = validateAccounts({
			accounts: [
				{ name: "x", token: "0123456789abcdef", tenantId: "school-1", workspaceId: "work_space", userId: "u-1", role: Role.Member },
			],
		});
		expect(errors).toEqual([]);
	});

	it("默认种子的标识全部合法", () => {
		expect(validateAccounts(defaultAccounts())).toEqual([]);
	});
});

describe("账号目录 · 工作区路径边界", () => {
	it("正常标识解析到工作区根之内", () => {
		const target = resolveWorkspaceDir("/data/ws", "default", "default");
		expect(target).toBe(join("/data/ws", "default", "default"));
	});

	it("逃逸标识即使绕过账号校验，也会被路径边界断言拒绝", () => {
		expect(() => resolveWorkspaceDir("/data/ws", "..", "default")).toThrow(/越界/);
		expect(() => resolveWorkspaceDir("/data/ws", "../escape", "w")).toThrow(/越界/);
		expect(() => resolveWorkspaceDir("/data/ws", "t", "../../escape")).toThrow(/越界/);
	});
});
