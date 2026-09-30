/**
 * 状态机测试
 *
 * 状态机是真实事故来源 —— 非法迁移会导致重复结算（已 SUCCEEDED 又被结算）
 * 或幽灵执行（CANCELLED 后又被恢复）。这里把设计文档的状态图钉成断言。
 */

import { describe, expect, it } from "vitest";
import {
	allowedTransitions,
	canTransition,
	isTerminal,
	TaskStatus,
	TERMINAL_STATUSES,
} from "../src/task-status.ts";

const ALL = Object.values(TaskStatus);

describe("任务状态机", () => {
	it("终态不可再迁移到任何状态", () => {
		for (const status of TERMINAL_STATUSES) {
			expect(allowedTransitions(status)).toEqual([]);
			for (const to of ALL) {
				expect(canTransition(status, to)).toBe(false);
			}
		}
	});

	it("isTerminal 与 TERMINAL_STATUSES 一致", () => {
		for (const status of ALL) {
			expect(isTerminal(status)).toBe(TERMINAL_STATUSES.includes(status));
		}
	});

	it("EXCEEDED 不是终态 —— 用户可决定是否继续", () => {
		// 验收要求「超限转为需用户确认是否继续」，所以它必须能回到 RUNNING。
		expect(isTerminal(TaskStatus.Exceeded)).toBe(false);
		expect(canTransition(TaskStatus.Exceeded, TaskStatus.Running)).toBe(true);
		expect(canTransition(TaskStatus.Exceeded, TaskStatus.Cancelled)).toBe(true);
	});

	it("AWAIT_CONFIRM 可双向：确认回到执行、拒绝则取消", () => {
		expect(canTransition(TaskStatus.Running, TaskStatus.AwaitConfirm)).toBe(true);
		expect(canTransition(TaskStatus.AwaitConfirm, TaskStatus.Running)).toBe(true);
		expect(canTransition(TaskStatus.AwaitConfirm, TaskStatus.Cancelled)).toBe(true);
	});

	it("排队中的任务不能直接成功（必须经过执行）", () => {
		expect(canTransition(TaskStatus.Queued, TaskStatus.Succeeded)).toBe(false);
		expect(canTransition(TaskStatus.Queued, TaskStatus.Running)).toBe(true);
	});

	it("任何状态都不能迁移到 QUEUED（不允许回到队列）", () => {
		// 若允许，则同一任务可能被排队两次、消耗两份配额。
		for (const from of ALL) {
			expect(canTransition(from, TaskStatus.Queued)).toBe(false);
		}
	});

	it("每个非终态都有至少一条出路（不存在死锁状态）", () => {
		for (const status of ALL) {
			if (isTerminal(status)) continue;
			expect(allowedTransitions(status).length).toBeGreaterThan(0);
		}
	});

	it("每个非终态都能走向取消（用户始终可以放弃）", () => {
		for (const status of ALL) {
			if (isTerminal(status)) continue;
			expect(canTransition(status, TaskStatus.Cancelled)).toBe(true);
		}
	});

	it("自迁移一律非法", () => {
		for (const status of ALL) {
			expect(canTransition(status, status)).toBe(false);
		}
	});
});
