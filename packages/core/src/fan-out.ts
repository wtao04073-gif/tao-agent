/**
 * 子任务扇出
 *
 * 场景：多部门数据汇总、多指标评估报告、多批次质量分析。这些任务的共同点是
 * **可拆成互不依赖的子任务**，拆开并行能显著缩短等待。
 *
 * ── 设计依据：[Spike 5](../../../spikes/05-subagent-parallel/) ──
 *
 * 一子任务一 Session。理由是三条，**不包括**「否则不能并行」——
 * spike 实测同 Session 的多 lane 模型调用本来就并发：
 *
 *  1. **写入争用随子任务数放大。** 同 Session 的存储读-改-写会排队。
 *  2. **故障隔离。** 一个子任务的存储损坏不影响其他子任务。
 *  3. **独立检查点。** 子任务可单独续跑，不必整体重来。
 *
 * ── 一条硬约束：并发上限 ──
 *
 * 不设上限的扇出是生产事故来源：10 个部门的数据汇总会同时拉起 10 个
 * 模型请求，撞上 provider 的速率限制后全部失败 —— 比串行慢得多。
 * 所以并发度必须可配且有保守默认值。
 */

import type { TenantContext } from "./tenant.ts";

/** 一个子任务的定义。 */
export interface SubTask {
	/** 子任务标识。用于结果对应与进度上报。 */
	readonly id: string;
	/** 面向用户的名称，如「教务处数据核对」。 */
	readonly label: string;
	/** 该子任务的指令。 */
	readonly prompt: string;
	/**
	 * 该子任务可用的工具。
	 *
	 * 通常是父任务工具的子集 —— 子任务职责单一，给全套工具反而增加误用面。
	 */
	readonly tools?: readonly string[];
}

/** 一个子任务的执行结果。 */
export interface SubTaskResult {
	readonly id: string;
	readonly label: string;
	readonly status: "succeeded" | "failed";
	/** 成功时的产出摘要。 */
	readonly summary?: string;
	/** 失败原因。 */
	readonly error?: string;
	/** 该子任务产出的文件路径。 */
	readonly artifacts?: readonly string[];
}

/**
 * 默认并发上限。
 *
 * 取 3 是保守值：国产模型 API 的速率限制通常按每分钟请求数计，
 * 而一个子任务可能发起多轮模型调用。宁可慢一点也不要撞限流 ——
 * 撞了之后全部失败，用户体验比串行差得多。
 *
 * 私有化部署若用自有推理服务，可按实际容量调高。
 */
export const DEFAULT_MAX_CONCURRENCY = 3;

export interface FanOutOptions {
	readonly tenant: TenantContext;
	/** 父任务标识。子任务的 sessionId 由它派生，便于排查。 */
	readonly parentTaskId: string;
	readonly maxConcurrency?: number;
	/** 单个子任务的执行函数。由调用方注入，这里不关心怎么执行。 */
	readonly run: (task: SubTask, sessionId: string) => Promise<SubTaskResult>;
	/** 子任务状态变化回调，用于向用户展示进度。 */
	readonly onProgress?: (event: SubTaskProgress) => void;
}

export interface SubTaskProgress {
	readonly taskId: string;
	readonly label: string;
	readonly phase: "started" | "succeeded" | "failed";
	/** 已完成数 / 总数。用户最关心这个。 */
	readonly done: number;
	readonly total: number;
}

/**
 * 派生子任务的 sessionId。
 *
 * 带上父任务标识，排查问题时能从一个子任务的会话追回父任务。
 */
export function subSessionId(parentTaskId: string, subTaskId: string): string {
	return `${parentTaskId}::${subTaskId}`;
}

/**
 * 并行执行子任务。
 *
 * 语义要点：
 *
 *  - **一个子任务失败不中断其他。** 多部门汇总时某个部门的文件坏了，
 *    不该让整个任务失败 —— 用户宁可拿到 9 个部门的结果加一条错误说明，
 *    也不想什么都没有。
 *  - **结果按输入顺序返回**，不是完成顺序。扇出后必须知道哪个结果
 *    对应哪个子任务，而完成顺序是不确定的。
 *  - **并发受限**，超出上限的子任务排队等待。
 */
