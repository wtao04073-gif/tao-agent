/** 单进程管理身份存储；旧 accounts.json 保留，新文件仅保存凭证摘要。 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Role } from "@tao/core";
import { isSafeSegment, validateAccounts, type AccountDirectory } from "./accounts.ts";
import type { Principal } from "./app.ts";
export const ADMIN_IDENTITY_FILE = "admin-identity.json";
export const ADMIN_SESSION_MAX_AGE = 8 * 60 * 60;
import { AdminError } from "./admin-settings.ts";
export class AdminIdentityError extends AdminError {
	constructor(status: number, message: string) { super(status, message); this.name = "AdminIdentityError"; }
}
export interface AdminAccountInput { username: string; password: string; name?: string; tenantId?: string; workspaceId?: string; userId?: string; role?: Role }
export interface AdminAccountUpdate { username?: string; name?: string; role?: Role; enabled?: boolean; workspaceId?: string }
export interface AdminAccountView { id: string; username: string; name: string; tenantId: string; workspaceId: string; userId: string; role: Role; enabled: boolean; hasPassword: boolean }
interface StoredAccount extends Omit<AdminAccountView, "hasPassword"> { passwordHash?: string; tokenHashes: string[]; revision: number }
interface Session { accountId: string; revision: number; expiresAt: number }
interface State { version: 1; claimed: boolean; accounts: StoredAccount[]; sessions: Record<string, Session> }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const isAdmin = (value: Role) => value === Role.PlatformAdmin || value === Role.TenantAdmin;
const fail = (status: number, message: string): never => { throw new AdminIdentityError(status, message); };
function text(value: unknown, field: string, max = 128): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return fail(400, `${field} 格式不正确`);
	return value.trim();
}
function segment(value: unknown, field: string): string {
	const result = text(value, field);
	if (!isSafeSegment(result)) return fail(400, `${field} 必须为单段安全标识`);
	return result;
}
function username(value: unknown): string {
	const result = text(value, "username");
	if (!/^[A-Za-z0-9_@./-]+$/.test(result)) return fail(400, "username 只允许字母、数字、_、-、@、.、/");
	return result;
}
function password(value: unknown): string {
	if (typeof value !== "string" || value.length < 12 || Buffer.byteLength(value) > 1024) return fail(400, "密码必须至少 12 个字符且不超过 1024 字节");
	return value;
}
function role(value: unknown): Role {
	if (!Object.values(Role).includes(value as Role)) return fail(400, "role 不正确");
	return value as Role;
}
function derive(value: string, salt: string): Promise<Buffer> {
	return new Promise((resolve, reject) => scrypt(value, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
async function encodePassword(value: string): Promise<string> {
	const salt = randomBytes(16).toString("hex");
	return `scrypt$${salt}$${(await derive(password(value), salt)).toString("hex")}`;
}
function principalOf(account: StoredAccount): Principal {
	return { name: account.name, role: account.role, tenant: { tenantId: account.tenantId, workspaceId: account.workspaceId, userId: account.userId } };
}
function view(account: StoredAccount): AdminAccountView {
	return { id: account.id, username: account.username, name: account.name, tenantId: account.tenantId, workspaceId: account.workspaceId, userId: account.userId, role: account.role, enabled: account.enabled, hasPassword: Boolean(account.passwordHash) };
}
export class AdminIdentity {
	private state: State;
	private readonly path: string;
	private readonly setupHash?: string;
	private readonly attempts = new Map<string, { count: number; until: number }>();
	private cryptoBusy = 0;
	private readonly root: string;
 constructor(root: string, legacyDirectory: AccountDirectory, setupToken?: string) {
 this.root=root;
		mkdirSync(root, { recursive: true });
		this.path = join(root, ADMIN_IDENTITY_FILE);
		if (setupToken && setupToken.length >= 16) this.setupHash = hash(setupToken);
		if (existsSync(this.path)) { this.state = this.readState(); chmodSync(this.path, 0o600); return; }
		if (legacyDirectory.accounts.length && validateAccounts(legacyDirectory).length) fail(500, "旧账号目录校验失败");
		const accounts: StoredAccount[] = [];
		for (const old of legacyDirectory.accounts) {
			const id = `${old.tenantId}/${old.userId}`;
			const existing = accounts.find((item) => item.id === id);
			if (existing) {
				if (existing.workspaceId !== old.workspaceId || existing.role !== old.role) fail(500, "旧账号身份存在冲突");
				existing.tokenHashes.push(hash(old.token)); continue;
			}
			const loginName = legacyDirectory.accounts.some((item) => item.userId === old.userId && item.tenantId !== old.tenantId) ? id : old.userId;
			accounts.push({ id, username: loginName, name: old.name, tenantId: old.tenantId, workspaceId: old.workspaceId, userId: old.userId, role: old.role, enabled: true, tokenHashes: [hash(old.token)], revision: 0 });
		}
		this.state = { version: 1, claimed: false, accounts, sessions: {} };
		this.persist(this.state);
	}
    contexts(){return this.state.accounts.filter(a=>a.enabled).map(a=>principalOf(a));}
    validPrincipal(p:Principal){return this.state.accounts.some(a=>a.enabled&&a.tenantId===p.tenant.tenantId&&a.userId===p.tenant.userId&&a.workspaceId===p.tenant.workspaceId&&a.role===p.role);}

    get initialized(){return !this.bootstrapStatus().required;}
    get tenantCount(){return new Set(this.state.accounts.map(a=>a.tenantId)).size;}
    token(value:string){return this.authenticateToken(value);}
    session(value:string){const principal=this.authenticateToken(value);return principal?{principal,csrf:hash('csrf:'+value)}:undefined;}
    exchange(principal:Principal){const account=this.actor(principal);const result=this.issue(structuredClone(this.state),account);return {...result,csrf:hash('csrf:'+result.token)};}
    logout(value:string){this.revokeToken(value);}
    revoke(principal:Principal,id:string){this.revokeSessions(principal,id);return {ok:true};}

	bootstrapStatus(): { required: boolean; configured: boolean } {
		return { required: !this.state.claimed && !this.state.accounts.some((item) => item.enabled && isAdmin(item.role) && item.passwordHash), configured: Boolean(this.setupHash) };
	}
	async bootstrap(claimToken: string, input: AdminAccountInput): Promise<{ token: string; principal: Principal }> {
		this.rateLimit("bootstrap", 5);
		if (!this.bootstrapStatus().required) return fail(409, "管理员已经认领");
		if (!this.setupHash || typeof claimToken !== "string" || claimToken.length > 4096 || !timingSafeEqual(Buffer.from(hash(claimToken)), Buffer.from(this.setupHash))) return fail(403, "认领凭证不正确或未配置");
		const account = this.newAccount(input, Role.PlatformAdmin);
		account.passwordHash = await this.crypto(() => encodePassword(input.password));
		if (!this.bootstrapStatus().required) return fail(409, "管理员已经认领");
		const next = structuredClone(this.state);
		const existing = next.accounts.find((item) => item.id === account.id);
		this.unique(account, existing?.id);
		if (existing) {
			// 认领同时重置身份权限，历史令牌不得继承新权限。
			account.revision = existing.revision + 1;
			next.accounts = next.accounts.filter((item) => item.id !== existing.id);
			this.invalidate(next, existing.id);
		}
		next.accounts.push(account); next.claimed = true;
		return this.issue(next, account);
	}
	authenticateToken(token: string): Principal | undefined {
		if (typeof token !== "string" || !token || token.length > 4096) return undefined;
		const digest = hash(token), session = this.state.sessions[digest];
		const account = session ? this.state.accounts.find((item) => item.id === session.accountId && session.expiresAt > Date.now() && session.revision === item.revision) : this.state.accounts.find((item) => item.tokenHashes.includes(digest));
		return account?.enabled ? principalOf(account) : undefined;
	}
	async login(loginName: string, suppliedPassword: string): Promise<{ token: string; principal: Principal }> {
		const normalized = username(loginName);
		this.rateLimit(`login:${normalized.toLowerCase()}`, 8); this.rateLimit("login:global", 100);
		if (typeof suppliedPassword !== "string" || Buffer.byteLength(suppliedPassword) > 1024) return fail(401, "用户名或密码错误");
		const account = this.state.accounts.find((item) => item.username.toLowerCase() === normalized.toLowerCase());
		const encoded = account?.passwordHash, parts = encoded?.split("$");
		// 未知用户名同样执行 scrypt，减少通过响应时延枚举账号的机会。
		const actual = await this.crypto(() => derive(suppliedPassword, parts?.[1] ?? "00000000000000000000000000000000"));
		const expected = Buffer.from(parts?.[2] ?? "00".repeat(32), "hex");
		const current = account && this.state.accounts.find((item) => item.id === account.id);
		if (!encoded || !current?.enabled || current.revision !== account?.revision || !timingSafeEqual(actual, expected)) return fail(401, "用户名或密码错误");
		this.attempts.delete(`login:${normalized.toLowerCase()}`);
		return this.issue(structuredClone(this.state), current);
	}
	list(principal: Principal): AdminAccountView[] {
		const actor = this.actor(principal);
		return this.state.accounts.filter((item) => actor.role === Role.PlatformAdmin || item.tenantId === actor.tenantId).map(view);
	}
	async create(principal: Principal, input: AdminAccountInput): Promise<AdminAccountView> {
		const actor = this.actor(principal);
		const account = this.newAccount({ ...input, tenantId: input.tenantId ?? actor.tenantId, workspaceId: input.workspaceId ?? actor.workspaceId }, input.role ?? Role.Member);
		this.authorizeTarget(actor, account); this.unique(account);
		account.passwordHash = await this.crypto(() => encodePassword(input.password));
		const currentActor = this.actor(principal);
		if (currentActor.revision !== actor.revision) return fail(403, "管理员会话已失效");
		this.authorizeTarget(currentActor, account); this.unique(account);
		const next = structuredClone(this.state); next.accounts.push(account); this.persist(next);
		return view(account);
	}
	update(principal: Principal, id: string, input: AdminAccountUpdate): AdminAccountView {
		const actor = this.actor(principal), target = this.target(actor, id);
		if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["username", "name", "role", "enabled", "workspaceId"].includes(key))) return fail(400, "包含不允许修改的账号字段");
		const changed = { ...target };
		if (input.username !== undefined) changed.username = username(input.username);
		if (input.name !== undefined) changed.name = text(input.name, "name");
		if (input.workspaceId !== undefined) changed.workspaceId = segment(input.workspaceId, "workspaceId");
		if (input.role !== undefined) changed.role = role(input.role);
		if (input.enabled !== undefined) { if (typeof input.enabled !== "boolean") return fail(400, "enabled 必须为布尔值"); changed.enabled = input.enabled; }
		this.authorizeTarget(actor, changed); this.unique(changed, id); this.protectLastAdmin(target, changed);
		const next = structuredClone(this.state); changed.revision += 1;
		if (changed.role !== target.role || changed.workspaceId !== target.workspaceId || changed.enabled !== target.enabled) changed.tokenHashes = [];
		next.accounts = next.accounts.map((item) => item.id === id ? changed : item);
		this.invalidate(next, id); this.persist(next); return view(changed);
	}
	async resetPassword(principal: Principal, id: string, newPassword: string): Promise<AdminAccountView> {
		const actor = this.actor(principal); this.target(actor, id);
		const passwordHash = await this.crypto(() => encodePassword(newPassword));
		const currentActor = this.actor(principal);
		if (currentActor.revision !== actor.revision) return fail(403, "管理员会话已失效");
		this.target(currentActor, id);
		const next = structuredClone(this.state), target = next.accounts.find((item) => item.id === id)!;
		target.passwordHash = passwordHash; target.revision += 1; target.tokenHashes = [];
		this.invalidate(next, id); this.persist(next); return view(target);
	}
	revokeSessions(principal: Principal, id: string): void {
		this.target(this.actor(principal), id);
		const next = structuredClone(this.state), target = next.accounts.find((item) => item.id === id)!;
		target.revision += 1; target.tokenHashes = []; this.invalidate(next, id); this.persist(next);
	}
	revokeToken(token: string): void {
		const digest = hash(token); if (!this.state.sessions[digest]) return;
		const next = structuredClone(this.state); delete next.sessions[digest]; this.persist(next);
	}
	private newAccount(input: AdminAccountInput, accountRole: Role): StoredAccount {
		if (!input || typeof input !== "object") return fail(400, "账号输入不正确");
		const loginName = username(input.username); password(input.password);
		const tenantId = segment(input.tenantId ?? "default", "tenantId"), userId = segment(input.userId ?? loginName, "userId");
		return { id: `${tenantId}/${userId}`, username: loginName, name: text(input.name ?? loginName, "name"), tenantId, workspaceId: segment(input.workspaceId ?? "default", "workspaceId"), userId, role: role(accountRole), enabled: true, revision: 0, tokenHashes: [] };
	}
	private actor(principal: Principal): StoredAccount {
		const actor = this.state.accounts.find((item) => item.id === `${principal.tenant.tenantId}/${principal.tenant.userId}`);
		if (!actor?.enabled || !isAdmin(actor.role) || actor.role !== principal.role || actor.workspaceId !== principal.tenant.workspaceId) return fail(403, "需要管理员权限");
		return actor;
	}
	private authorizeTarget(actor: StoredAccount, target: StoredAccount): void {
		if (actor.role !== Role.PlatformAdmin && (actor.tenantId !== target.tenantId || target.role === Role.PlatformAdmin)) fail(403, "不能操作其它租户或平台管理员");
	}
	private target(actor: StoredAccount, id: string): StoredAccount {
		const target = this.state.accounts.find((item) => item.id === id);
		if (!target || (actor.role !== Role.PlatformAdmin && actor.tenantId !== target.tenantId)) return fail(404, "账号不存在");
		this.authorizeTarget(actor, target); return target;
	}
	private unique(account: StoredAccount, exceptId?: string): void {
		if (this.state.accounts.some((item) => item.id !== exceptId && (item.id === account.id || item.username.toLowerCase() === account.username.toLowerCase()))) fail(409, "账号标识或用户名已经存在");
	}
	private protectLastAdmin(before: StoredAccount, after: StoredAccount): void {
		if (!before.enabled || !isAdmin(before.role)) return;
		const others = this.state.accounts.filter((item) => item.id !== before.id && item.enabled);
		if (before.role === Role.PlatformAdmin && (!after.enabled || after.role !== Role.PlatformAdmin) && !others.some((item) => item.role === Role.PlatformAdmin)) fail(409, "不能停用或降级最后一个平台管理员");
		if ((!after.enabled || !isAdmin(after.role)) && !others.some((item) => item.tenantId === before.tenantId && isAdmin(item.role))) fail(409, "不能停用或降级租户最后一个管理员");
	}
	private invalidate(state: State, id: string): void { for (const [digest, session] of Object.entries(state.sessions)) if (session.accountId === id) delete state.sessions[digest]; }
	private issue(state: State, account: StoredAccount): { token: string; principal: Principal } {
		const now = Date.now();
		for (const [digest, session] of Object.entries(state.sessions)) if (session.expiresAt <= now) delete state.sessions[digest];
		const existing = Object.entries(state.sessions).filter(([, session]) => session.accountId === account.id).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
		for (const [digest] of existing.slice(0, Math.max(0, existing.length - 19))) delete state.sessions[digest];
		const token = randomBytes(32).toString("base64url");
		state.sessions[hash(token)] = { accountId: account.id, revision: account.revision, expiresAt: now + ADMIN_SESSION_MAX_AGE * 1000 };
		this.persist(state); return { token, principal: principalOf(account) };
	}
	private rateLimit(key: string, limit: number): void {
		const now = Date.now(); for (const [entry, value] of this.attempts) if (value.until <= now) this.attempts.delete(entry);
		if (!this.attempts.has(key) && this.attempts.size >= 2048) fail(429, "登录请求过多，请稍后重试");
		const value = this.attempts.get(key) ?? { count: 0, until: now + 15 * 60 * 1000 }; value.count += 1; this.attempts.set(key, value);
		if (value.count > limit) fail(429, "登录请求过多，请稍后重试");
	}
	private async crypto<T>(operation: () => Promise<T>): Promise<T> {
		if (this.cryptoBusy >= 2) return fail(429, "认证请求过多，请稍后重试");
		this.cryptoBusy += 1; try { return await operation(); } finally { this.cryptoBusy -= 1; }
	}
	private persist(next: State): void {
		const temporary = `${this.path}.${randomBytes(8).toString("hex")}.tmp`; let fd: number | undefined;
		try {
			fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(fd); closeSync(fd); fd = undefined;
			renameSync(temporary, this.path); this.state = next;
			fd = openSync(this.root, "r"); fsyncSync(fd);
		} finally { if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary); }
	}
	private readState(): State {
		try {
			const value = JSON.parse(readFileSync(this.path, "utf8")) as State;
			if (value.version !== 1 || typeof value.claimed !== "boolean" || !Array.isArray(value.accounts) || !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions)) throw new Error();
			const ids = new Set<string>(), names = new Set<string>();
			for (const item of value.accounts) {
				segment(item.tenantId, "tenantId"); segment(item.workspaceId, "workspaceId"); segment(item.userId, "userId"); username(item.username); text(item.name, "name"); role(item.role);
				if (item.id !== `${item.tenantId}/${item.userId}` || ids.has(item.id) || names.has(item.username.toLowerCase()) || typeof item.enabled !== "boolean" || !Number.isSafeInteger(item.revision) || item.revision < 0 || !Array.isArray(item.tokenHashes) || item.tokenHashes.some((digest) => !/^[a-f0-9]{64}$/.test(digest)) || (item.passwordHash !== undefined && !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(item.passwordHash))) throw new Error();
				ids.add(item.id); names.add(item.username.toLowerCase());
			}
			for (const [digest, session] of Object.entries(value.sessions)) if (!/^[a-f0-9]{64}$/.test(digest) || !session || !ids.has(session.accountId) || !Number.isSafeInteger(session.revision) || !Number.isSafeInteger(session.expiresAt)) throw new Error();
			return value;
		} catch { return fail(500, "管理账号存储无效，请恢复有效备份"); }
	}
}
