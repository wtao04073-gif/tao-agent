/**
 * 任务状态机
 *
 * 与 [技术方案 §2.1](../../../docs/tech-design.md) 的状态图一一对应。
 * 这是产品语义的核心，不是实现细节 —— 前端进度展示、计量结算、
 * 重试策略都挂在这套状态上。
 */

/** 任务状态。终态之外的状态都可能因执行节点重启而被恢复。 */
export const TaskStatus = {
	/** 排队中 —— 等 Runner 或等并发位。已计入配额，未消耗模型调用。 */
	Queued: "QUEUED",
	/** 执行中。用户可在此期间继续对话（消息入队，当前步骤完成后送达）。 */
	Running: "RUNNING",
	/** 等待用户确认 —— 高危动作或信息缺口。不占用执行资源。 */
	AwaitConfirm: "AWAIT_CONFIRM",
	/** 已成功，产物可取回。 */
	Succeeded: "SUCCEEDED",
	/** 失败。保留已产出的中间物与可读的失败原因（验收要求）。 */
	Failed: "FAILED",
	/** 用户主动取消。 */
	Cancelled: "CANCELLED",
	/** 超出步数或时长上限，转为需用户确认是否继续。 */
	Exceeded: "EXCEEDED",
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/** 终态：不会再自行改变，可安全用于结算与归档。 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
	TaskStatus.Succeeded,
	TaskStatus.Failed,
	TaskStatus.Cancelled,
];

export function isTerminal(status: TaskStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}

/**
 * 合法的状态迁移。
 *
 * 显式列举而非用 if 判断，因为非法迁移是真实事故来源 ——
 * 例如已 SUCCEEDED 的任务被重复结算，或 CANCELLED 后又被恢复执行。
 */
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	[TaskStatus.Queued]: [TaskStatus.Running, TaskStatus.Cancelled, TaskStatus.Failed],
	[TaskStatus.Running]: [
		TaskStatus.AwaitConfirm,
		TaskStatus.Succeeded,
		TaskStatus.Failed,
		TaskStatus.Cancelled,
		TaskStatus.Exceeded,
	],
	// 确认后回到执行；拒绝则取消。EXCEEDED 同理（用户决定是否继续）。
	[TaskStatus.AwaitConfirm]: [TaskStatus.Running, TaskStatus.Cancelled, TaskStatus.Failed],
	[TaskStatus.Exceeded]: [TaskStatus.Running, TaskStatus.Cancelled],
	[TaskStatus.Succeeded]: [],
	[TaskStatus.Failed]: [],
	[TaskStatus.Cancelled]: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
	return TRANSITIONS[from].includes(to);
}

/** 允许从某状态迁移到的全部状态（供 UI 判断可用操作）。 */
export function allowedTransitions(from: TaskStatus): readonly TaskStatus[] {
	return TRANSITIONS[from];
}
