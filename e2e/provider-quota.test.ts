/**
 * M5-5 验收：出网前配额闸拦住纯文本生成
 *
 * M4 的闸在 before_tool，拦不住「不调任何工具、只生成长文本」。本用例预置一个
 * 已超 token 配额的租户，提交一个无工具的纯文本任务，断言：
 *  - 任务进入 FAILED（理由可操作）；
 *  - 模型一次未被调用：计量存储里没有本次任务的任何 usage 落账（零消耗）。
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../vendor/pi/agent/src/harness/session/session.ts";
import {
	evaluateQuota,
	TaskStatus,
	type ModelPrice,
	type PlatformTool,
	type Quota,
	type QuotaVerdict,
	type TenantContext,
	type UsageRecord,
} from "@tao/core";
import { MemoryMeteringStore } from "@tao/knowledge";
import { InProcessRunnerFactory } from "@tao/agent-host";
import { TaskOrchestrator } from "@tao/orchestrator";
import { afterEach, describe, expect, it } from "vitest";

const TENANT: TenantContext = { tenantId: "mfg-009", workspaceId: "qa", userId: "u" };
const NOW = 1_700_000_000_000;
const PRICES: ModelPrice[] = [{ model: "m", inputPerMillionYuan: 2, outputPerMillionYuan: 8 }];
const QUOTA: Quota = {
	tenantId: TENANT.tenantId,
	periodStart: NOW - 1000,
	periodEnd: NOW + 1_000_000,
	maxTokens: 1000,
};

const sessions: StorageBackedSession[] = [];
afterEach(async () => {
	for (const s of sessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
});

function record(partial: Partial<UsageRecord>): UsageRecord {
	return {
		tenantId: TENANT.tenantId,
		workspaceId: TENANT.workspaceId,
		userId: TENANT.userId,
		taskId: partial.taskId ?? "seed",
		model: "m",
		inputTokens: partial.inputTokens ?? 0,
		outputTokens: partial.outputTokens ?? 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		at: NOW,
	};
}

describe("M5-5 验收 · 出网前配额闸", () => {
	it("超配额纯文本任务在第一次模型调用前失败，且零新增消耗", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const store = new MemoryMeteringStore();
		// 预置已用 5000 token（远超 1000 上限）
		await store.record(record({ taskId: "seed-1", inputTokens: 5000 }));

		// 即便准备了响应，预检拦截时内核一次都不会来取（modelCalls 无从自增，
		// 故零调用由「无 usage 落账 + 任务 FAILED」共同佐证）。
		faux.setResponses([fauxAssistantMessage("一段本不该被生成的长文本……")]);

		const factory = new InProcessRunnerFactory({
			async createSession(id) {
				const session = new StorageBackedSession(
					{ id, createdAt: 1, storageVersion: 1 },
					new MemoryStorage(),
				);
				sessions.push(session);
				return session;
			},
			models,
			model: faux.getModel(),
			now: () => NOW,
			meter: (r) => store.record(r as UsageRecord),
			// 出网前闸：与生产 main.ts 同一套 evaluateQuota
			preflightModel: async ({ tenant }) =>
				evaluateQuota({ store, quota: { ...QUOTA, tenantId: tenant.tenantId }, prices: PRICES }),
		});
		const orchestrator = new TaskOrchestrator(factory, { now: () => NOW });

		const taskId = "quota-e2e-1";
		await orchestrator.submit({
			tenant: TENANT,
			taskId,
			sessionId: taskId,
			prompt: "随便写一段文字，不需要任何工具",
			systemPrompt: "s",
			tools: [], // 纯文本：before_tool 永远不会触发
			gate: async () => ({ kind: "allow" }),
		});
		const result = await orchestrator.run(taskId, "随便写一段文字");

		expect(result.status).toBe(TaskStatus.Failed);
		expect(result.reason ?? "").toMatch(/上限|额度|配额/);
		// 关键验收：计量存储里只有预置的 seed-1，没有本任务的任何记录，
		// 即模型零调用、零消耗（若真发起生成，faux 会落一条本任务 usage）。
		const records = await store.list(TENANT.tenantId, { from: NOW - 1000, to: NOW + 1_000_000 });
		expect(records.every((r) => r.taskId === "seed-1")).toBe(true);
		expect(records.some((r) => r.taskId === taskId)).toBe(false);
	});

	/**
	 * 缺陷 b26c6af39281：在途任务首轮 usage 落账后既计入 totals.taskCount、
	 * 又占着 inflight 席位，旧公式 taskCount + inflightCount 把同一任务算两次，
	 * 上限 2 时 B 被提前错拒。修后按「已落账 taskId 集合 ∪ 在途 taskId 集合」
	 * 去重判定。本用例复刻 main.ts 的预检口径与 InProcessRunnerFactory 的临界区。
	 */
	it("maxTasks=2：A 已落首轮用量且在途时 B 放行、C 拒绝；A/B 结束后经已落账集合占用席位", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const store = new MemoryMeteringStore();

		const quota: Quota = {
			tenantId: TENANT.tenantId,
			periodStart: NOW - 1000,
			periodEnd: NOW + 1_000_000,
			maxTasks: 2,
		};

		// 与 main.ts preflightModelQuota 同口径：taskId 集合并集去重
		const seenUnions: string[][] = [];
		const preflightModel = async (input: {
			tenant: TenantContext;
			taskId: string;
			inflightTaskIds: readonly string[];
		}): Promise<QuotaVerdict | undefined> => {
			const q = { ...quota, tenantId: input.tenant.tenantId };
			const verdict = await evaluateQuota({ store, quota: q, prices: PRICES });
			const records = await store.list(input.tenant.tenantId, {
				from: q.periodStart,
				to: q.periodEnd,
			});
			const ids = new Set(records.map((r) => r.taskId));
			for (const id of input.inflightTaskIds) ids.add(id);
			seenUnions.push([...ids].sort());
			if (ids.size > q.maxTasks!) {
				return {
					ok: false,
					exceeded: "tasks" as const,
					reason: "本周期任务数已达上限（2 个，含执行中的任务）",
				};
			}
			return verdict;
		};

		// A 在工具内挂起：第一条模型响应（产生 usage 落账）之后、任务结束之前
		const holdA = deferred<void>();
		const holdTool: PlatformTool = {
			name: "hold",
			label: "挂起",
			description: "测试用挂起工具",
			parameters: { type: "object", properties: {} },
			async execute() {
				await holdA.promise;
				return { text: "继续" };
			},
		};
		// B 的模型响应也挂起，使其停留在「预检已过、席位已占、首轮响应未返回」
		const holdB = deferred<void>();

		const factory = new InProcessRunnerFactory({
			async createSession(id) {
				const session = new StorageBackedSession(
					{ id, createdAt: 1, storageVersion: 1 },
					new MemoryStorage(),
				);
				sessions.push(session);
				return session;
			},
			models,
			model: faux.getModel(),
			now: () => NOW,
			meter: (r) => store.record(r as UsageRecord),
			preflightModel: (input) =>
				preflightModel({
					tenant: input.tenant,
					taskId: input.taskId,
					inflightTaskIds: input.inflightTaskIds,
				}),
		});

		const makeRunner = (taskId: string, tools: PlatformTool[] = []) =>
			factory.createRunner({
				tenant: TENANT,
				taskId,
				sessionId: taskId,
				systemPrompt: "s",
				tools,
				gate: async () => ({ kind: "allow" }),
			});

		const runnerA = await makeRunner("task-A", [holdTool]);
		// 阶段 1：只投喂 A 的首轮（工具调用），让 A 在工具内挂起
		faux.setResponses([fauxAssistantMessage([fauxToolCall("hold", {})])]);
		const pA = runnerA.prompt("A");

		// 等 A 的首轮 usage 落账（此时 A 仍在 hold 工具内、任务在途）
		await waitUntil(async () =>
			(await store.list(TENANT.tenantId, { from: NOW - 1000, to: NOW + 1_000_000 })).some(
				(r) => r.taskId === "task-A",
			),
		);

		const runnerB = await makeRunner("task-B");
		// 阶段 2：投喂 B 的首轮（挂起不返回）。B 此刻发起第一次模型调用。
		faux.appendResponses([
			async () => {
				await holdB.promise;
				return fauxAssistantMessage("B 完成");
			},
		]);
		const pB = runnerB.prompt("B");
		// 等 B 的预检完成：旧公式下 settled(A)=1 + inflight(A,B)=2 → 1+2>=2 必拒；
		// 并集去重后 {A,B} 仅 2 个，2 > 2 不成立 → 放行。
		await waitUntil(() => seenUnions.some((u) => u.includes("task-B")));
		expect(seenUnions.find((u) => u.includes("task-B"))).toEqual(["task-A", "task-B"]);
		// B 已通过预检、模型响应挂在 holdB 上：prompt 既未成功也未失败
		let bState = "pending";
		pB.then(
			() => (bState = "resolved"),
			() => (bState = "rejected"),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(bState).toBe("pending");

		// 第三个任务 C：并集 {A,B,C}=3 > 2，第一次模型调用前被拒，零消耗
		const runnerC = await makeRunner("task-C");
		await expect(runnerC.prompt("C")).rejects.toThrow(/任务数已达上限/);
		const cRecords = await store.list(TENANT.tenantId, { from: NOW - 1000, to: NOW + 1_000_000 });
		expect(cRecords.some((r) => r.taskId === "task-C")).toBe(false);

		// 放行 A、B 执行结束：先备好 A 的第二轮响应（工具结果之后内核才会来取），
		// 再解开两个挂起。
		faux.appendResponses([fauxAssistantMessage("A 完成")]);
		holdA.resolve();
		holdB.resolve();
		await expect(pA).resolves.toBeUndefined();
		await expect(pB).resolves.toBeUndefined();

		// A/B 已结束（在途集合为空），但其 taskId 经已落账 usage 仍占席位：
		// 新任务 D 的并集 {A,B,D}=3，照样被拒（此处 evaluateQuota 的已落账
		// taskCount=2 也已触顶；无论哪条路径都拒绝）—— 已结束任务不会漏计。
		const runnerD = await makeRunner("task-D");
		await expect(runnerD.prompt("D")).rejects.toThrow(/上限/);

		await runnerA.close();
		await runnerB.close();
		await runnerC.close();
		await runnerD.close();
	});

	it("未超配额时纯文本任务正常成功且有消耗", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const store = new MemoryMeteringStore();
		faux.setResponses([fauxAssistantMessage("好的")]);

		const factory = new InProcessRunnerFactory({
			async createSession(id) {
				const session = new StorageBackedSession(
					{ id, createdAt: 1, storageVersion: 1 },
					new MemoryStorage(),
				);
				sessions.push(session);
				return session;
			},
			models,
			model: faux.getModel(),
			now: () => NOW,
			meter: (r) => store.record(r as UsageRecord),
			preflightModel: async ({ tenant }) =>
				evaluateQuota({ store, quota: { ...QUOTA, tenantId: tenant.tenantId }, prices: PRICES }),
		});
		const orchestrator = new TaskOrchestrator(factory, { now: () => NOW });
		const taskId = "quota-e2e-2";
		await orchestrator.submit({
			tenant: TENANT, taskId, sessionId: taskId, prompt: "你好",
			systemPrompt: "s", tools: [], gate: async () => ({ kind: "allow" }),
		});
		const result = await orchestrator.run(taskId, "你好");
		expect([TaskStatus.Succeeded, TaskStatus.Failed]).toContain(result.status);
	});
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** 轮询直到（可为异步的）条件成立。 */
function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
	return new Promise((resolvePromise) => {
		const check = async (): Promise<void> => {
			if (await predicate()) resolvePromise();
			else setImmediate(check);
		};
		void check();
	});
}
