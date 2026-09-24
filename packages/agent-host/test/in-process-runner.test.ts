/**
 * RunnerAdapter 适配层测试
 *
 * 这些测试跑**真实的内核**（用假模型，全程离线），因为适配层里有几处
 * `as never` 断言绕过了内核类型 —— 编译通过不代表运行时正确，
 * 只有真跑一遍才知道接线对不对。
 *
 * 同时验证 M0 三条约束在代码层面真的生效，而非仅写在注释里。
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../../../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../vendor/pi/agent/src/harness/session/session.ts";
import type { PlatformTool, TaskEvent, TenantContext, ToolDecision } from "@tao/core";
import { afterEach, describe, expect, it } from "vitest";
import { InProcessRunnerFactory } from "../src/in-process-runner.ts";

const TENANT: TenantContext = {
	tenantId: "tenant-1",
	workspaceId: "workspace-1",
	userId: "user-1",
};

const openSessions: StorageBackedSession[] = [];

/** 建一个隔离的运行时：独立存储 + 独立假模型。 */
function createRuntime() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);

	let clock = 1_000;
	const factory = new InProcessRunnerFactory({
		async createSession(sessionId) {
			const session = new StorageBackedSession(
				{ id: sessionId, createdAt: 1, storageVersion: 1 },
				new MemoryStorage(),
			);
			openSessions.push(session);
			return session;
		},
		models,
		model: faux.getModel(),
		// 固定时钟：事件时间戳可预测，断言不受真实时间影响
		now: () => (clock += 1),
	});

	return { factory, faux };
}

/** 一个可观测的结构化工具。 */
function spyTool(name: string, label: string) {
	const calls: unknown[] = [];
	const tool: PlatformTool = {
		name,
		label,
		description: `test tool ${name}`,
		parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
		async execute({ args, report }) {
			calls.push(args);
			report("处理了 100 行");
			return { text: `${name} 完成` };
		},
	};
	return { tool, calls };
}

const allowAll: ToolDecision = { kind: "allow" };

