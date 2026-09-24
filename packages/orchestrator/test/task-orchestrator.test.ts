/**
 * 任务编排测试
 *
 * 用假 Runner，因为这里验的是**编排逻辑**（状态机、事件流、租户隔离），
 * 不是内核集成 —— 后者由 agent-host 的测试覆盖。分开测能让失败定位更准。
 */

import {
	TaskStatus,
	type Runner,
	type RunnerFactory,
	type RunnerSpec,
	type TaskEvent,
	type TenantContext,
} from "@tao/core";
import { describe, expect, it, vi } from "vitest";
import { IllegalTransition, TaskOrchestrator } from "../src/task-orchestrator.ts";

const TENANT: TenantContext = { tenantId: "t1", workspaceId: "w1", userId: "u1" };
const OTHER_TENANT: TenantContext = { tenantId: "t2", workspaceId: "w2", userId: "u2" };

/** 一个可编程的假 Runner。 */
function fakeRunner(behavior: {
	onPrompt?: (emit: (event: TaskEvent) => void) => Promise<void> | void;
} = {}) {
	const listeners = new Set<(e: TaskEvent) => void | Promise<void>>();
	let seq = 0;
	const calls = { prompt: 0, steer: 0, abort: 0, close: 0 };

	const emit = (partial: Partial<TaskEvent> & { type: TaskEvent["type"] }): void => {
		seq += 1;
		const event = {
			eventId: `fake-${seq}`,
			seq: 1000 + seq, // 与编排器自身的 status 事件序号错开
			taskId: "task-1",
			tenant: TENANT,
			at: seq,
			...partial,
		} as TaskEvent;
		for (const l of listeners) void l(event);
	};

	const runner: Runner = {
		sessionId: "session-1",
		async prompt() {
			calls.prompt += 1;
			await behavior.onPrompt?.(emit as (e: TaskEvent) => void);
		},
		async steer() {
			calls.steer += 1;
		},
		async abort() {
			calls.abort += 1;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async close() {
			calls.close += 1;
		},
	};

	return { runner, calls, emit };
}

function factoryOf(runner: Runner): RunnerFactory {
	return { createRunner: async (_spec: RunnerSpec) => runner };
}

const baseSubmit = {
	tenant: TENANT,
	taskId: "task-1",
	sessionId: "session-1",
	prompt: "核对两张表",
	systemPrompt: "你是对账助手",
	tools: [],
	gate: () => ({ kind: "allow" as const }),
};

describe("任务编排 · 提交与执行", () => {
	it("提交后立即进入 QUEUED 并返回记录（不等执行完成）", async () => {
		// 这是「执行中可继续对话」的前提：提交即刻返回
		const { runner } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner), { now: () => 100 });

		const record = await orch.submit(baseSubmit);
		expect(record.status).toBe(TaskStatus.Queued);
		expect(record.taskId).toBe("task-1");
		expect(record.artifacts).toEqual([]);
	});

	it("执行成功后进入 SUCCEEDED", async () => {
		const { runner, calls } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		const record = await orch.run("task-1", "核对");

		expect(calls.prompt).toBe(1);
		expect(record.status).toBe(TaskStatus.Succeeded);
	});

	it("执行抛异常时进入 FAILED 并保留可读原因", async () => {
		const { runner } = fakeRunner({
			onPrompt: () => {
				throw new Error("读取文件失败：文件已损坏");
			},
		});
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		const record = await orch.run("task-1", "核对");

		expect(record.status).toBe(TaskStatus.Failed);
		expect(record.reason).toBe("读取文件失败：文件已损坏");
	});

	it("失败时保留已产出的中间物（验收要求）", async () => {
		const { runner } = fakeRunner({
			onPrompt: (emit) => {
				// 先产出一个中间物，再失败
				emit({
					type: "artifact",
					artifactId: "中间结果.xlsx",
					name: "中间结果.xlsx",
					mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
					sizeBytes: 1024,
					final: false,
				} as TaskEvent);
				throw new Error("后续步骤失败");
			},
		});
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		const record = await orch.run("task-1", "核对");

		expect(record.status).toBe(TaskStatus.Failed);
		// 中间物不能因为失败就丢掉 —— 用户可能还用得上
		expect(record.artifacts).toEqual(["中间结果.xlsx"]);
	});

	it("重复提交同一 taskId 报错", async () => {
		const { runner } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		await expect(orch.submit(baseSubmit)).rejects.toThrow(/已存在/);
	});
});

