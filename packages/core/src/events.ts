/**
 * 任务事件流
 *
 * 事件是前端进度展示与计量结算的**唯一**数据来源，不是日志的附属品。
 *
 * 一条重要的设计约束来自 [M0 Spike 1](../../../spikes/README.md)：
 * 内核的 `AgentEvent` **不带任何会话标识**，所以事件的归属只能由宿主在
 * 发出时打标。这里的 `taskId` / `tenant` 字段就是那个标 —— 缺了它，
 * 多会话并发时无法分辨事件属于谁。
 */

import type { TaskStatus } from "./task-status.ts";
import type { TenantContext } from "./tenant.ts";

/** 所有任务事件的公共字段。 */
interface TaskEventBase {
	/** 事件自身的唯一标识，用于前端去重（事件可能重投）。 */
	readonly eventId: string;
	readonly taskId: string;
	readonly tenant: TenantContext;
	/** 毫秒时间戳。由产生事件的一方赋值。 */
	readonly at: number;
	/** 单调递增序号，用于断线重连后拉取增量。 */
	readonly seq: number;
}

/** 任务状态变更。 */
export interface TaskStatusEvent extends TaskEventBase {
	readonly type: "status";
	readonly from: TaskStatus | null;
	readonly to: TaskStatus;
	/** 进入 FAILED / CANCELLED / EXCEEDED 时的可读原因（验收要求可读）。 */
	readonly reason?: string;
}

/** 步骤级进度 —— 验收要求「步骤级粒度实时展示，含当前动作」。 */
export interface TaskStepEvent extends TaskEventBase {
	readonly type: "step";
	/** 步骤序号，从 1 开始。 */
	readonly step: number;
	/** 面向用户的动作描述，须是业务语言而非工具名。 */
	readonly action: string;
	readonly phase: "started" | "progress" | "finished" | "failed";
	/** 可选的细节文本（如「已核对 1200/3000 行」）。 */
	readonly detail?: string;
}

/** 工具调用的权限决策 —— 每一次拒绝都必须可审计。 */
export interface TaskToolDecisionEvent extends TaskEventBase {
	readonly type: "tool_decision";
	readonly toolName: string;
	readonly decision: "allowed" | "blocked" | "await_confirm";
	/** 拒绝或需确认的原因，会展示给用户。 */
	readonly reason?: string;
}

/** 已产出的中间物或最终产物。失败任务也要保留中间物（验收要求）。 */
export interface TaskArtifactEvent extends TaskEventBase {
	readonly type: "artifact";
	readonly artifactId: string;
	readonly name: string;
	readonly mimeType: string;
	readonly sizeBytes: number;
	readonly final: boolean;
}

/** 用户在执行期间插入的消息。 */
export interface TaskUserMessageEvent extends TaskEventBase {
	readonly type: "user_message";
	readonly text: string;
	/**
	 * 投递语义。
	 *
	 * 来自 [接口审计 §5](../../../docs/pi-interface-audit.md) 的硬事实：steering **不打断**
	 * 执行中的工具，消息落在当前 assistant turn 及其全部工具调用完成之后。
	 * 因此产品口径必须是「已插入，将在当前步骤完成后送达」，
	 * 而不是「立即打断」—— 承诺打断是无法兑现的。
	 */
	readonly delivery: "queued_after_current_step";
}

/** 模型用量 —— 计量埋点在两种形态下必须完全一致（需求 §3.9）。 */
export interface TaskUsageEvent extends TaskEventBase {
	readonly type: "usage";
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
}

export type TaskEvent =
	| TaskStatusEvent
	| TaskStepEvent
	| TaskToolDecisionEvent
	| TaskArtifactEvent
	| TaskUserMessageEvent
	| TaskUsageEvent;

export type TaskEventType = TaskEvent["type"];

/** 事件消费者。返回 Promise 时，发布方会等待其完成。 */
export type TaskEventListener = (event: TaskEvent) => void | Promise<void>;
