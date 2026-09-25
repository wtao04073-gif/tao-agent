/**
 * 子任务扇出测试
 *
 * 三个断言重点：
 *
 *  1. **并发上限真的生效。** 不设上限的扇出会同时拉起 N 个模型请求，
 *     撞上速率限制后全部失败 —— 比串行慢得多。这是生产事故来源。
 *  2. **一个失败不中断其他。** 多部门汇总时某个部门文件坏了，用户宁可
 *     拿到 9 个结果加一条错误，也不想什么都没有。
 *  3. **结果按输入顺序而非完成顺序。** 扇出后必须知道哪个结果对应哪个
 *     子任务，而完成顺序是不确定的 —— 这是最容易写错的地方。
 */

import { describe, expect, it } from "vitest";
import {
	allSucceeded,
	collectArtifacts,
	DEFAULT_MAX_CONCURRENCY,
	describeResults,
	fanOut,
	subSessionId,
	type SubTask,
	type SubTaskProgress,
	type SubTaskResult,
	type TenantContext,
} from "../src/index.ts";

const TENANT: TenantContext = { tenantId: "univ-003", workspaceId: "data", userId: "liu" };

/** 造 N 个子任务。 */
function tasks(n: number): SubTask[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `sub-${i}`,
		label: `第${i + 1}个部门`,
		prompt: `核对第${i + 1}个部门的数据`,
	}));
}

const ok = (task: SubTask, summary = "完成"): SubTaskResult => ({
	id: task.id,
	label: task.label,
	status: "succeeded",
	summary,
});

describe("扇出 · 并发控制", () => {
	it("并发数不超过上限", async () => {
		// 不设上限会同时拉起 N 个模型请求，撞限流后全部失败
		let running = 0;
		let peak = 0;

		await fanOut(tasks(10), {
			tenant: TENANT,
			parentTaskId: "parent-1",
			maxConcurrency: 3,
			async run(task) {
				running += 1;
				peak = Math.max(peak, running);
				await new Promise((resolve) => setTimeout(resolve, 10));
				running -= 1;
				return ok(task);
			},
		});

		expect(peak).toBe(3);
	});

	it("默认上限是保守值", async () => {
		let peak = 0;
		let running = 0;

		await fanOut(tasks(10), {
			tenant: TENANT,
			parentTaskId: "parent-2",
			async run(task) {
				running += 1;
				peak = Math.max(peak, running);
				await new Promise((resolve) => setTimeout(resolve, 5));
				running -= 1;
				return ok(task);
			},
		});

		expect(peak).toBe(DEFAULT_MAX_CONCURRENCY);
		expect(DEFAULT_MAX_CONCURRENCY).toBeLessThanOrEqual(5);
	});

	it("真的并行：总耗时远小于串行", async () => {
		const started = Date.now();
		await fanOut(tasks(6), {
			tenant: TENANT,
			parentTaskId: "parent-3",
			maxConcurrency: 3,
			async run(task) {
				await new Promise((resolve) => setTimeout(resolve, 30));
				return ok(task);
			},
		});
		const elapsed = Date.now() - started;

		// 6 个 30ms 任务、并发 3 → 约 2 批 ≈ 60ms；串行会是 180ms
		expect(elapsed).toBeLessThan(140);
	});

	it("子任务数小于并发上限时不会空转", async () => {
		let calls = 0;
		const results = await fanOut(tasks(2), {
			tenant: TENANT,
			parentTaskId: "parent-4",
			maxConcurrency: 10,
			async run(task) {
				calls += 1;
				return ok(task);
			},
		});

		expect(calls).toBe(2);
		expect(results).toHaveLength(2);
	});

	it("并发上限非法时退化为串行，而非静默不执行", async () => {
		// 这条断言被变异测试加强过。原本只断言「返回 3 条结果」——
		// 但 maxConcurrency=0 时 Array.from({length:0}) 产生零个 worker，
		// Promise.all([]) 立即 resolve，兜底逻辑把全部子任务标成 failed。
		// 结果条数对了，实际一个都没跑 —— 比死锁更隐蔽。
		let calls = 0;
		const results = await fanOut(tasks(3), {
			tenant: TENANT,
			parentTaskId: "parent-5",
			maxConcurrency: 0, // 非法配置
			async run(task) {
				calls += 1;
				return ok(task);
			},
		});

		expect(results).toHaveLength(3);
		// 关键：子任务真的被执行了
		expect(calls).toBe(3);
		expect(results.every((r) => r.status === "succeeded")).toBe(true);
	});

	it("并发上限为负数时同样退化为串行", async () => {
		let calls = 0;
		const results = await fanOut(tasks(2), {
			tenant: TENANT,
			parentTaskId: "parent-5b",
			maxConcurrency: -5,
			async run(task) {
				calls += 1;
				return ok(task);
			},
		});
		expect(calls).toBe(2);
		expect(results.every((r) => r.status === "succeeded")).toBe(true);
	});

	it("空任务列表直接返回", async () => {
		let called = false;
		const results = await fanOut([], {
			tenant: TENANT,
			parentTaskId: "parent-6",
			async run(task) {
				called = true;
				return ok(task);
			},
		});
		expect(results).toEqual([]);
		expect(called).toBe(false);
	});
});

