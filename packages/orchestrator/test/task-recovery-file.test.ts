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
		// 事件流从文件恢复
		expect(orch2.events("task-live-1").length).toBeGreaterThan(0);

		// 第三次构造：INTERRUPTED 已落盘，不应再被重复判定/追加
		const store3 = new FileTaskStore({ dir });
		const orch3 = new TaskOrchestrator(factory, { store: store3, now: () => 300 });
		expect(orch3.recover()).toEqual([]);
		expect(orch3.get("task-live-1")?.status).toBe(TaskStatus.Interrupted);
	});

	it("QUEUED 任务跨进程保持 QUEUED 且可被列出", async () => {
		const store1 = new FileTaskStore({ dir });
		const orch1 = new TaskOrchestrator(factory, { store: store1 });
		await orch1.submit(submit("task-queue-1")); // 不 run

		const orch2 = new TaskOrchestrator(factory, { store: new FileTaskStore({ dir }) });
		orch2.recover();
		const list = orch2.list(TENANT);
		expect(list.map((t) => t.taskId)).toContain("task-queue-1");
		expect(orch2.get("task-queue-1")?.status).toBe(TaskStatus.Queued);
	});
});
