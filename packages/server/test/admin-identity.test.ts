import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@tao/core";
import { AdminIdentity, ADMIN_IDENTITY_FILE, ADMIN_SESSION_MAX_AGE } from "../src/admin-identity.ts";
import { defaultAccounts, type AccountDirectory } from "../src/accounts.ts";

let root: string;
const secret = "test-password-long-enough";
const claim = "test-only-setup-claim-value";
const empty: AccountDirectory = { accounts: [] };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tao-identity-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
async function setup() {
	const service = new AdminIdentity(root, empty, claim);
	const session = await service.bootstrap(claim, { username: "owner", password: secret });
	return { service, ...session };
}

describe("管理身份目录", () => {
	it("迁移后旧令牌仍可用，文件只持久化摘要并保持旧文件原样", () => {
		const legacy = defaultAccounts();
		const original = JSON.stringify(legacy);
		writeFileSync(join(root, "accounts.json"), original);
		const service = new AdminIdentity(root, legacy);
		for (const account of legacy.accounts) expect(service.authenticateToken(account.token)?.role).toBe(account.role);
		const stored = readFileSync(join(root, ADMIN_IDENTITY_FILE), "utf8");
		for (const account of legacy.accounts) expect(stored).not.toContain(account.token);
		expect(readFileSync(join(root, "accounts.json"), "utf8")).toBe(original);
		expect(statSync(join(root, ADMIN_IDENTITY_FILE)).mode & 0o777).toBe(0o600);
		const restarted = new AdminIdentity(root, empty);
		expect(restarted.authenticateToken(legacy.accounts[0]!.token)?.role).toBe(Role.TenantAdmin);
	});
	it("同一稳定身份迁移时保留多个历史令牌", () => {
		const base = defaultAccounts().accounts[0]!;
		const service = new AdminIdentity(root, { accounts: [base, { ...base, token: "another-old-token-long-enough" }] });
		expect(service.authenticateToken(base.token)?.tenant.userId).toBe(base.userId);
		expect(service.authenticateToken("another-old-token-long-enough")?.tenant.userId).toBe(base.userId);
	});
	it("拒绝迁移冲突身份和损坏存储", () => {
		const base = defaultAccounts().accounts[0]!;
		expect(() => new AdminIdentity(root, { accounts: [base, { ...base, role: Role.Member, token: "another-old-token-long-enough" }] })).toThrow(/冲突/);
		writeFileSync(join(root, ADMIN_IDENTITY_FILE), '{"version":1,"accounts":[]}');
		expect(() => new AdminIdentity(root, empty)).toThrow(/存储无效/);
	});
	it("必须配置认领凭证，公开占位令牌不提供认领能力", async () => {
		const service = new AdminIdentity(root, empty);
		expect(service.bootstrapStatus()).toEqual({ required: true, configured: false });
		await expect(service.bootstrap(claim, { username: "owner", password: secret })).rejects.toMatchObject({ status: 403 });
	});
	it("首次认领仅成功一次，并发认领不能覆盖首次管理员", async () => {
		const service = new AdminIdentity(root, empty, claim);
		const results = await Promise.allSettled([
			service.bootstrap(claim, { username: "owner", password: secret }),
			service.bootstrap(claim, { username: "second", password: secret }),
		]);
		expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(service.bootstrapStatus().required).toBe(false);
		await expect(service.bootstrap(claim, { username: "third", password: secret })).rejects.toMatchObject({ status: 409 });
	});
	it("认领已有身份时撤销历史令牌，避免令牌继承新平台权限", async () => {
		const legacy = defaultAccounts();
		const service = new AdminIdentity(root, legacy, claim);
		const session = await service.bootstrap(claim, { username: "admin", password: secret });
		expect(session.principal.role).toBe(Role.PlatformAdmin);
		expect(service.authenticateToken(legacy.accounts[0]!.token)).toBeUndefined();
	});
	it("登录签发随机会话且密码和令牌均不落明文", async () => {
		const { service, token } = await setup();
		const login = await service.login("OWNER", secret);
		expect(login.token).not.toBe(token);
		expect(service.authenticateToken(login.token)?.role).toBe(Role.PlatformAdmin);
		const stored = readFileSync(join(root, ADMIN_IDENTITY_FILE), "utf8");
		expect(stored).not.toContain(secret);
		expect(stored).not.toContain(token);
		expect(stored).not.toContain(login.token);
		expect(stored).toContain("scrypt$");
		const restarted = new AdminIdentity(root, empty);
		expect(restarted.authenticateToken(login.token)?.role).toBe(Role.PlatformAdmin);
		await expect(restarted.login("owner", secret)).resolves.toMatchObject({ principal: { role: Role.PlatformAdmin } });
	});
	it("未知账号与错误密码统一拒绝，持续失败进入限流", async () => {
		const { service } = await setup();
		await expect(service.login("missing", secret)).rejects.toMatchObject({ status: 401 });
		for (let i = 0; i < 8; i++) await expect(service.login("owner", "incorrect")).rejects.toMatchObject({ status: 401 });
		await expect(service.login("owner", secret)).rejects.toMatchObject({ status: 429 });
	});
	it("会话过期与主动退出立即失效", async () => {
		const { service, token } = await setup();
		const login = await service.login("owner", secret);
		service.revokeToken(token);
		expect(service.authenticateToken(token)).toBeUndefined();
		expect(service.authenticateToken(login.token)).toBeDefined();
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + (ADMIN_SESSION_MAX_AGE + 1) * 1000);
		expect(service.authenticateToken(login.token)).toBeUndefined();
	});
	it("创建列表只暴露安全字段，大小写重复用户名被拒绝", async () => {
		const { service, principal } = await setup();
		const created = await service.create(principal, { username: "person", password: secret, name: "成员" });
		expect(created).toMatchObject({ id: "default/person", role: Role.Member, enabled: true, hasPassword: true });
		for (const item of service.list(principal)) {
			expect(item).not.toHaveProperty("passwordHash");
			expect(item).not.toHaveProperty("tokenHashes");
			expect(item).not.toHaveProperty("password");
		}
		await expect(service.create(principal, { username: "PERSON", userId: "other", password: secret })).rejects.toMatchObject({ status: 409 });
	});
	it("租户管理员只能管理本租户且不能创建或授予平台权限", async () => {
		const { service, principal } = await setup();
		await service.create(principal, { username: "tenantA", tenantId: "a", role: Role.TenantAdmin, password: secret });
		await service.create(principal, { username: "tenantB", tenantId: "b", role: Role.TenantAdmin, password: secret });
		const actor = (await service.login("tenantA", secret)).principal;
		expect(service.list(actor).every((item) => item.tenantId === "a")).toBe(true);
		await expect(service.create(actor, { username: "outsider", tenantId: "b", password: secret })).rejects.toMatchObject({ status: 403 });
		await expect(service.create(actor, { username: "platform", role: Role.PlatformAdmin, password: secret })).rejects.toMatchObject({ status: 403 });
		expect(() => service.update(actor, "a/tenantA", { role: Role.PlatformAdmin })).toThrow(/平台管理员/);
		expect(() => service.update(actor, "b/tenantB", { name: "外部" })).toThrow(/不存在/);
		await expect(service.resetPassword(actor, "b/tenantB", secret)).rejects.toMatchObject({ status: 404 });
		expect(() => service.revokeSessions(actor, "b/tenantB")).toThrow(/不存在/);
	});
	it("成员不能管理账号，最后一个管理员不能停用或降权", async () => {
		const { service, principal } = await setup();
		await service.create(principal, { username: "person", password: secret });
		const member = (await service.login("person", secret)).principal;
		expect(() => service.list(member)).toThrow(/管理员权限/);
		expect(() => service.update(principal, "default/owner", { enabled: false })).toThrow(/最后一个/);
		expect(() => service.update(principal, "default/owner", { role: Role.Member })).toThrow(/最后一个/);
		await service.create(principal, { username: "tenantA", tenantId: "a", role: Role.TenantAdmin, password: secret });
		expect(() => service.update(principal, "a/tenantA", { role: Role.Member })).toThrow(/最后一个/);
	});
	it("管理员降权立即撤销会话及旧管理权限", async () => {
		const { service, principal } = await setup();
		await service.create(principal, { username: "second", role: Role.TenantAdmin, password: secret });
		const session = await service.login("second", secret);
		service.update(principal, "default/second", { role: Role.Member });
		expect(service.authenticateToken(session.token)).toBeUndefined();
		expect(() => service.list(session.principal)).toThrow(/管理员权限/);
		expect((await service.login("second", secret)).principal.role).toBe(Role.Member);
	});
	it("停用后重启和重新启用都不恢复历史令牌", async () => {
		const legacy = defaultAccounts();
		const service = new AdminIdentity(root, legacy, claim);
		const { principal } = await service.bootstrap(claim, { username: "owner", password: secret });
		service.update(principal, "default/member", { enabled: false });
		expect(service.authenticateToken(legacy.accounts[1]!.token)).toBeUndefined();
		service.update(principal, "default/member", { enabled: true });
		expect(service.authenticateToken(legacy.accounts[1]!.token)).toBeUndefined();
	});
	it("重置密码及撤销会话持久失效，旧密码不能继续登录", async () => {
		const { service, principal } = await setup();
		await service.create(principal, { username: "person", password: secret });
		const first = await service.login("person", secret);
		await service.resetPassword(principal, "default/person", "a-new-test-password");
		expect(service.authenticateToken(first.token)).toBeUndefined();
		await expect(service.login("person", secret)).rejects.toMatchObject({ status: 401 });
		const second = await service.login("person", "a-new-test-password");
		service.revokeSessions(principal, "default/person");
		expect(service.authenticateToken(second.token)).toBeUndefined();
		expect(new AdminIdentity(root, empty).authenticateToken(second.token)).toBeUndefined();
	});
	it("并发重复创建只保存一个账号，独立创建不丢失", async () => {
		const { service, principal } = await setup();
		const duplicate = await Promise.allSettled([service.create(principal, { username: "person", password: secret }), service.create(principal, { username: "person", password: secret })]);
		expect(duplicate.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		await Promise.all([service.create(principal, { username: "one", password: secret }), service.create(principal, { username: "two", password: secret })]);
		expect(service.list(principal)).toHaveLength(4);
	});
	it("路径标识、密码长度、角色及不可变字段被校验", async () => {
		const { service, principal } = await setup();
		await expect(service.create(principal, { username: "person", password: "short" })).rejects.toMatchObject({ status: 400 });
		await expect(service.create(principal, { username: "person", password: "a".repeat(1025) })).rejects.toMatchObject({ status: 400 });
		await expect(service.create(principal, { username: "person", tenantId: "../x", password: secret })).rejects.toMatchObject({ status: 400 });
		expect(() => service.update(principal, "default/owner", { role: "bad" as Role })).toThrow(/role/);
		expect(() => service.update(principal, "default/owner", { tenantId: "other" } as never)).toThrow(/不允许/);
	});
});
it('成员可修改本人显示名，不能越权修改角色，改密码撤销所有会话',async()=>{
 const {service,principal}=await setup();await service.create(principal,{username:'member',password:secret,role:Role.Member});const member=await service.login('member',secret);
 await expect(service.updateProfile(member.principal,{role:Role.PlatformAdmin} as any)).rejects.toThrow('只允许');
 expect((await service.updateProfile(member.principal,{name:'新名字'})).account.name).toBe('新名字');expect(service.authenticateToken(member.token)).toBeTruthy();
 await expect(service.updateProfile(member.principal,{currentPassword:'wrong',newPassword:'new-long-password'})).rejects.toThrow('原密码');
 await service.updateProfile(member.principal,{currentPassword:secret,newPassword:'new-long-password'});expect(service.authenticateToken(member.token)).toBeUndefined();expect((await service.login('member','new-long-password')).principal.name).toBe('新名字');
});
