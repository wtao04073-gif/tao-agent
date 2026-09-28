/**
 * 任务持久化与重启恢复测试（M5-1）
 *
 * 用内存 TaskStore 模拟「同一存储、两个编排器实例」= 进程重启。
 * 验的核心是恢复语义，不是文件 IO（文件读写另在 knowledge 包测）：
 *  - RUNNING 必须变 INTERRUPTED，不能留下无执行器的僵尸 RUNNING；
 *  - QUEUED / CANCELLED 等状态原样恢复；
 *  - 事件历史可断线重连。
 *
 * 只用公开 API 驱动编排器，不访问私有方法：失败/产物由假 Runner 发事件产生。
 */

import { MemoryTaskStore } from "@tao/knowledge";
import {
	TaskStatus,
	type Runner,
	type RunnerFactory,
	type RunnerSpec,
	type TaskEvent,
	type TenantContext,
} from "@tao/core";
import { describe, expect, it } from "vitest";
import { TaskOrchestrator } from "../src/task-orchestrator.ts";

const TENANT: TenantContext = { tenantId: "t1", workspaceId: "w1", userId: "u1" };

interface ScriptedRunner extends Runner {
	/** 让测试能控制下一次 prompt 的行为。 */
	setScript(fn: (emit: (e: TaskEvent) => void) => Promise<void> | void): void;
	/** prompt 已进入（此时状态已是 RUNNING），await 它即可确认执行开始。 */
	readonly entered: Promise<void>;
}

/** 可编排的假 Runner：prompt 时执行当前脚本，可发事件或抛错。 */
function scriptedRunner(): ScriptedRunner {
	const listeners = new Set<(e: TaskEvent) => void | Promise<void>>();
	let script: (emit: (e: TaskEvent) => void) => Promise<void> | void = () => {};
	let markEntered: () => void = () => {};
	const entered = new Promise<void>((r) => (markEntered = r));
	let seq = 0;
	const emit = (partial: Partial<TaskEvent> & { type: TaskEvent["type"] }): void => {
		seq += 1;
		const event = {
			eventId: `fake-${seq}`,
			seq: 1000 + seq,
			taskId: "task-x",
			tenant: TENANT,
			at: seq,
			...partial,
		} as TaskEvent;
		for (const l of listeners) void l(event);
	};
	const runner: ScriptedRunner = {
		sessionId: "session-1",
		entered,
		setScript(fn) {
			script = fn;
		},
		async prompt() {
			markEntered();
			await script(emit as (e: TaskEvent) => void);
		},
		async steer() {},
		async abort() {},
		subscribe(l) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		async close() {},
	};
	return runner;
}

function factoryWith(runner: Runner): RunnerFactory {
	return { createRunner: async (_s: RunnerSpec) => runner };
}

function submitFor(taskId: string) {
	return {
		tenant: TENANT,
		taskId,
		sessionId: "session-1",
		prompt: "核对两张表",
		systemPrompt: "你是对账助手",
		tools: [],
		gate: () => ({ kind: "allow" as const }),
	};
}

describe("持久化 · 重启恢复", () => {
	/** 推进若干个微任务，让编排器里「事件 → fanout → 持久化」的异步回调跑完。 */
	async function flush(times = 6): Promise<void> {
		for (let i = 0; i < times; i += 1) await Promise.resolve();
	}

	it("执行中的任务重启后变 INTERRUPTED，不留下僵尸 RUNNING", async () => {
		const store = new MemoryTaskStore();
		const runner = scriptedRunner();
		// prompt 永不返回 —— 进程死时任务确实还在执行
		runner.setScript(() => new Promise<void>(() => {}));
		const before = new TaskOrchestrator(factoryWith(runner), { store, now: () => 100 });
		await before.submit(submitFor("running-1"));
		void before.run("running-1", "核对");
		await runner.entered;
		expect(before.get("running-1")?.status).toBe(TaskStatus.Running);

		// 进程「死亡」：Runner 与内存 Map 消失，store 里有变更流
		const after = new TaskOrchestrator(factoryWith(scriptedRunner()), {
			store,
			now: () => 200,
		});
		const interrupted = after.recover();
		expect(interrupted).toEqual(["running-1"]);
		const restored = after.get("running-1");
		expect(restored?.status).toBe(TaskStatus.Interrupted);
		expect(restored?.reason).toContain("重启");
	});

	it("QUEUED 与已取消任务原样恢复", async () => {
		const store = new MemoryTaskStore();
		const before = new TaskOrchestrator(factoryWith(scriptedRunner()), {
			store,
			now: () => 100,
		});

		await before.submit(submitFor("queued-1")); // QUEUED，不 run
		await before.submit(submitFor("cancel-1"));
		await before.cancel("cancel-1", "用户取消");

		const after = new TaskOrchestrator(factoryWith(scriptedRunner()), {
			store,
			now: () => 200,
		});
		after.recover();

		expect(after.get("queued-1")?.status).toBe(TaskStatus.Queued);
		expect(after.get("cancel-1")?.status).toBe(TaskStatus.Cancelled);
		expect(after.get("cancel-1")?.reason).toBe("用户取消");
	});

	it("重启后事件历史可按 seq 断线重连", async () => {
		const store = new MemoryTaskStore();
		const before = new TaskOrchestrator(factoryWith(scriptedRunner()), {
			store,
			now: () => 100,
		});
		await before.submit(submitFor("evt-1"));
		const total = before.events("evt-1").length;

		const after = new TaskOrchestrator(factoryWith(scriptedRunner()), {
			store,
			now: () => 200,
		});
		after.recover();

		const replayed = after.events("evt-1");
		expect(replayed).toHaveLength(total);
		const seqs = replayed.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
	});

	it("未配置存储时 recover 为空操作（纯内存编排器）", () => {
		const orch = new TaskOrchestrator(factoryWith(scriptedRunner()));
		expect(orch.recover()).toEqual([]);
	});

	it("Runner 产出的 artifact 在重启后保留", async () => {
		const store = new MemoryTaskStore();
		const runner = scriptedRunner();
		// 进入后立即发产物事件，然后永不返回 —— 进程死时任务仍在 RUNNING
		runner.setScript((emit) => {
			emit({
				type: "artifact",
				artifactId: "report.xlsx",
				name: "对账报告.xlsx",
				mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				sizeBytes: 10,
				final: true,
			});
			return new Promise<void>(() => {});
		});
		const before = new TaskOrchestrator(factoryWith(runner), { store, now: () => 100 });
		await before.submit(submitFor("art-1"));
		void before.run("art-1", "核对");
		await runner.entered;
		await flush(); // 等 artifact 事件走完 fanout 与持久化
		expect(before.get("art-1")?.artifacts).toEqual(["report.xlsx"]);

		const after = new TaskOrchestrator(factoryWith(scriptedRunner()), {
			store,
			now: () => 200,
		});
		after.recover();
		// RUNNING → INTERRUPTED，但中间产物保留
		expect(after.get("art-1")?.status).toBe(TaskStatus.Interrupted);
		expect(after.get("art-1")?.artifacts).toEqual(["report.xlsx"]);
	});
});