describe("扇出 · 失败隔离", () => {
	it("一个子任务抛异常不中断其他", async () => {
		const results = await fanOut(tasks(5), {
			tenant: TENANT,
			parentTaskId: "parent-7",
			async run(task) {
				if (task.id === "sub-2") throw new Error("文件损坏");
				return ok(task);
			},
		});

		expect(results).toHaveLength(5);
		expect(results.filter((r) => r.status === "succeeded")).toHaveLength(4);
		const failed = results.find((r) => r.status === "failed");
		expect(failed?.id).toBe("sub-2");
		expect(failed?.error).toContain("文件损坏");
	});

	it("子任务返回失败状态时同样保留其他结果", async () => {
		const results = await fanOut(tasks(3), {
			tenant: TENANT,
			parentTaskId: "parent-8",
			async run(task) {
				if (task.id === "sub-1") {
					return { id: task.id, label: task.label, status: "failed" as const, error: "列名不匹配" };
				}
				return ok(task);
			},
		});

		expect(results.filter((r) => r.status === "succeeded")).toHaveLength(2);
		expect(results[1]?.error).toBe("列名不匹配");
	});

	it("全部失败时仍返回完整结果列表", async () => {
		const results = await fanOut(tasks(3), {
			tenant: TENANT,
			parentTaskId: "parent-9",
			async run() {
				throw new Error("模型不可用");
			},
		});

		expect(results).toHaveLength(3);
		expect(results.every((r) => r.status === "failed")).toBe(true);
		expect(allSucceeded(results)).toBe(false);
	});

	it("非 Error 抛出物也被安全转成文本", async () => {
		const results = await fanOut(tasks(1), {
			tenant: TENANT,
			parentTaskId: "parent-10",
			async run() {
				throw "字符串异常"; // eslint-disable-line no-throw-literal
			},
		});
		expect(results[0]?.error).toContain("字符串异常");
	});
});

describe("扇出 · 结果顺序", () => {
	it("结果按输入顺序而非完成顺序", async () => {
		// 这是最容易写错的地方：用 push 收集结果会得到完成顺序，
		// 而扇出后必须知道哪个结果对应哪个子任务
		const input = [
			{ id: "slow", label: "慢任务", prompt: "x" },
			{ id: "fast", label: "快任务", prompt: "x" },
			{ id: "medium", label: "中任务", prompt: "x" },
		];
		const delays: Record<string, number> = { slow: 40, fast: 2, medium: 20 };

		const results = await fanOut(input, {
			tenant: TENANT,
			parentTaskId: "parent-11",
			maxConcurrency: 3,
			async run(task) {
				await new Promise((resolve) => setTimeout(resolve, delays[task.id]));
				return ok(task);
			},
		});

		expect(results.map((r) => r.id)).toEqual(["slow", "fast", "medium"]);
	});

	it("含失败项时顺序仍然正确", async () => {
		const results = await fanOut(tasks(4), {
			tenant: TENANT,
			parentTaskId: "parent-12",
			maxConcurrency: 4,
			async run(task) {
				// 让先发起的慢、后发起的快，且中间一个失败
				const index = Number(task.id.split("-")[1]);
				await new Promise((resolve) => setTimeout(resolve, (4 - index) * 10));
				if (index === 1) throw new Error("坏了");
				return ok(task);
			},
		});

		expect(results.map((r) => r.id)).toEqual(["sub-0", "sub-1", "sub-2", "sub-3"]);
		expect(results[1]?.status).toBe("failed");
	});
});

describe("扇出 · 会话隔离", () => {
	it("每个子任务分到独立的 sessionId", async () => {
		// Spike 5 的设计依据：一子任务一 Session
		const seen: string[] = [];
		await fanOut(tasks(4), {
			tenant: TENANT,
			parentTaskId: "parent-13",
			async run(task, sessionId) {
				seen.push(sessionId);
				return ok(task);
			},
		});

		expect(new Set(seen).size).toBe(4);
	});

	it("sessionId 带父任务标识，便于排查", () => {
		const id = subSessionId("task-abc", "sub-1");
		expect(id).toContain("task-abc");
		expect(id).toContain("sub-1");
	});

	it("不同父任务的同名子任务不会撞 sessionId", () => {
		expect(subSessionId("parent-a", "sub-1")).not.toBe(subSessionId("parent-b", "sub-1"));
	});
});

