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
	loadAccounts,
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
});
