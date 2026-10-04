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
	type TaskChange,
	type TaskEvent,
	type TaskStore,
	type TenantContext,
} from "@tao/core";
import { describe, expect, it, vi } from "vitest";
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

	it("QUEUED 重启中断，已取消任务保持终态", async () => {
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

		expect(after.get("queued-1")?.status).toBe(TaskStatus.Interrupted);
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
		expect(replayed).toHaveLength(total + 1);
        expect(replayed.at(-1)).toMatchObject({ type: "status", to: TaskStatus.Interrupted });
		const seqs = replayed.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
	});

	it("未配置存储时 recover 为空操作（纯内存编排器）", () => {
		const orch = new TaskOrchestrator(factoryWith(scriptedRunner()));
		expect(orch.recover()).toEqual([]);
	});

	it("恢复 RUNNING 时事件流补上 RUNNING→INTERRUPTED 事件且游标推进", async () => {
		const store = new MemoryTaskStore();
		const runner = scriptedRunner();
		runner.setScript(() => new Promise<void>(() => {}));
		const before = new TaskOrchestrator(factoryWith(runner), { store, now: () => 100 });
		await before.submit(submitFor("running-evt"));
		void before.run("running-evt", "核对");
		await runner.entered;
		const beforeEvents = before.events("running-evt");
		const maxBefore = Math.max(...beforeEvents.map((e) => e.seq));

		const after = new TaskOrchestrator(factoryWith(scriptedRunner()), {
			store,
			now: () => 200,
		});
		after.recover();

		const replayed = after.events("running-evt");
		const last = replayed[replayed.length - 1];
		expect(last?.type).toBe("status");
		expect(last?.type === "status" ? last.to : "").toBe(TaskStatus.Interrupted);
		expect(last?.type === "status" ? last.from : "").toBe(TaskStatus.Running);
		// 事件序号 = 恢复前最大序号 + 1，即游标确已推进
		expect(last?.seq).toBe(maxBefore + 1);

		// 恢复后继续产生事件时序号不复用：再用一个「新 Runner 事件」验证单调。
		// 这里直接验游标：下一个提交的任务序号从 1 开始不相关，改为断言
		// 事件流内 seq 唯一且严格递增
		const seqs = replayed.map((e) => e.seq);
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
	});

	it("createRunner 失败时任务以 FAILED 终态持久化，不留 QUEUED 僵尸", async () => {
		const store = new MemoryTaskStore();
		const failingFactory: RunnerFactory = {
			createRunner: async () => {
				throw new Error("模型会话初始化失败：额度不足");
			},
		};
		const orch = new TaskOrchestrator(failingFactory, { store, now: () => 100 });

		await expect(orch.submit(submitFor("zombie-1"))).rejects.toThrow(/额度不足/);

		// 内存态：FAILED 且带可读原因，runners 中无执行器
		const rec = orch.get("zombie-1");
		expect(rec?.status).toBe(TaskStatus.Failed);
		expect(rec?.reason).toContain("额度不足");

		// 存储态：同样是 FAILED，重启恢复不会复活成 QUEUED
		expect(store.get("zombie-1")?.status).toBe(TaskStatus.Failed);
		const after = new TaskOrchestrator(factoryWith(scriptedRunner()), {
			store,
			now: () => 200,
		});
		expect(after.recover()).toEqual([]);
		expect(after.get("zombie-1")?.status).toBe(TaskStatus.Failed);
	});

	it("事件落盘抛错时：回调不冒泡、fanout 与 await_confirm 转换继续、onPersistenceError 被调用", async () => {
		// 包一层内存存储：变更落盘正常（状态机迁移不受影响），仅事件流落盘抛错，
		// 模拟磁盘满导致的 appendEvent 失败
		const inner = new MemoryTaskStore();
		const failingStore: TaskStore = {
			create: (c: TaskChange) => inner.create(c),
			appendChange: (c: TaskChange) => inner.appendChange(c),
			appendEvent: () => {
				throw new Error("磁盘已满");
			},
			get: (id: string) => inner.get(id),
			listByTenant: (t: string, w: string) => inner.listByTenant(t, w),
			listAll: () => inner.listAll(),
			events: (id: string, after?: number) => inner.events(id, after),
			maxChangeSeq: (id: string) => inner.maxChangeSeq(id),
		};
		const onPersistenceError = vi.fn();
		const runner = scriptedRunner();
		runner.setScript((emit) => {
			emit({
				type: "tool_decision",
				toolName: "delete",
				decision: "await_confirm",
				reason: "将删除文件，请确认",
			});
		});
		const orch = new TaskOrchestrator(factoryWith(runner), {
			store: failingStore,
			now: () => 100,
			onPersistenceError,
		});
		const fannedOut: TaskEvent[] = [];
		orch.subscribe((e) => void fannedOut.push(e));

		await orch.submit(submitFor("disk-full"));
		const record = await orch.run("disk-full", "删除文件");

		// fanout 仍收到事件（含 await_confirm 决策与状态事件）
		expect(fannedOut.some((e) => e.type === "tool_decision")).toBe(true);
		// await_confirm 派生状态转换照常发生
		expect(record.status).toBe(TaskStatus.AwaitConfirm);
		// 持久化失败被显式上报而非被 Runner 的 publish 吞掉
		expect(onPersistenceError.mock.calls.length).toBeGreaterThan(0);
		expect(onPersistenceError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
		expect(onPersistenceError.mock.calls[0]?.[1]).toBe("disk-full");
	});

	it("状态机关键迁移落盘失败时任务进入可诊断的 FAILED", async () => {
		const inner = new MemoryTaskStore();
		// create 成功（提交成功），但之后的 appendChange 全部抛错；事件流正常
		const failingStore: TaskStore = {
			create: (c: TaskChange) => inner.create(c),
			appendChange: () => {
				throw new Error("只读文件系统");
			},
			appendEvent: (e: TaskEvent) => inner.appendEvent(e),
			get: (id: string) => inner.get(id),
			listByTenant: (t: string, w: string) => inner.listByTenant(t, w),
			listAll: () => inner.listAll(),
			events: (id: string, after?: number) => inner.events(id, after),
			maxChangeSeq: (id: string) => inner.maxChangeSeq(id),
		};
		const onPersistenceError = vi.fn();
		const { runner } = (() => {
			const r = scriptedRunner();
			r.setScript(() => {}); // prompt 正常返回，随后尝试 QUEUED→RUNNING→SUCCEEDED
			return { runner: r };
		})();
		const orch = new TaskOrchestrator(factoryWith(runner), {
			store: failingStore,
			now: () => 100,
			onPersistenceError,
		});

		await orch.submit(submitFor("crit-fail"));
		// RUNNING 关键迁移落盘失败 → run 的 promise 被拒绝（调用方可感知），
		// 同时任务已被改写为带诊断原因的 FAILED
		await expect(orch.run("crit-fail", "核对")).rejects.toThrow(/只读文件系统/);

		const record = orch.get("crit-fail");
		expect(record?.status).toBe(TaskStatus.Failed);
		expect(record?.reason).toContain("落盘失败");
		expect(onPersistenceError.mock.calls.length).toBeGreaterThan(0);
	});

	it("告警回调自身抛错时：ingest 不抛、fanout 与 await_confirm 转换仍发生", async () => {
		// 事件流落盘失败，且注入的 onPersistenceError 自己也抛错。
		// 若告警异常未隔离，它会从 ingest 的 catch 冒泡、被 Runner 的 publish
		// 吞掉，后续 fanout 与 AWAIT_CONFIRM 派生转换全部被跳过。
		const inner = new MemoryTaskStore();
		const failingStore: TaskStore = {
			create: (c: TaskChange) => inner.create(c),
			appendChange: (c: TaskChange) => inner.appendChange(c),
			appendEvent: () => {
				throw new Error("磁盘已满");
			},
			get: (id: string) => inner.get(id),
			listByTenant: (t: string, w: string) => inner.listByTenant(t, w),
			listAll: () => inner.listAll(),
			events: (id: string, after?: number) => inner.events(id, after),
			maxChangeSeq: (id: string) => inner.maxChangeSeq(id),
		};
		const explodingAlert = vi.fn(() => {
			throw new Error("告警器自己炸了");
		});
		const runner = scriptedRunner();
		runner.setScript((emit) => {
			emit({
				type: "tool_decision",
				toolName: "delete",
				decision: "await_confirm",
				reason: "将删除文件，请确认",
			});
		});
		const orch = new TaskOrchestrator(factoryWith(runner), {
			store: failingStore,
			now: () => 100,
			onPersistenceError: explodingAlert,
		});
		const fannedOut: TaskEvent[] = [];
		orch.subscribe((e) => void fannedOut.push(e));

		await orch.submit(submitFor("alert-boom"));
		// 关键：run 不因告警器抛错而 reject
		const record = await orch.run("alert-boom", "删除文件");

		expect(explodingAlert.mock.calls.length).toBeGreaterThan(0);
		expect(fannedOut.some((e) => e.type === "tool_decision")).toBe(true);
		expect(record.status).toBe(TaskStatus.AwaitConfirm);
	});

	it("事件流缺号但变更流已占用更大 seq 时，恢复补的 INTERRUPTED 不复用序号", () => {
		// 直接构造持久化现场（appendEvent 对 seq=4 落盘失败后的状态）：
		// 变更流 seq=1..4（seq4 是 artifact 变更，状态保持 RUNNING），
		// 事件流只有 seq=1..3（seq4 事件已实时发给客户端但落盘失败）。
		const store = new MemoryTaskStore();
		store.create({
			taskId: "gap-1",
			tenant: TENANT,
			sessionId: "session-1",
			seq: 1,
			at: 100,
			from: null,
			to: TaskStatus.Queued,
		});
		store.appendChange({
			taskId: "gap-1",
			tenant: TENANT,
			sessionId: "session-1",
			seq: 2,
			at: 200,
			from: TaskStatus.Queued,
			to: TaskStatus.Running,
		});
		store.appendChange({
			taskId: "gap-1",
			tenant: TENANT,
			sessionId: "session-1",
			seq: 4,
			at: 400,
			from: TaskStatus.Running,
			to: TaskStatus.Running,
			artifacts: ["report.xlsx"],
		});
		const events1to3: TaskEvent[] = [
			{
				eventId: "gap-1-1",
				taskId: "gap-1",
				tenant: TENANT,
				at: 100,
				seq: 1,
				type: "status",
				from: null,
				to: TaskStatus.Queued,
			},
			{
				eventId: "gap-1-2",
				taskId: "gap-1",
				tenant: TENANT,
				at: 200,
				seq: 2,
				type: "status",
				from: TaskStatus.Queued,
				to: TaskStatus.Running,
			},
			{
				eventId: "gap-1-3",
				taskId: "gap-1",
				tenant: TENANT,
				at: 300,
				seq: 3,
				type: "step",
				step: 1,
				action: "执行中",
				phase: "started",
			},
		];
		for (const e of events1to3) store.appendEvent(e);
		expect(store.maxChangeSeq("gap-1")).toBe(4);
		expect(Math.max(...store.events("gap-1").map((e) => e.seq))).toBe(3);

		const after = new TaskOrchestrator(factoryWith(scriptedRunner()), {
			store,
			now: () => 500,
		});
		const interrupted = after.recover();
		expect(interrupted).toEqual(["gap-1"]);

		const replayed = after.events("gap-1");
		const last = replayed[replayed.length - 1];
		expect(last?.type === "status" ? last.to : "").toBe(TaskStatus.Interrupted);
		// 必须从「真正已分配过的最大 seq（变更流 4）+ 1」起号，即 5 而非 4
		expect(last?.seq).toBe(5);

		// Last-Event-ID=3 的重连：缺号的 4 无法补造，但 seq=5 必须能收到
		expect(after.events("gap-1", 3).map((e) => e.seq)).toEqual([5]);

		// 事件流序号唯一（1,2,3,5，不复用缺掉的 4）；变更流补上 seq=5
		// （1,2,4,5），两条流内部均无重复序号
		const eventSeqs = store.events("gap-1").map((e) => e.seq);
		expect(eventSeqs).toEqual([1, 2, 3, 5]);
		expect(new Set(eventSeqs).size).toBe(eventSeqs.length);
		expect(store.maxChangeSeq("gap-1")).toBe(5);
		expect(store.get("gap-1")?.status).toBe(TaskStatus.Interrupted);
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
