import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RunnerSpec, StoredJob, TaskEvent, TenantContext } from "@tao/core";
import type { AppDeps } from "../src/app.ts";

const host = vi.hoisted(() => ({
	dir: "",
	deps: undefined as AppDeps | undefined,
	runners: [] as TestRunner[],
}));

// 替换模型与监听端口，保留真实入口装配、编排器和文件存储。
class TestRunner {
	readonly sessionId: string;
	readonly close = vi.fn(async () => {});
	readonly started = Promise.withResolvers<void>();
	private listener?: (event: TaskEvent) => void | Promise<void>;
	private pending = Promise.withResolvers<void>();
	private seq = 0;
	constructor(readonly spec: RunnerSpec) { this.sessionId = spec.sessionId; }
	subscribe(listener: (event: TaskEvent) => void | Promise<void>) {
		this.listener = listener;
		return () => { this.listener = undefined; };
	}
	async message(type: "user_message" | "assistant_message", text: string) {
		await this.listener?.({
			type, text, taskId: this.spec.taskId, tenant: this.spec.tenant,
			at: Date.now(), seq: ++this.seq, eventId: `${this.spec.taskId}-${this.seq}`,
			delivery: "queued_after_current_step",
		} as TaskEvent);
	}
	async prompt(_text: string, raw?: string) {
		if (raw) await this.message("user_message", raw);
		this.started.resolve();
		await this.pending.promise;
	}
	async steer(text: string) { await this.message("user_message", text); }
	async abort() { this.pending.resolve(); }
	finish() { this.pending.resolve(); }
	fail() { this.pending.reject(new Error("模拟执行失败")); }
	async awaitConfirmation() {
        const dir = join(host.dir, ".execution", "actions"); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, this.spec.taskId + ".json"), JSON.stringify({ actionId: this.spec.taskId, taskId: this.spec.taskId, tenant: this.spec.tenant, status: "pending", expiresAt: Date.now() + 60000 }));
		await this.listener?.({
			type: "tool_decision", toolName: "test_write", decision: "await_confirm",
			reason: "需要确认", taskId: this.spec.taskId, tenant: this.spec.tenant,
			at: Date.now(), seq: ++this.seq, eventId: `${this.spec.taskId}-${this.seq}`,
		});
	}
}

vi.mock("node:http", () => ({ createServer: () => ({ listen: vi.fn(), close: vi.fn() }) }));
vi.mock("../src/config.ts", () => ({
	loadConfig: () => ({ errors: [], config: { workspaceDir: host.dir, port: 8080, modelName: "test-model" } }),
	describeConfig: () => "",
	renderConfigErrors: () => "",
}));
vi.mock("../src/accounts.ts", async (original) => ({
	...await original<typeof import("../src/accounts.ts")>(),
	loadAccounts: () => ({ accounts: [] }), hasDefaultTokens: () => false,
}));
vi.mock("../src/app.ts", async (original) => ({
	...await original<typeof import("../src/app.ts")>(),
	createApp: (deps: AppDeps) => { host.deps = deps; return vi.fn(); },
}));
vi.mock("@tao/agent-host", async (original) => ({
 ...await original<typeof import("@tao/agent-host")>(),
	createModelRuntime: () => ({ models: {}, model: {} }),
	MemorySessionFactory: class { close = vi.fn(); },
	InProcessRunnerFactory: class {
		async createRunner(spec: RunnerSpec) {
			const runner = new TestRunner(spec);
			host.runners.push(runner);
			return runner;
		}
	},
}));

const tenant: TenantContext = { tenantId: "test-tenant", workspaceId: "office", userId: "member" };
let signalSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
	host.dir = mkdtempSync(join(tmpdir(), "tao-lifecycle-"));
	const originalOn = process.on.bind(process);
	signalSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: (...args: unknown[]) => void) =>
		event === "SIGTERM" || event === "SIGINT" ? process : originalOn(event, listener)) as typeof process.on);
	await import("../src/main.ts");
});
afterAll(() => {
	host.deps?.hub.closeAll();
	signalSpy?.mockRestore();
	rmSync(host.dir, { recursive: true, force: true });
});