export async function fanOut(
	tasks: readonly SubTask[],
	options: FanOutOptions,
): Promise<SubTaskResult[]> {
	if (tasks.length === 0) return [];

	const limit = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
	// 按输入顺序预留结果位置 —— 这是「结果按输入顺序」的实现方式
	const results = new Array<SubTaskResult | undefined>(tasks.length);
	let done = 0;
	let next = 0;

	const report = (task: SubTask, phase: SubTaskProgress["phase"]): void => {
		/**
		 * 进度上报失败不等于任务失败。
		 *
		 * 不吞异常的后果是：前端的一个渲染错误会炸掉整个扇出，
		 * 用户丢掉全部子任务的结果。进度是**观测**，不该影响执行 ——
		 * 与适配层发布事件时同一原则。
		 */
		try {
			options.onProgress?.({
				taskId: task.id,
				label: task.label,
				phase,
				done,
				total: tasks.length,
			});
		} catch {
			// 刻意留空：观测失败不影响被观测的执行
		}
	};

	/** 一个工作协程：不断取下一个未处理的子任务。 */
	const worker = async (): Promise<void> => {
		while (true) {
			const index = next++;
			if (index >= tasks.length) return;
			const task = tasks[index] as SubTask;

			report(task, "started");
			try {
				const result = await options.run(task, subSessionId(options.parentTaskId, task.id));
				results[index] = result;
				done += 1;
				report(task, result.status === "succeeded" ? "succeeded" : "failed");
			} catch (error) {
				// 捕获而非抛出 —— 一个子任务失败不该中断其他
				results[index] = {
					id: task.id,
					label: task.label,
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
				done += 1;
				report(task, "failed");
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));

	// 理论上不会有空位，但类型上要收敛
	return results.map((r, i) => {
		const task = tasks[i] as SubTask;
		return (
			r ?? {
				id: task.id,
				label: task.label,
				status: "failed" as const,
				error: "子任务未被执行",
			}
		);
	});
}

/**
 * 把子任务结果汇总成给用户看的说明。
 *
 * **失败项必须显式列出。** 只给成功的结果会让用户以为全做完了，
 * 拿去交付时才发现缺了一个部门的数据 —— 那时已经晚了。
 */
export function describeResults(results: readonly SubTaskResult[]): string {
	const ok = results.filter((r) => r.status === "succeeded");
	const failed = results.filter((r) => r.status === "failed");

	const lines: string[] = [
		`共 ${results.length} 个子任务，成功 ${ok.length} 个${failed.length > 0 ? `，失败 ${failed.length} 个` : ""}。`,
	];

	if (ok.length > 0) {
		lines.push("", "已完成：");
		for (const result of ok) {
			const summary = result.summary === undefined ? "" : ` —— ${result.summary}`;
			lines.push(`  · ${result.label}${summary}`);
		}
	}

	if (failed.length > 0) {
		// 失败的放后面但用醒目措辞，确保用户看见
		lines.push("", "⚠ 以下子任务未完成，产出不完整，请勿直接对外提交：");
		for (const result of failed) {
			lines.push(`  · ${result.label}：${result.error ?? "原因未知"}`);
		}
	}

	return lines.join("\n");
}

/** 收集所有子任务的产出文件。 */
export function collectArtifacts(results: readonly SubTaskResult[]): string[] {
	const seen = new Set<string>();
	for (const result of results) {
		for (const path of result.artifacts ?? []) seen.add(path);
	}
	return [...seen];
}

/** 是否全部成功。用于决定父任务的终态。 */
export function allSucceeded(results: readonly SubTaskResult[]): boolean {
	return results.length > 0 && results.every((r) => r.status === "succeeded");
}