describe("任务编排 · 状态机守卫", () => {
	it("非法迁移抛 IllegalTransition 而非静默忽略", async () => {
		// 静默忽略会让「已完成任务被重复结算」这类 bug 潜伏很久
		const { runner } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		await orch.run("task-1", "x"); // → SUCCEEDED

		// 已成功的任务不能再被取消
		await expect(orch.cancel("task-1", "试图取消")).rejects.toThrow(IllegalTransition);
	});

	it("同状态迁移是幂等的，不报错", async () => {
		const { runner } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		await orch.cancel("task-1", "取消");
		// 重复取消不应抛错 —— 用户可能连点两次
		await expect(orch.cancel("task-1", "再取消")).resolves.toMatchObject({
			status: TaskStatus.Cancelled,
		});
	});

	it("QUEUED 状态可直接取消（还没开始执行）", async () => {
		const { runner, calls } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		const record = await orch.cancel("task-1", "用户放弃");

		expect(record.status).toBe(TaskStatus.Cancelled);
		expect(record.reason).toBe("用户放弃");
		expect(calls.abort).toBe(1);
	});

	it("权限门要求确认时任务转入 AWAIT_CONFIRM", async () => {
		const { runner } = fakeRunner({
			onPrompt: (emit) => {
				emit({
					type: "tool_decision",
					toolName: "send_email",
					decision: "await_confirm",
					reason: "将向外部发送，请确认",
				} as TaskEvent);
			},
		});
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		const record = await orch.run("task-1", "发邮件");

		// 不能因为 prompt 返回了就判成功 —— 任务还在等用户决定
		expect(record.status).toBe(TaskStatus.AwaitConfirm);
		expect(record.reason).toContain("请确认");
	});

	it("确认后可回到 RUNNING，拒绝则取消", async () => {
		const { runner } = fakeRunner({
			onPrompt: (emit) => {
				emit({
					type: "tool_decision",
					toolName: "delete",
					decision: "await_confirm",
					reason: "将删除文件",
				} as TaskEvent);
			},
		});
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		await orch.run("task-1", "删除");

		expect((await orch.confirm("task-1")).status).toBe(TaskStatus.Running);

		// 另一个任务走拒绝路径
		const second = fakeRunner({
			onPrompt: (emit) => {
				emit({
					type: "tool_decision",
					toolName: "delete",
					decision: "await_confirm",
					reason: "将删除文件",
				} as TaskEvent);
			},
		});
		const orch2 = new TaskOrchestrator(factoryOf(second.runner));
		await orch2.submit({ ...baseSubmit, taskId: "task-2" });
		await orch2.run("task-2", "删除");
		const rejected = await orch2.reject("task-2", "用户拒绝该操作");
		expect(rejected.status).toBe(TaskStatus.Cancelled);
		expect(rejected.reason).toBe("用户拒绝该操作");
	});
});

