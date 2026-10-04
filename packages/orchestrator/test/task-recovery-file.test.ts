/**
 * 编排器 × 文件存储的恢复组合测试（M5-1）
 *
 * orchestrator 的 recover 用内存存储测过语义，文件存储用直接读写测过格式，
 * 这条把两者接到一起 —— 模拟真实部署：第一个编排器往磁盘写，第二个编排器
 * 用同一个目录构造（= 新进程），验证任务状态与事件从真实文件恢复。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTaskStore } from "@tao/knowledge";
import {
	TaskStatus,
	type Runner,
	type RunnerFactory,
	type RunnerSpec,
	type TaskChange,
	type TaskEvent,
	type TenantContext,
} from "@tao/core";
import { TaskOrchestrator } from "../src/task-orchestrator.ts";

const TENANT: TenantContext = { tenantId: "t1", workspaceId: "w1", userId: "u1" };

function hangingRunner(): Runner & { entered: Promise<void> } {
	const listeners = new Set<(e: TaskEvent) => void | Promise<void>>();
	let mark: () => void = () => {};
	const entered = new Promise<void>((r) => (mark = r));
	return {
		sessionId: "s1",
		entered,
		async prompt() {
			mark();
			await new Promise<void>(() => {}); // 永不结束
		},
		async steer() {},
		async abort() {},
		subscribe(l) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		async close() {},
	};
}

const factory: RunnerFactory = { createRunner: async (_s: RunnerSpec) => hangingRunner() };

const submit = (taskId: string) => ({
	tenant: TENANT,
	taskId,
	sessionId: "s1",
	prompt: "核对",
	systemPrompt: "sys",
	tools: [],
	gate: () => ({ kind: "allow" as const }),
});

describe("编排器 × 文件存储 · 真实重启恢复", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tao-recover-file-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("两个编排器实例共用同一磁盘目录：RUNNING 在新实例中变 INTERRUPTED", async () => {
		const store1 = new FileTaskStore({ dir });
		const r1 = hangingRunner();
		const factory1: RunnerFactory = { createRunner: async () => r1 as Runner };
		const orch1 = new TaskOrchestrator(factory1, { store: store1, now: () => 100 });
		await orch1.submit(submit("task-live-1"));
		void orch1.run("task-live-1", "核对");
		await r1.entered;
		expect(orch1.get("task-live-1")?.status).toBe(TaskStatus.Running);

		// 新进程：新建文件存储（重新扫目录）与新编排器
		const store2 = new FileTaskStore({ dir });
		const orch2 = new TaskOrchestrator(factory, { store: store2, now: () => 200 });
		const interrupted = orch2.recover();

		expect(interrupted).toEqual(["task-live-1"]);
		const got = orch2.get("task-live-1");
		expect(got?.status).toBe(TaskStatus.Interrupted);
		expect(got?.reason).toContain("重启");
		// 事件流从文件恢复，且末尾正是本次恢复补写的 INTERRUPTED status 事件
		const replayed = orch2.events("task-live-1");
		expect(replayed.length).toBeGreaterThan(0);
		const lastEvent = replayed[replayed.length - 1];
		expect(lastEvent?.type).toBe("status");
		expect(lastEvent?.type === "status" ? lastEvent.to : "").toBe(
			TaskStatus.Interrupted,
		);

		// 第三次构造：INTERRUPTED 已落盘，不应再被重复判定/追加
		const store3 = new FileTaskStore({ dir });
		const orch3 = new TaskOrchestrator(factory, { store: store3, now: () => 300 });
		expect(orch3.recover()).toEqual([]);
		expect(orch3.get("task-live-1")?.status).toBe(TaskStatus.Interrupted);
		// 幂等：第三次恢复没有再补一条 INTERRUPTED 事件
		expect(orch3.events("task-live-1")).toHaveLength(replayed.length);
	});

	it("createRunner 失败后磁盘上是 FAILED 而非 QUEUED，重启不复活", async () => {
		const failingFactory: RunnerFactory = {
			createRunner: async () => {
				throw new Error("模型会话初始化失败：额度不足");
			},
		};
		const store1 = new FileTaskStore({ dir });
		const orch1 = new TaskOrchestrator(failingFactory, { store: store1, now: () => 100 });
		await expect(orch1.submit(submit("task-zombie-1"))).rejects.toThrow(/额度不足/);

		// 新进程重放：终态 FAILED，recover 不会再动它
		const store2 = new FileTaskStore({ dir });
		const orch2 = new TaskOrchestrator(factory, { store: store2, now: () => 200 });
		expect(orch2.recover()).toEqual([]);
		const got = orch2.get("task-zombie-1");
		expect(got?.status).toBe(TaskStatus.Failed);
		expect(got?.reason).toContain("额度不足");
	});

	it("QUEUED 任务跨进程转为中断且可被列出", async () => {
		const store1 = new FileTaskStore({ dir });
		const orch1 = new TaskOrchestrator(factory, { store: store1 });
		await orch1.submit(submit("task-queue-1")); // 不 run

		const orch2 = new TaskOrchestrator(factory, { store: new FileTaskStore({ dir }) });
		orch2.recover();
		const list = orch2.list(TENANT);
		expect(list.map((t) => t.taskId)).toContain("task-queue-1");
		expect(orch2.get("task-queue-1")?.status).toBe(TaskStatus.Interrupted);
	});

	it("事件流缺号、变更流更大时：真实文件上补的 INTERRUPTED 从 max+1 起号", () => {
		// 模拟 appendEvent 对 seq=4 落盘失败后的磁盘状态：
		// 变更流（tasks/*.jsonl）有 seq=1,2,4（seq4 为 artifact 变更，保持 RUNNING），
		// 事件流（events/*.jsonl）只有 seq=1,2,3。
		const store = new FileTaskStore({ dir });
		const ch = (c: Omit<TaskChange, "tenant" | "sessionId">): TaskChange => ({
			...c,
			tenant: TENANT,
			sessionId: "s1",
		});
		store.create(ch({ taskId: "gap-file-1", seq: 1, at: 100, from: null, to: TaskStatus.Queued }));
		store.appendChange(
			ch({ taskId: "gap-file-1", seq: 2, at: 200, from: TaskStatus.Queued, to: TaskStatus.Running }),
		);
		store.appendChange(
			ch({
				taskId: "gap-file-1",
				seq: 4,
				at: 400,
				from: TaskStatus.Running,
				to: TaskStatus.Running,
				artifacts: ["report.xlsx"],
			}),
		);
		const ev = (e: Omit<TaskEvent, "taskId" | "tenant">): TaskEvent => ({
			...e,
			taskId: "gap-file-1",
			tenant: TENANT,
		});
		store.appendEvent(
			ev({
				eventId: "gap-file-1-1",
				at: 100,
				seq: 1,
				type: "status",
				from: null,
				to: TaskStatus.Queued,
			}),
		);
		store.appendEvent(
			ev({
				eventId: "gap-file-1-2",
				at: 200,
				seq: 2,
				type: "status",
				from: TaskStatus.Queued,
				to: TaskStatus.Running,
			}),
		);
		store.appendEvent(
			ev({
				eventId: "gap-file-1-3",
				at: 300,
				seq: 3,
				type: "step",
				step: 1,
				action: "执行中",
				phase: "started",
			}),
		);
		expect(store.maxChangeSeq("gap-file-1")).toBe(4);

		// 新进程：另一个 FileTaskStore 重新读盘 + 编排器恢复
		const store2 = new FileTaskStore({ dir });
		const orch2 = new TaskOrchestrator(factory, { store: store2, now: () => 500 });
		expect(orch2.recover()).toEqual(["gap-file-1"]);
		const replayed = orch2.events("gap-file-1");
		const last = replayed[replayed.length - 1];
		expect(last?.type === "status" ? last.to : "").toBe(TaskStatus.Interrupted);
		expect(last?.seq).toBe(5); // 不是复用 4
		// Last-Event-ID=3 重连能收到 seq=5
		expect(orch2.events("gap-file-1", 3).map((e) => e.seq)).toEqual([5]);
		// 事件流文件里序号唯一（1,2,3,5）
		const eventSeqs = store2.events("gap-file-1").map((e) => e.seq);
		expect(eventSeqs).toEqual([1, 2, 3, 5]);
		expect(store2.maxChangeSeq("gap-file-1")).toBe(5);
		expect(store2.get("gap-file-1")?.status).toBe(TaskStatus.Interrupted);

		// 第三实例：INTERRUPTED 已落盘，不重复补
		const orch3 = new TaskOrchestrator(factory, { store: new FileTaskStore({ dir }), now: () => 600 });
		expect(orch3.recover()).toEqual([]);
	});
});