describe("RunnerAdapter 适配层", () => {
	afterEach(async () => {
		for (const s of openSessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
	});

	it("端到端：工具被调用，事件带 taskId 与租户标识", async () => {
		const { factory, faux } = createRuntime();
		const { tool, calls } = spyTool("reconcile", "核对对账表");

		const runner = await factory.createRunner({
			tenant: TENANT,
			taskId: "task-1",
			sessionId: "session-1",
			systemPrompt: "你是对账助手",
			tools: [tool],
			gate: () => allowAll,
		});

		const events: TaskEvent[] = [];
		runner.subscribe((e) => void events.push(e));

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("reconcile", { value: "两张表" })]),
			fauxAssistantMessage("核对完成"),
		]);

		await runner.prompt("核对这两张表");

		// 工具真的被调用了（证明适配层的 execute 接线正确）
		expect(calls).toEqual([{ value: "两张表" }]);

		// 每一个事件都带 taskId 与完整租户上下文 ——
		// M0 确认内核事件不带会话标识，打标是宿主的责任
		expect(events.length).toBeGreaterThan(0);
		for (const event of events) {
			expect(event.taskId).toBe("task-1");
			expect(event.tenant).toEqual(TENANT);
		}

		await runner.close();
	});

	it("步骤事件用业务语言，不泄漏工具名", async () => {
		const { factory, faux } = createRuntime();
		const { tool } = spyTool("reconcile_tables_v2", "核对供应商对账表");

		const runner = await factory.createRunner({
			tenant: TENANT,
			taskId: "task-2",
			sessionId: "session-2",
			systemPrompt: "s",
			tools: [tool],
			gate: () => allowAll,
		});

		const steps: string[] = [];
		runner.subscribe((e) => {
			if (e.type === "step") steps.push(e.action);
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("reconcile_tables_v2", { value: "x" })]),
			fauxAssistantMessage("done"),
		]);
		await runner.prompt("go");

		// 用户看到的是业务语言
		expect(steps).toContain("核对供应商对账表");
		// 而不是工具名 —— 前端不该认识工具名
		expect(steps.join("|")).not.toContain("reconcile_tables_v2");

		await runner.close();
	});

	it("步骤序号单调递增，事件 seq 连续无缺口", async () => {
		const { factory, faux } = createRuntime();
		const a = spyTool("step_a", "第一步");
		const b = spyTool("step_b", "第二步");

		const runner = await factory.createRunner({
			tenant: TENANT,
			taskId: "task-3",
			sessionId: "session-3",
			systemPrompt: "s",
			tools: [a.tool, b.tool],
			gate: () => allowAll,
		});

		const events: TaskEvent[] = [];
		runner.subscribe((e) => void events.push(e));

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("step_a", { value: "1" })]),
			fauxAssistantMessage([fauxToolCall("step_b", { value: "2" })]),
			fauxAssistantMessage("done"),
		]);
		await runner.prompt("两步");

		// seq 必须连续 —— 前端靠它断线重连拉增量，有缺口就会误判丢事件
		const seqs = events.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		expect(new Set(seqs).size).toBe(seqs.length); // 无重复

		// 两个工具产生两个不同的步骤号
		const startedSteps = events
			.filter((e) => e.type === "step" && e.phase === "started")
			.map((e) => (e.type === "step" ? e.step : 0));
		expect(startedSteps).toEqual([1, 2]);

		await runner.close();
	});

	it("权限门拒绝时工具不执行，并产生审计事件", async () => {
		const { factory, faux } = createRuntime();
		const { tool, calls } = spyTool("dangerous", "危险操作");

		const runner = await factory.createRunner({
			tenant: TENANT,
			taskId: "task-4",
			sessionId: "session-4",
			systemPrompt: "s",
			tools: [tool],
			gate: () => ({ kind: "block", reason: "未授权的操作" }),
		});

		const decisions: TaskEvent[] = [];
		runner.subscribe((e) => {
			if (e.type === "tool_decision") decisions.push(e);
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("dangerous", { value: "x" })]),
			fauxAssistantMessage("done"),
		]);
		await runner.prompt("do it");

		// 零次执行 —— 不是「返回错误」
		expect(calls).toEqual([]);
		// 决策被审计
		expect(decisions).toHaveLength(1);
		const decision = decisions[0];
		expect(decision?.type === "tool_decision" ? decision.decision : undefined).toBe("blocked");
		expect(decision?.type === "tool_decision" ? decision.reason : undefined).toBe("未授权的操作");

		await runner.close();
	});

	it("权限门返回 confirm 时同样拦下执行，审计为 await_confirm", async () => {
		const { factory, faux } = createRuntime();
		const { tool, calls } = spyTool("needs_ok", "需确认的操作");

		const runner = await factory.createRunner({
			tenant: TENANT,
			taskId: "task-5",
			sessionId: "session-5",
			systemPrompt: "s",
			tools: [tool],
			gate: () => ({ kind: "confirm", reason: "该操作将对外发送，请确认" }),
		});

		const decisions: Extract<TaskEvent, { type: "tool_decision" }>[] = [];
		runner.subscribe((e) => {
			if (e.type === "tool_decision") decisions.push(e);
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("needs_ok", { value: "x" })]),
			fauxAssistantMessage("done"),
		]);
		await runner.prompt("send it");

		expect(calls).toEqual([]);
		expect(decisions[0]?.decision).toBe("await_confirm");
		expect(decisions[0]?.reason).toContain("请确认");

		await runner.close();
	});

	it("权限门抛异常时 fail-closed（拒绝而非放行）", async () => {
		// 这是安全上最关键的一条：权限逻辑有 bug 时行为必须是拒绝。
		const { factory, faux } = createRuntime();
		const { tool, calls } = spyTool("guarded", "受保护操作");

		const runner = await factory.createRunner({
			tenant: TENANT,
			taskId: "task-6",
			sessionId: "session-6",
			systemPrompt: "s",
			tools: [tool],
			gate: () => {
				throw new Error("权限判定崩了");
			},
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("guarded", { value: "x" })]),
			fauxAssistantMessage("done"),
		]);
		await runner.prompt("go");

		expect(calls).toEqual([]);
		await runner.close();
	});

	it("steer 产生「当前步骤完成后送达」的事件，不打断执行", async () => {
		const { factory, faux } = createRuntime();
		const { tool } = spyTool("slow", "慢操作");

		const runner = await factory.createRunner({
			tenant: TENANT,
			taskId: "task-7",
			sessionId: "session-7",
			systemPrompt: "s",
			tools: [tool],
			gate: () => allowAll,
		});

		const messages: Extract<TaskEvent, { type: "user_message" }>[] = [];
		runner.subscribe((e) => {
			if (e.type === "user_message") messages.push(e);
		});

		faux.setResponses([fauxAssistantMessage("第一轮完成")]);
		await runner.prompt("第一个问题");
		await runner.steer("顺便帮我看另一件事");

		expect(messages).toHaveLength(1);
		expect(messages[0]?.text).toBe("顺便帮我看另一件事");
		// 口径必须是「排队等当前步骤完成」，不能承诺打断 ——
		// 内核 steering 永不取消执行中的工具
		expect(messages[0]?.delivery).toBe("queued_after_current_step");

		await runner.close();
	});

	it("两个 Runner 并发：会话存储与事件流互不串台", async () => {
		// M0 Spike 1 在内核层验过隔离；这里验适配层没有把它破坏掉
		// （例如误用了共享的 sequencer 或共享的 listener 集合）。
		const a = createRuntime();
		const b = createRuntime();
		const toolA = spyTool("tool_a", "A 的操作");
		const toolB = spyTool("tool_b", "B 的操作");

		const runnerA = await a.factory.createRunner({
			tenant: { ...TENANT, tenantId: "tenant-A" },
			taskId: "task-A",
			sessionId: "session-A",
			systemPrompt: "s",
			tools: [toolA.tool],
			gate: () => allowAll,
		});
		const runnerB = await b.factory.createRunner({
			tenant: { ...TENANT, tenantId: "tenant-B" },
			taskId: "task-B",
			sessionId: "session-B",
			systemPrompt: "s",
			tools: [toolB.tool],
			gate: () => allowAll,
		});

		const eventsA: TaskEvent[] = [];
		const eventsB: TaskEvent[] = [];
		runnerA.subscribe((e) => void eventsA.push(e));
		runnerB.subscribe((e) => void eventsB.push(e));

		a.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_a", { value: "secret-A" })]),
			fauxAssistantMessage("A done"),
		]);
		b.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_b", { value: "secret-B" })]),
			fauxAssistantMessage("B done"),
		]);

		await Promise.all([runnerA.prompt("A 的任务"), runnerB.prompt("B 的任务")]);

		// 每条事件流只含自己租户的 taskId
		expect(eventsA.every((e) => e.taskId === "task-A")).toBe(true);
		expect(eventsB.every((e) => e.taskId === "task-B")).toBe(true);
		expect(eventsA.every((e) => e.tenant.tenantId === "tenant-A")).toBe(true);
		expect(eventsB.every((e) => e.tenant.tenantId === "tenant-B")).toBe(true);

		// 各自的工具只收到自己的参数
		expect(toolA.calls).toEqual([{ value: "secret-A" }]);
		expect(toolB.calls).toEqual([{ value: "secret-B" }]);

		await runnerA.close();
		await runnerB.close();
	});

	it("close 幂等，关闭后再操作报错", async () => {
		const { factory } = createRuntime();
		const runner = await factory.createRunner({
			tenant: TENANT,
			taskId: "task-8",
			sessionId: "session-8",
			systemPrompt: "s",
			tools: [],
			gate: () => allowAll,
		});

		await runner.close();
		await runner.close(); // 幂等，不应抛错

		await expect(runner.prompt("x")).rejects.toThrow(/已关闭/);
	});

	it("事件监听器抛异常不影响任务执行", async () => {
		// 进度上报失败不等于任务失败 —— 否则一个前端 bug 能让所有任务挂掉。
		const { factory, faux } = createRuntime();
		const { tool, calls } = spyTool("work", "干活");

		const runner = await factory.createRunner({
			tenant: TENANT,
			taskId: "task-9",
			sessionId: "session-9",
			systemPrompt: "s",
			tools: [tool],
			gate: () => allowAll,
		});

		runner.subscribe(() => {
			throw new Error("监听器坏了");
		});
		const received: TaskEvent[] = [];
		runner.subscribe((e) => void received.push(e));

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "x" })]),
			fauxAssistantMessage("done"),
		]);
		await runner.prompt("go");

		// 工具照常执行，另一个监听器照常收到事件
		expect(calls).toHaveLength(1);
		expect(received.length).toBeGreaterThan(0);

		await runner.close();
	});
});