describe("扇出 · 进度上报", () => {
	it("每个子任务都有开始与结束事件", async () => {
		const events: SubTaskProgress[] = [];
		await fanOut(tasks(3), {
			tenant: TENANT,
			parentTaskId: "parent-14",
			maxConcurrency: 1,
			async run(task) {
				return ok(task);
			},
			onProgress: (e) => void events.push(e),
		});

		expect(events.filter((e) => e.phase === "started")).toHaveLength(3);
		expect(events.filter((e) => e.phase === "succeeded")).toHaveLength(3);
	});

	it("进度含已完成数与总数（用户最关心）", async () => {
		const events: SubTaskProgress[] = [];
		await fanOut(tasks(4), {
			tenant: TENANT,
			parentTaskId: "parent-15",
			maxConcurrency: 1,
			async run(task) {
				return ok(task);
			},
			onProgress: (e) => void events.push(e),
		});

		const finished = events.filter((e) => e.phase === "succeeded");
		expect(finished.map((e) => e.done)).toEqual([1, 2, 3, 4]);
		expect(finished.every((e) => e.total === 4)).toBe(true);
	});

	it("失败的子任务上报 failed", async () => {
		const events: SubTaskProgress[] = [];
		await fanOut(tasks(2), {
			tenant: TENANT,
			parentTaskId: "parent-16",
			async run(task) {
				if (task.id === "sub-0") throw new Error("x");
				return ok(task);
			},
			onProgress: (e) => void events.push(e),
		});

		expect(events.some((e) => e.phase === "failed" && e.taskId === "sub-0")).toBe(true);
	});

	it("进度用业务名称而非子任务 id", async () => {
		const events: SubTaskProgress[] = [];
		await fanOut(tasks(1), {
			tenant: TENANT,
			parentTaskId: "parent-17",
			async run(task) {
				return ok(task);
			},
			onProgress: (e) => void events.push(e),
		});
		expect(events[0]?.label).toBe("第1个部门");
	});

	it("进度回调抛异常不影响执行", async () => {
		const results = await fanOut(tasks(2), {
			tenant: TENANT,
			parentTaskId: "parent-18",
			async run(task) {
				return ok(task);
			},
			onProgress: () => {
				throw new Error("上报失败");
			},
		});
		// 进度上报失败不等于任务失败
		expect(results.filter((r) => r.status === "succeeded")).toHaveLength(2);
	});
});

describe("扇出 · 结果汇总", () => {
	it("失败项被显式列出且措辞醒目", () => {
		// 只给成功的结果会让用户以为全做完了，交付时才发现缺数据
		const results: SubTaskResult[] = [
			{ id: "a", label: "教务处", status: "succeeded", summary: "核对完成，2 处差异" },
			{ id: "b", label: "学生处", status: "failed", error: "文件格式无法识别" },
		];

		const text = describeResults(results);
		expect(text).toContain("成功 1 个");
		expect(text).toContain("失败 1 个");
		expect(text).toContain("学生处");
		expect(text).toContain("文件格式无法识别");
		// 明确警告不要直接交付
		expect(text).toContain("请勿直接对外提交");
	});

	it("全部成功时不出现警告", () => {
		const results: SubTaskResult[] = [{ id: "a", label: "教务处", status: "succeeded" }];
		const text = describeResults(results);
		expect(text).not.toContain("请勿直接对外提交");
		expect(text).not.toContain("失败");
	});

	it("收集全部产出文件并去重", () => {
		const results: SubTaskResult[] = [
			{ id: "a", label: "A", status: "succeeded", artifacts: ["/ws/a.xlsx", "/ws/shared.xlsx"] },
			{ id: "b", label: "B", status: "succeeded", artifacts: ["/ws/b.xlsx", "/ws/shared.xlsx"] },
		];
		expect(collectArtifacts(results).sort()).toEqual([
			"/ws/a.xlsx",
			"/ws/b.xlsx",
			"/ws/shared.xlsx",
		]);
	});

	it("空结果不算全部成功", () => {
		// 边界：没有子任务时不该被当成「全做完了」
		expect(allSucceeded([])).toBe(false);
	});

	it("有失败项时不算全部成功", () => {
		expect(
			allSucceeded([
				{ id: "a", label: "A", status: "succeeded" },
				{ id: "b", label: "B", status: "failed" },
			]),
		).toBe(false);
	});
});
