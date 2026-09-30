/**
 * 租户预检临界区与任务席位预留测试
 *
 * 对应缺陷：并发 prompt 的配额预检无互斥、无预留，同时读到相同 totals 而
 * 双双放行（TOCTOU），maxTasks 被并发突破。
 *
 * 两层覆盖：
 *  - 直接测 TenantTaskGate：同租户预检严格串行、在途计数随预留/释放变化、
 *    达上限拒绝且失败不预留、跨租户不互斥；
 *  - 经 InProcessRunnerFactory + faux 模型装配：并发 N 个 prompt 时只有
 *    maxTasks 个通过预检，超额者在第一次模型调用前失败且零消耗。
 */

import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../../../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../vendor/pi/agent/src/harness/session/session.ts";
import type { TenantContext } from "@tao/core";
import { afterEach, describe, expect, it } from "vitest";
import { InProcessRunnerFactory, type HostRuntime } from "../src/in-process-runner.ts";
import { TenantTaskGate } from "../src/tenant-gate.ts";

const TENANT: TenantContext = { tenantId: "t1", workspaceId: "w1", userId: "u1" };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("TenantTaskGate 预检临界区", () => {
	it("同租户预检严格串行：临界区内从无并发执行", async () => {
		const gate = new TenantTaskGate();
		let running = 0;
		let maxObserved = 0;
		const enteredAt: number[] = [];

		const barriers = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
		const taskIds = ["task-0", "task-1", "task-2", "task-3"];
		const preflight = (inflightTaskIds: readonly string[]) => {
			const inflightCount = inflightTaskIds.length;
			running += 1;
			maxObserved = Math.max(maxObserved, running);
			enteredAt.push(inflightCount);
			const barrier = barriers[inflightCount - 1] ?? deferred<void>();
			return barrier.promise.then(() => {
				running -= 1;
			});
		};

		// 4 个并发预留：每个预检都卡在各自 barrier 上，若临界区不串行，
		// running 会大于 1。
		const reservations = taskIds.map((taskId) => gate.reserve("t1", taskId, preflight));
		// 让微任务推进到第一个预检进入
		await Promise.resolve();
		await Promise.resolve();
		expect(maxObserved).toBe(1);

		// 逐个放行：后一个进入时必须看到前一个已预留（在途数递增）
		barriers[0].resolve();
		await reservations[0];
		expect(enteredAt).toContain(1);
		barriers[1].resolve();
		await reservations[1];
		barriers[2].resolve();
		await reservations[2];
		barriers[3].resolve();
		const releases = await Promise.all(reservations);
		expect(maxObserved).toBe(1);
		// 进入顺序即预留顺序：1、2、3、4（集合含本次 taskId，首个即 1）
		expect(enteredAt).toEqual([1, 2, 3, 4]);
		releases.forEach((r) => r());
		expect(gate.inflightCount("t1")).toBe(0);
	});

	it("传给 preflight 的在途集合是「此前在途 ∪ 本次」，含本次 taskId", async () => {
		const gate = new TenantTaskGate();
		const seen: readonly string[][] = [];
		const hold = deferred<void>();
		const preflight = (inflightTaskIds: readonly string[]) => {
			seen.push([...inflightTaskIds]);
			// 前两个停在临界区内/执行中，构造稳定的在途集合
			return seen.length <= 2 ? hold.promise : Promise.resolve();
		};

		const p1 = gate.reserve("t1", "task-A", preflight);
		await Promise.resolve();
		await Promise.resolve();
		const p2 = gate.reserve("t1", "task-B", preflight);
		hold.resolve();
		const r1 = await p1;
		const r2 = await p2;
		expect(seen[0]).toEqual(["task-A"]);
		expect(seen[1]).toEqual(["task-A", "task-B"]);

		// A 仍在途：新任务看到的集合以 A 为既有在途、并含自己
		const r3 = await gate.reserve("t1", "task-C", preflight);
		expect(seen[2]).toEqual(["task-A", "task-B", "task-C"]);

		// 释放 A、B 后只剩 C 在途；新任务集合不含已释放者
		r1();
		r2();
		await gate.reserve("t1", "task-D", preflight);
		expect(seen[3]).toEqual(["task-C", "task-D"]);
		r3();
	});

	it("达上限的预检抛错且不预留席位，后续任务仍可进入", async () => {
		const gate = new TenantTaskGate();
		const maxTasks = 2;
		const preflight = (inflightTaskIds: readonly string[]) => {
			if (inflightTaskIds.length > maxTasks) return Promise.reject(new Error("任务席位已满"));
			return Promise.resolve();
		};

		// 前两个拿到席位且不释放（模拟模型执行中），第三、四个必须被拒
		const r1 = await gate.reserve("t1", "seat-1", preflight);
		const r2 = await gate.reserve("t1", "seat-2", preflight);
		expect(gate.inflightCount("t1")).toBe(2);
		await expect(gate.reserve("t1", "seat-3", preflight)).rejects.toThrow("任务席位已满");
		await expect(gate.reserve("t1", "seat-4", preflight)).rejects.toThrow("任务席位已满");
		// 被拒不占位
		expect(gate.inflightCount("t1")).toBe(2);

		// 释放一个后，新任务可再拿一个席位
		r1();
		expect(gate.inflightCount("t1")).toBe(1);
		const r3 = await gate.reserve("t1", "seat-5", preflight);
		expect(gate.inflightCount("t1")).toBe(2);
		r2();
		r3();
		expect(gate.inflightCount("t1")).toBe(0);
	});

	it("不同租户的临界区互不阻塞", async () => {
		const gate = new TenantTaskGate();
		const a = deferred<void>();
		const b = deferred<void>();
		const ra = gate.reserve("tenant-a", "ta", () => a.promise);
		const rb = gate.reserve("tenant-b", "tb", () => b.promise);
		let resolved = 0;
		ra.then(() => {
			resolved += 1;
		});
		rb.then(() => {
			resolved += 1;
		});
		a.resolve();
		b.resolve();
		await Promise.all([ra, rb]);
		expect(resolved).toBe(2);
		expect(gate.inflightCount("tenant-a")).toBe(1);
		expect(gate.inflightCount("tenant-b")).toBe(1);
	});

	it("上一个预检失败不会卡死该租户后续预检（错误链被隔离）", async () => {
		const gate = new TenantTaskGate();
		await expect(
			gate.reserve("t1", "task-x", () => Promise.reject(new Error("第一次失败"))),
		).rejects.toThrow("第一次失败");
		const release = await gate.reserve("t1", "task-y", () => Promise.resolve());
		expect(gate.inflightCount("t1")).toBe(1);
		release();
	});
});

