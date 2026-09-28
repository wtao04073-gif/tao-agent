/**
 * 账号目录
 *
 * M5-2：替换 M4 的「任意非空 token → 默认租户、`admin:` 前缀判管理员」。
 *
 * 形态取舍：私有化单机部署，账号数量少、变动不频繁，所以账号存一份
 * **静态 JSON 文件**（运维直接编辑、随部署分发），不做账号增删 API、不引数据库。
 * SaaS 形态把这里换成真实身份服务，`authenticateToken` 的契约不变。
 *
 * 安全要点：
 *  - token 只用于在账号文件里**精确查表**，不从前缀推断权限；
 *  - token 不落日志（describeConfig 已对 MODEL_API_KEY 脱敏，token 同理不打印）；
 *  - 查不到就是匿名（401），没有「默认身份」兜底。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Role, type Role as RoleType, type TenantContext } from "@tao/core";

/** 一个用户账号。 */
export interface Account {
	/** 登录名 / 展示名。 */
	readonly name: string;
	/**
	 * 不透明令牌。客户端用 Bearer 传它，服务端只做精确匹配。
	 * 至少 16 个字符 —— 短 token 在私有化网络里也容易被猜到。
	 */
	readonly token: string;
	readonly tenantId: string;
	readonly workspaceId: string;
	readonly userId: string;
	readonly role: RoleType;
}

/** 账号文件的顶层结构。 */
export interface AccountDirectory {
	readonly accounts: readonly Account[];
}

/** 私有化默认目录的文件名（放在工作区根，运维可见可改）。 */
export const ACCOUNTS_FILE = "accounts.json";

/**
 * 私有化默认账号。
 *
 * 首次启动若工作区没有账号文件，就用它落一份种子。**默认 token 是公开占位值，
 * 仅用于让服务首启可用** —— 种子文件与启动日志都要求部署后立即改。
 */
export function defaultAccounts(): AccountDirectory {
	return {
		accounts: [
			{
				name: "租户管理员",
				token: "change-me-admin-token-0001",
				tenantId: "default",
				workspaceId: "default",
				userId: "admin",
				role: Role.TenantAdmin,
			},
			{
				name: "普通成员",
				token: "change-me-member-token-001",
				tenantId: "default",
				workspaceId: "default",
				userId: "member",
				role: Role.Member,
			},
		],
	};
}

/** 逐账号校验，返回人类可读的错误清单（坏配置要在启动时拦住）。 */
export function validateAccounts(dir: AccountDirectory): readonly string[] {
	const errors: string[] = [];
	const tokens = new Set<string>();
	for (const [i, a] of dir.accounts.entries()) {
		const where = `第 ${i + 1} 个账号（${a.name ?? "未命名"}）`;
		if (typeof a.name !== "string" || a.name.trim() === "") errors.push(`${where}：name 为空`);
		if (typeof a.token !== "string" || a.token.length < 16) {
			errors.push(`${where}：token 至少 16 个字符`);
		}
		if (tokens.has(a.token)) errors.push(`${where}：token 与其它账号重复`);
		tokens.add(a.token);
		for (const k of ["tenantId", "workspaceId", "userId"] as const) {
			if (typeof a[k] !== "string" || a[k].trim() === "") errors.push(`${where}：${k} 为空`);
		}
		if (!Object.values(Role).includes(a.role)) {
			errors.push(`${where}：role 非法（${String(a.role)}）`);
		}
	}
	return errors;
}

/**
 * 加载账号目录。
 *
 * 文件不存在时用默认种子落盘（首启可用）；存在但解析失败/校验不过时抛错 ——
 * 带着坏账号表启动，要么所有人 401、要么权限错乱，不如起不来并说明原因。
 */
export function loadAccounts(workspaceDir: string): AccountDirectory {
	const path = join(workspaceDir, ACCOUNTS_FILE);
	if (!existsSync(path)) {
		const seed = defaultAccounts();
		writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
		return seed;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${ACCOUNTS_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
	}
	const dir = parsed as Partial<AccountDirectory>;
	if (!Array.isArray(dir.accounts)) {
		throw new Error(`${ACCOUNTS_FILE} 缺少 accounts 数组`);
	}
	const directory = { accounts: dir.accounts as readonly Account[] };
	const errors = validateAccounts(directory);
	if (errors.length > 0) {
		throw new Error(`${ACCOUNTS_FILE} 配置有误：\n - ${errors.join("\n - ")}`);
	}
	return directory;
}

/**
 * 用 Bearer token 精确查账号。
 *
 * @returns 命中则返回租户上下文与角色；查不到返回 undefined（调用方回 401）。
 */
export function authenticateToken(
	dir: AccountDirectory,
	token: string,
): { tenant: TenantContext; role: RoleType; name: string } | undefined {
	if (token === "") return undefined;
	const account = dir.accounts.find((a) => a.token === token);
	if (account === undefined) return undefined;
	return {
		tenant: {
			tenantId: account.tenantId,
			workspaceId: account.workspaceId,
			userId: account.userId,
		},
		role: account.role,
		name: account.name,
	};
}

/** 判断目录里是否仍有「change-me」占位 token（启动时给醒目警告）。 */
export function hasDefaultTokens(dir: AccountDirectory): boolean {
	return dir.accounts.some((a) => a.token.startsWith("change-me-"));
}
