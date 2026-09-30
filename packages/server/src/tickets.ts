/**
 * 短时、绑定用途、一次性的下载 / SSE 票据
 *
 * 历史缺陷：浏览器无法给 EventSource 与下载导航自定义 Authorization 头，
 * 于是 /api/events 与文件下载直接接受 `?access_token=<长期 Bearer>`。
 * 长期令牌会进访问日志、浏览器历史、Referer，等于把账号凭证暴露在 URL 上。
 *
 * 本服务用零依赖内存票据替代：
 *  - 签发走正常 Bearer 鉴权，并先做与实际下载 / 订阅相同的归属、存在校验；
 *  - 票据 id 用 node:crypto 随机生成，默认 60 秒过期；
 *  - 绑定用途 kind（events / download）与资源范围 resource（下载绑死具体
 *    任务产物或资料文件）；
 *  - consume 一次性：取出即删，无论校验是否通过都不复用；
 *  - 容量硬上限：全局与单身份的未消费票据数均封顶，超限拒绝签发，
 *    防止只签发不消费的高频请求把进程内存刷爆；
 *  - 纯内存，进程重启即失效（私有化单机可接受）。
 *
 * SSE 的合理一次性语义：票据只在建立连接那一下被消耗；连接建立后靠心跳
 * 保活，重连必须重新换票（前端 core.js 已据此实现）。
 */

import { randomBytes } from "node:crypto";
import type { Principal } from "./app.ts";

export type TicketKind = "events" | "download";

interface TicketClaims {
	readonly kind: TicketKind;
	/** 签发时的身份快照：消费票据不再查账号表，直接以该身份继续。 */
	readonly principal: Principal;
	/** 资源范围。events 为 null；download 绑死具体文件标识。 */
	readonly resource: string | null;
	readonly expiresAt: number;
}

export interface IssueTicketInput {
	readonly kind: TicketKind;
	readonly principal: Principal;
	readonly resource?: string | null;
}

export interface IssuedTicket {
	readonly ticket: string;
	readonly expiresInSec: number;
}

export interface ConsumeTicketInput {
	readonly kind: TicketKind;
	readonly ticket: string;
	/** 必须与签发时的资源范围完全一致，否则拒绝。 */
	readonly resource?: string | null;
}

/** 默认有效期：60 秒。足够一次下载导航或 SSE 建连，尽量缩短泄露窗口。 */
export const DEFAULT_TICKET_TTL_MS = 60_000;

/**
 * 全局未消费（现存于 Map、尚未被 consume 删除）票据硬上限。
 * 口径：私有化单机部署，60s 窗口内全工作区未消费票据总数封顶 10000；
 * 正常一次性消费与自然到期的票据不计入，只拦截持续高频签发。
 */
export const DEFAULT_MAX_ACTIVE_TICKETS = 10_000;

/**
 * 单身份未消费票据硬上限。按签发时 principal 的
 * tenantId/workspaceId/userId 复合键计数，防止单个账号刷票。
 */
export const DEFAULT_MAX_ACTIVE_TICKETS_PER_PRINCIPAL = 200;

export class TicketService {
	private readonly tickets = new Map<string, TicketClaims>();
	/** 身份复合键 → 该身份现存未消费票据数。 */
	private readonly perPrincipal = new Map<string, number>();
	private readonly ttlMs: number;
	private readonly maxActiveTickets: number;
	private readonly maxActiveTicketsPerPrincipal: number;
	private readonly now: () => number;

	constructor(options: {
		ttlMs?: number;
		now?: () => number;
		maxActiveTickets?: number;
		maxActiveTicketsPerPrincipal?: number;
	} = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_TICKET_TTL_MS;
		this.maxActiveTickets = options.maxActiveTickets ?? DEFAULT_MAX_ACTIVE_TICKETS;
		this.maxActiveTicketsPerPrincipal =
			options.maxActiveTicketsPerPrincipal ?? DEFAULT_MAX_ACTIVE_TICKETS_PER_PRINCIPAL;
		this.now = options.now ?? (() => Date.now());
	}

	/**
	 * 签发一张票据，返回票据 id 与有效期秒数。
	 * 先惰性清理过期票据，再校验全局 / 单身份未消费票据硬上限；
	 * 任一上限触顶则拒绝签发，返回 undefined（不新增任何记录），
	 * 调用方应映射为 503「票据签发过于频繁，请稍后再试」。
	 */
	issue(input: IssueTicketInput): IssuedTicket | undefined {
		// 计数前先删过期项：正常使用（60s 自然到期、一次性消费）不会误拒
		this.pruneExpired();
		const principalKey = principalKeyOf(input.principal);
		if (this.tickets.size >= this.maxActiveTickets) return undefined;
		if ((this.perPrincipal.get(principalKey) ?? 0) >= this.maxActiveTicketsPerPrincipal) {
			return undefined;
		}
		// 24 字节随机值，base64url 无填充：不可猜测、URL 安全
		const id = randomBytes(24).toString("base64url");
		this.tickets.set(id, {
			kind: input.kind,
			principal: input.principal,
			resource: input.resource ?? null,
			expiresAt: this.now() + this.ttlMs,
		});
		this.perPrincipal.set(principalKey, (this.perPrincipal.get(principalKey) ?? 0) + 1);
		return { ticket: id, expiresInSec: Math.round(this.ttlMs / 1000) };
	}

	/**
	 * 消费票据。一次性：命中即从表中删除，随后校验 kind / resource / 有效期。
	 * 任何不匹配（含拿 download 票去 events）都返回 undefined 且票据已作废。
	 */
	consume(input: ConsumeTicketInput): Principal | undefined {
		const claims = this.tickets.get(input.ticket);
		if (claims === undefined) return undefined;
		// 先删后校验：一次性语义不允许「用途不对还能拿原票再试一次」
		this.tickets.delete(input.ticket);
		this.releasePrincipalSlot(claims.principal);
		if (claims.kind !== input.kind) return undefined;
		if ((claims.resource ?? null) !== (input.resource ?? null)) return undefined;
		if (this.now() >= claims.expiresAt) return undefined;
		return claims.principal;
	}

	/** 惰性清理过期票据，同时回收对应的单身份计数名额。 */
	private pruneExpired(): void {
		const now = this.now();
		for (const [id, claims] of this.tickets) {
			if (now >= claims.expiresAt) {
				this.tickets.delete(id);
				this.releasePrincipalSlot(claims.principal);
			}
		}
	}

	private releasePrincipalSlot(principal: Principal): void {
		const key = principalKeyOf(principal);
		const count = this.perPrincipal.get(key) ?? 0;
		if (count <= 1) this.perPrincipal.delete(key);
		else this.perPrincipal.set(key, count - 1);
	}
}

/** 单身份计数复合键：租户 / 工作区 / 用户三者共同确定一个账号。 */
function principalKeyOf(principal: Principal): string {
	const { tenantId, workspaceId, userId } = principal.tenant;
	// 以 NUL 分隔，正常租户/工作区/用户 id 不会包含该字符，复合键无撞键风险
	return [tenantId, workspaceId, userId].join("\0");
}
