/**
 * 一次性票据服务测试
 *
 * 覆盖：签发/消费、一次性失效、跨用途拒绝、资源范围不匹配拒绝、过期失效、
 * 未知票据拒绝。身份快照原样返回（不重新查账号表）。
 * 另覆盖容量硬上限：全局 / 单身份未消费票据触顶拒绝、消费与过期清理释放名额、
 * 拒绝时不新增记录、身份之间互不影响。
 */

import { describe, expect, it } from "vitest";
import { Role } from "@tao/core";
import type { Principal } from "../src/app.ts";
import {
	DEFAULT_MAX_ACTIVE_TICKETS,
	DEFAULT_MAX_ACTIVE_TICKETS_PER_PRINCIPAL,
	TicketService,
} from "../src/tickets.ts";

const principal: Principal = {
	tenant: { tenantId: "t", workspaceId: "w", userId: "u" },
	role: Role.Member,
	name: "成员",
};

function principalOf(userId: string): Principal {
	return { tenant: { tenantId: "t", workspaceId: "w", userId }, role: Role.Member };
}

function clock(): { now: () => number; advance: (ms: number) => void } {
	let t = 1_000_000;
	return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("TicketService", () => {
	it("签发后可用且带回有效期，消费返回身份快照", () => {
		const svc = new TicketService({ ttlMs: 60_000, now: clock().now });
		const { ticket, expiresInSec } = svc.issue({ kind: "download", principal, resource: "file::a.xlsx" })!;
		expect(ticket.length).toBeGreaterThan(20);
		expect(expiresInSec).toBe(60);
		const got = svc.consume({ kind: "download", ticket, resource: "file::a.xlsx" });
		expect(got).toEqual(principal);
	});

	it("一次性：第二次消费同一票据返回 undefined", () => {
		const svc = new TicketService();
		const { ticket } = svc.issue({ kind: "events", principal })!;
		expect(svc.consume({ kind: "events", ticket })).toEqual(principal);
		expect(svc.consume({ kind: "events", ticket })).toBeUndefined();
	});

	it("跨用途拒绝：download 票不能用于 events（且票据作废）", () => {
		const svc = new TicketService();
		const { ticket } = svc.issue({ kind: "download", principal, resource: "file::a" })!;
		expect(svc.consume({ kind: "events", ticket })).toBeUndefined();
		// 即便再用正确用途也不能复用
		expect(svc.consume({ kind: "download", ticket, resource: "file::a" })).toBeUndefined();
	});

	it("资源范围不匹配拒绝", () => {
		const svc = new TicketService();
		const { ticket } = svc.issue({ kind: "download", principal, resource: "art::t-1/报告.xlsx" })!;
		expect(svc.consume({ kind: "download", ticket, resource: "art::t-1/别的.xlsx" })).toBeUndefined();
		expect(svc.consume({ kind: "download", ticket, resource: "art::t-2/报告.xlsx" })).toBeUndefined();
		// 正确资源此时也已作废（一次性，不因前面失败而保留）
		expect(svc.consume({ kind: "download", ticket, resource: "art::t-1/报告.xlsx" })).toBeUndefined();
	});

	it("过期票据拒绝", () => {
		const c = clock();
		const svc = new TicketService({ ttlMs: 60_000, now: c.now });
		const { ticket } = svc.issue({ kind: "events", principal })!;
		c.advance(60_001);
		expect(svc.consume({ kind: "events", ticket })).toBeUndefined();
	});

	it("未知 / 空票据拒绝", () => {
		const svc = new TicketService();
		expect(svc.consume({ kind: "events", ticket: "nope" })).toBeUndefined();
		expect(svc.consume({ kind: "events", ticket: "" })).toBeUndefined();
	});

	it("两张票据 id 互不相同（不可猜测）", () => {
		const svc = new TicketService();
		const a = svc.issue({ kind: "events", principal })!.ticket;
		const b = svc.issue({ kind: "events", principal })!.ticket;
		expect(a).not.toBe(b);
	});

	/** 只读方式观察内部现存票据数（容量用例需要验证拒绝时未新增记录）。 */
	function activeCount(svc: TicketService): number {
		return (svc as unknown as { tickets: Map<string, unknown> }).tickets.size;
	}

	it("全局上限内可正常签发，消费释放名额后可再签发", () => {
		const svc = new TicketService({ maxActiveTickets: 2 });
		const a = svc.issue({ kind: "events", principal });
		const b = svc.issue({ kind: "events", principal });
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(activeCount(svc)).toBe(2);
		// 消费一张后名额释放
		svc.consume({ kind: "events", ticket: a!.ticket });
		const c = svc.issue({ kind: "events", principal });
		expect(c).toBeDefined();
		expect(activeCount(svc)).toBe(2);
	});

	it("超过全局上限拒绝签发且不新增记录，消费后恢复", () => {
		const svc = new TicketService({ maxActiveTickets: 3 });
		const ids = [1, 2, 3].map(() => svc.issue({ kind: "events", principal })!.ticket);
		expect(activeCount(svc)).toBe(3);
		// 第 4 张被拒，Map 不新增
		expect(svc.issue({ kind: "events", principal })).toBeUndefined();
		expect(activeCount(svc)).toBe(3);
		// 消费一张后可再签发（证明被拒的那次没有占用名额）
		svc.consume({ kind: "events", ticket: ids[0]! });
		expect(svc.issue({ kind: "events", principal })).toBeDefined();
		expect(activeCount(svc)).toBe(3);
	});

	it("超过单身份上限拒绝签发，但不影响另一身份", () => {
		const alice = principalOf("alice");
		const bob = principalOf("bob");
		const svc = new TicketService({ maxActiveTickets: 1000, maxActiveTicketsPerPrincipal: 2 });
		const aliceTicket = svc.issue({ kind: "events", principal: alice })!;
		expect(svc.issue({ kind: "events", principal: alice })).toBeDefined();
		// alice 触顶：第三张被拒且不新增记录
		expect(svc.issue({ kind: "events", principal: alice })).toBeUndefined();
		expect(activeCount(svc)).toBe(2);
		// bob 有独立的单身份名额，不受 alice 触顶影响
		expect(svc.issue({ kind: "events", principal: bob })).toBeDefined();
		expect(svc.issue({ kind: "events", principal: bob })).toBeDefined();
		expect(activeCount(svc)).toBe(4);
		// alice 消费一张后恢复，bob 的票据保持原样
		svc.consume({ kind: "events", ticket: aliceTicket.ticket });
		expect(svc.issue({ kind: "events", principal: alice })).toBeDefined();
		expect(activeCount(svc)).toBe(4);
	});

	it("单身份消费后名额释放可再签发", () => {
		const alice = principalOf("alice");
		const svc = new TicketService({ maxActiveTicketsPerPrincipal: 2 });
		const a = svc.issue({ kind: "events", principal: alice })!;
		expect(svc.issue({ kind: "events", principal: alice })).toBeDefined();
		expect(svc.issue({ kind: "events", principal: alice })).toBeUndefined();
		svc.consume({ kind: "events", ticket: a.ticket });
		expect(svc.issue({ kind: "events", principal: alice })).toBeDefined();
	});

	it("过期项经 prune 清理后全局与单身份名额都释放，可再签发", () => {
		const c = clock();
		const svc = new TicketService({
			ttlMs: 60_000,
			now: c.now,
			maxActiveTickets: 2,
			maxActiveTicketsPerPrincipal: 2,
		});
		expect(svc.issue({ kind: "events", principal })).toBeDefined();
		expect(svc.issue({ kind: "events", principal })).toBeDefined();
		expect(svc.issue({ kind: "events", principal })).toBeUndefined();
		// 跨过 TTL：下次 issue 先惰性 prune，两张过期记录及其身份计数一并清除
		c.advance(60_001);
		expect(svc.issue({ kind: "events", principal })).toBeDefined();
		expect(activeCount(svc)).toBe(1);
		expect(svc.issue({ kind: "events", principal })).toBeDefined();
		// 单身份计数已随 prune 归零重建：两张正好触顶，第三张仍被拒
		expect(svc.issue({ kind: "events", principal })).toBeUndefined();
		expect(activeCount(svc)).toBe(2);
	});

	it("默认上限常量生效：单身份第 201 张被拒（全局默认 10000）", () => {
		expect(DEFAULT_MAX_ACTIVE_TICKETS_PER_PRINCIPAL).toBe(200);
		expect(DEFAULT_MAX_ACTIVE_TICKETS).toBe(10_000);
		const svc = new TicketService();
		for (let i = 0; i < DEFAULT_MAX_ACTIVE_TICKETS_PER_PRINCIPAL; i += 1) {
			expect(svc.issue({ kind: "events", principal })).toBeDefined();
		}
		// 默认单身份上限触顶
		expect(svc.issue({ kind: "events", principal })).toBeUndefined();
		expect(activeCount(svc)).toBe(DEFAULT_MAX_ACTIVE_TICKETS_PER_PRINCIPAL);
	});
});