async function submit(query: string, extra: { jobId?: string; conversationId?: string } = {}) {
	const result = await host.deps!.submitTask(tenant, {
		scenarioId: "general.free-task", fields: { query }, ...extra,
	});
	const runner = host.runners.find((r) => r.spec.taskId === result.taskId)!;
	await runner.started.promise;
	return { ...result, runner };
}

describe("生产入口的会话生命周期", () => {
	it("并发长程会话先后结束时，两份记忆都保留", async () => {
		const { jobId } = await host.deps!.createJob!(tenant, { title: "并发任务", goal: "汇总两个部门" });
		const first = await submit("部门甲", { jobId });
		const second = await submit("部门乙", { jobId });
		await first.runner.message("assistant_message", "部门甲的核对工作已经完成。");
		first.runner.finish();
		await vi.waitFor(() => expect(first.runner.close).toHaveBeenCalledOnce());
		await second.runner.message("assistant_message", "部门乙的核对工作已经完成。");
		second.runner.finish();
		await vi.waitFor(() => expect(second.runner.close).toHaveBeenCalledOnce());
		const job = host.deps!.getJob!(tenant, jobId) as StoredJob;
		expect(job.conversationIds).toEqual([first.conversationId, second.conversationId]);
		expect(job.memory.map((m) => m.summary)).toEqual([
			"部门甲的核对工作已经完成。", "部门乙的核对工作已经完成。",
		]);
	});

	it("续聊保留连续用户补充与工具前后回答", async () => {
		const first = await submit("核对台账");
		await first.runner.message("user_message", "请按部门合计");
		await first.runner.message("assistant_message", "开始核对");
		await first.runner.message("assistant_message", "核对完成，总计120元");
		first.runner.finish();
		await vi.waitFor(() => expect(first.runner.close).toHaveBeenCalledOnce());
		const next = await submit("刚才总额是多少？", { conversationId: first.conversationId });
		expect(next.runner.spec.history).toEqual([{
			user: "核对台账\n\n请按部门合计",
			assistant: "开始核对\n\n核对完成，总计120元",
		}]);
		next.runner.finish();
		await vi.waitFor(() => expect(next.runner.close).toHaveBeenCalledOnce());
	});

	it("失败和运行中取消都释放执行器", async () => {
		const failed = await submit("失败任务");
		failed.runner.fail();
		await vi.waitFor(() => expect(failed.runner.close).toHaveBeenCalledOnce());
		expect(host.deps!.getTask(tenant, failed.taskId)).toMatchObject({ status: "FAILED" });
		const cancelled = await submit("取消任务");
		await host.deps!.cancelTask(tenant, cancelled.taskId, "用户取消");
		await vi.waitFor(() => expect(cancelled.runner.close).toHaveBeenCalledOnce());
		expect(host.deps!.getTask(tenant, cancelled.taskId)).toMatchObject({ status: "CANCELLED" });
	});

	it("待确认时保留上下文，拒绝后释放", async () => {
		const task = await submit("需要审批的任务");
		await task.runner.awaitConfirmation();
		task.runner.finish();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(task.runner.close).not.toHaveBeenCalled();
		await host.deps!.rejectTask!(tenant, task.taskId, "用户拒绝");
		await vi.waitFor(() => expect(task.runner.close).toHaveBeenCalledOnce());
	});
});

describe("JSON 请求根值", () => {
	it.each(["null", "[]", "1", "true", '"text"'])("拒绝 %s", async (body) => {
		const { readJsonBody } = await import("../src/app.ts");
		const req = Readable.from([Buffer.from(body)]) as IncomingMessage;
		expect(await readJsonBody(req)).toEqual({ ok: false, reason: "请求体必须是 JSON 对象" });
	});
	it("兼容空请求体与空对象", async () => {
		const { readJsonBody } = await import("../src/app.ts");
		for (const body of ["", "{}"]) {
			const req = Readable.from([Buffer.from(body)]) as IncomingMessage;
			expect(await readJsonBody(req)).toEqual({ ok: true, value: {} });
		}
	});
});