describe("InProcessRunnerFactory · 并发任务席位预留", () => {
	const openSessions: StorageBackedSession[] = [];
	afterEach(async () => {
		for (const s of openSessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
	});

	function makeFactory(preflight: NonNullable<HostRuntime["preflightModel"]>) {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
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
			preflightModel: preflight,
		});
		return { factory, faux };
	}

	async function makeRunner(
		factory: InProcessRunnerFactory,
		taskId: string,
	): Promise<Awaited<ReturnType<InProcessRunnerFactory["createRunner"]>>> {
		return factory.createRunner({
			tenant: TENANT,
			taskId,
			sessionId: taskId,
			systemPrompt: "s",
			tools: [],
			gate: async () => ({ kind: "allow" }),
		});
	}

	it("并发 3 个 prompt 时只有 maxTasks=2 个放行，超额者零模型消耗", async () => {
		const maxTasks = 2;
		const seenInflight: number[] = [];
		const seenSets: string[][] = [];
		const { factory, faux } = makeFactory(({ inflightCount, inflightTaskIds, taskId }) => {
			seenInflight.push(inflightCount);
			seenSets.push([...inflightTaskIds]);
			// 集合口径与计数一致，且必然包含本次 taskId
			expect(inflightTaskIds).toContain(taskId);
			expect(inflightCount).toBe(inflightTaskIds.length);
			if (inflightCount > maxTasks) {
				return Promise.resolve({
					ok: false,
					exceeded: "tasks" as const,
					reason: "本周期任务席位已满，请等待下个周期",
				});
			}
			return Promise.resolve({ ok: true as const });
		});

		// 预检临界区一结束（席位已预留）就进入 lane.prompt；把模型响应挂在闸门
		// 上，前两个任务便停留在「已占席位、执行中」状态。第三个预检被拒、模型
		// 一次都不会调，所以只排两个响应。
		const modelGate = deferred<void>();
		faux.setResponses([
			async () => {
				await modelGate.promise;
				return fauxAssistantMessage("任务一完成");
			},
			async () => {
				await modelGate.promise;
				return fauxAssistantMessage("任务二完成");
			},
		]);

		const r1 = await makeRunner(factory, "seat-1");
		const r2 = await makeRunner(factory, "seat-2");
		const r3 = await makeRunner(factory, "seat-3");

		const p1 = r1.prompt("一");
		const p2 = r2.prompt("二");
		// 等两个预检串行落定（集合大小分别为 1、2），此时席位已占满为 2
		await waitUntil(() => seenInflight.includes(2));
		expect([...seenInflight].sort((a, b) => a - b)).toEqual([1, 2]);
		expect(seenSets).toContainEqual(["seat-1"]);
		expect(seenSets).toContainEqual(["seat-1", "seat-2"]);

		const p3 = r3.prompt("三");
		await expect(p3).rejects.toThrow(/任务席位已满/);
		// 第三个进入预检时两个席位都已被占：集合含全部三个 taskId
		expect(seenInflight).toContain(3);
		expect(seenSets).toContainEqual(["seat-1", "seat-2", "seat-3"]);

		modelGate.resolve();
		await expect(p1).resolves.toBeUndefined();
		await expect(p2).resolves.toBeUndefined();

		// 两个在途任务结束后席位全部归还：新任务集合只含自己（大小 1），正常放行
		faux.setResponses([fauxAssistantMessage("补位任务完成")]);
		const r4 = await makeRunner(factory, "seat-4");
		await r4.prompt("补位");
		expect(seenInflight[seenInflight.length - 1]).toBe(1);
		expect(seenSets[seenSets.length - 1]).toEqual(["seat-4"]);

		await r1.close();
		await r2.close();
		await r3.close();
		await r4.close();
	});
});

/** 轮询直到条件成立（测试辅助，间隔极短）。 */
function waitUntil(predicate: () => boolean): Promise<void> {
	return new Promise((resolvePromise) => {
		const check = (): void => {
			if (predicate()) resolvePromise();
			else setImmediate(check);
		};
		check();
	});
}