describe("任务编排 · 事件流", () => {
	it("状态变更产生事件，含 from/to", async () => {
		const { runner } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		const events: TaskEvent[] = [];
		orch.subscribe((e) => void events.push(e));

		await orch.submit(baseSubmit);
		await orch.run("task-1", "x");

		const statuses = events.filter((e) => e.type === "status");
		expect(statuses.map((e) => (e.type === "status" ? e.to : ""))).toEqual([
			TaskStatus.Queued,
			TaskStatus.Running,
			TaskStatus.Succeeded,
		]);
		// 第一次变更的 from 是 null（任务刚创建）
		expect(statuses[0]?.type === "status" ? statuses[0].from : "x").toBeNull();
		expect(statuses[1]?.type === "status" ? statuses[1].from : "").toBe(TaskStatus.Queued);
	});

	it("事件可按 seq 拉增量（断线重连）", async () => {
		const { runner } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		await orch.run("task-1", "x");

		const all = orch.events("task-1");
		expect(all.length).toBeGreaterThan(0);

		// 模拟前端已收到前 1 条，重连后只要后续
		const incremental = orch.events("task-1", all[0]?.seq ?? 0);
		expect(incremental.length).toBe(all.length - 1);
		expect(incremental.every((e) => e.seq > (all[0]?.seq ?? 0))).toBe(true);
	});

	it("Runner 的事件被转投给编排器订阅者", async () => {
		const { runner } = fakeRunner({
			onPrompt: (emit) => {
				emit({ type: "step", step: 1, action: "读取表格", phase: "started" } as TaskEvent);
				emit({ type: "step", step: 1, action: "读取表格", phase: "finished" } as TaskEvent);
			},
		});
		const orch = new TaskOrchestrator(factoryOf(runner));
		const steps: string[] = [];
		orch.subscribe((e) => {
			if (e.type === "step") steps.push(`${e.action}:${e.phase}`);
		});

		await orch.submit(baseSubmit);
		await orch.run("task-1", "x");

		expect(steps).toEqual(["读取表格:started", "读取表格:finished"]);
	});

	it("订阅者抛异常不影响任务执行与其他订阅者", async () => {
		// 一个前端 bug 不该让所有任务挂掉
		const { runner } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		orch.subscribe(() => {
			throw new Error("订阅者坏了");
		});
		const received: TaskEvent[] = [];
		orch.subscribe((e) => void received.push(e));

		await orch.submit(baseSubmit);
		const record = await orch.run("task-1", "x");

		expect(record.status).toBe(TaskStatus.Succeeded);
		expect(received.length).toBeGreaterThan(0);
	});
});

describe("任务编排 · 执行中可继续对话", () => {
	it("steer 转发给 Runner", async () => {
		const { runner, calls } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		await orch.steer("task-1", "顺便看另一件事");

		expect(calls.steer).toBe(1);
	});

	it("提交后立即 steer 不报错（任务还在 QUEUED）", async () => {
		// 真实场景：用户提交任务后马上又想补一句
		const { runner, calls } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		await expect(orch.steer("task-1", "补充说明")).resolves.toBeUndefined();
		expect(calls.steer).toBe(1);
	});
});

describe("任务编排 · 租户隔离", () => {
	it("list 只返回本租户本工作区的任务", async () => {
		const { runner } = fakeRunner();
		const orch = new TaskOrchestrator({
			createRunner: async () => runner,
		});

		await orch.submit({ ...baseSubmit, taskId: "mine" });
		await orch.submit({ ...baseSubmit, taskId: "theirs", tenant: OTHER_TENANT });

		const mine = orch.list(TENANT);
		expect(mine.map((t) => t.taskId)).toEqual(["mine"]);

		const theirs = orch.list(OTHER_TENANT);
		expect(theirs.map((t) => t.taskId)).toEqual(["theirs"]);
	});

	it("每条事件都带完整租户上下文", async () => {
		const { runner } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		const events: TaskEvent[] = [];
		orch.subscribe((e) => void events.push(e));

		await orch.submit(baseSubmit);
		await orch.run("task-1", "x");

		expect(events.length).toBeGreaterThan(0);
		for (const event of events) {
			expect(event.tenant.tenantId).toBe(TENANT.tenantId);
			expect(event.tenant.workspaceId).toBe(TENANT.workspaceId);
		}
	});
});

describe("任务编排 · 资源释放", () => {
	it("close 释放 Runner", async () => {
		const { runner, calls } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		await orch.submit(baseSubmit);
		await orch.close("task-1");

		expect(calls.close).toBe(1);
	});

	it("对未知任务的操作报可读错误", async () => {
		const { runner } = fakeRunner();
		const orch = new TaskOrchestrator(factoryOf(runner));
		await expect(orch.run("不存在", "x")).rejects.toThrow(/不存在/);
		await expect(orch.steer("不存在", "x")).rejects.toThrow(/不存在/);
		expect(orch.get("不存在")).toBeUndefined();
	});
});
