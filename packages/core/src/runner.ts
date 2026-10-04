/**
 * RunnerAdapter —— 业务层与 Agent 内核之间的唯一边界
 *
 * **业务代码不得直接 import vendor/pi。** 这条纪律的意义不只是整洁：
 * 它决定了「将来能否换掉内核而不动业务代码」，而这正是[自主可控](../../../vendor/pi/README.md)的完整含义。
 *
 * 本文件只定义接口与数据形状，**不 import 任何 vendor 类型** ——
 * 否则 vendor 的类型会顺着接口泄漏到整个平台层，边界形同虚设。
 */

import type { TaskEvent } from "./events.ts";
import type { TenantContext } from "./tenant.ts";

export interface PendingAction {
	readonly actionId: string;
	readonly taskId: string;
	readonly tenant: TenantContext;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly argsHash: string;
	readonly reason: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly status: "pending" | "approved" | "executed" | "failed" | "rejected" | "expired" | "invalidated";
}

/** 仅在受控后端持久化，HTTP 动作列表不得输出 arguments。 */
export interface StoredAction extends PendingAction {
	readonly arguments: unknown;
}

/** 工具的权限决策结果。由权限门产生，Runner 执行。 */
export type ToolDecision =
	| { readonly kind: "allow" }
	/** 拒绝。reason 会作为工具错误结果反馈给模型，也会展示给用户。 */
	| { readonly kind: "block"; readonly reason: string }
	/** 需用户确认。任务转入 AWAIT_CONFIRM，保留原调用等待授权。 */
	| { readonly kind: "confirm"; readonly reason: string };

/**
 * 权限门。
 *
 * [M0 Spike 3](../../../spikes/README.md) 验证过的三条性质决定了它的契约：
 *  - 返回 block 时工具的 execute **零次**被调用（不是「返回错误」）
 *  - 实现抛异常时内核 **fail-closed**（拒绝而非放行）—— 所以这里不必自己 try/catch 兜底
 *  - 被拒调用不写执行意图，崩溃恢复不会重放
 */
export type PermissionGate = (request: {
	readonly toolName: string;
	readonly args: unknown;
	readonly tenant: TenantContext;
	readonly taskId: string;
}) => ToolDecision | Promise<ToolDecision>;

/** 工具执行结果。 */
export interface ToolOutcome {
	/** 反馈给模型的文本。 */
	readonly text: string;
	/** 供前端展示的结构化细节（可选）。 */
	readonly details?: unknown;
	readonly isError?: boolean;
}

/**
 * 平台自定义工具。
 *
 * 一期不开放自由 shell（[安全策略决策 4](../../../docs/security-policy.md)），
 * 所有能力以结构化工具提供、参数经 schema 校验。
 */
export interface PlatformTool {
	readonly name: string;
	/** 面向用户的名称，用于进度展示 —— 展示业务语言，不是工具名。 */
	readonly label: string;
	/** 发给模型的描述。 */
	readonly description: string;
	/** JSON Schema 形状的参数定义。适配层负责转成内核所需格式。 */
	readonly parameters: Readonly<Record<string, unknown>>;
	/**
	 * 崩溃恢复时能否安全重放。
	 *
	 * 默认 `never` —— 对有副作用的工具（写文件、发邮件）重放会造成重复执行。
	 * 只有确定幂等的工具才标 `safe`。
	 */
	readonly replay?: "never" | "safe";
	execute(input: {
		readonly args: unknown;
		readonly tenant: TenantContext;
		readonly taskId: string;
		/** 上报步骤内进度，驱动「已核对 1200/3000 行」这类细节展示。 */
		readonly report: (detail: string) => void;
		readonly signal: AbortSignal;
	}): Promise<ToolOutcome>;
}

/** 创建一个会话所需的一切。 */
export interface RunnerSpec {
	readonly tenant: TenantContext;
	readonly taskId: string;
	/** 会话标识。**一人一会话** —— 见下方 createRunner 的说明。 */
	readonly sessionId: string;
	readonly systemPrompt: string;
	readonly tools: readonly PlatformTool[];
	/**
	 * 激活的工具白名单。
	 *
	 * 与 `tools`（注册表）分开是有意的：白名单让工具在**模型侧不可见**，
	 * 权限门在**执行侧兜底**。两层叠加可防住历史对话里的旧工具名被重放。
	 * 省略则激活全部已注册工具。
	 */
	readonly activeTools?: readonly string[];
	/**
	 * 模型档位（M5-5）。词汇留在平台层，不泄漏任何内核类型。
	 *
	 * - `"flagship"`（默认）：能力强、单价高，用于任务规划与结果裁决这类
	 *   对质量敏感的运行（一期主任务默认走旗舰，保证产出质量）；
	 * - `"lite"`：单价低、速度快，用于常规执行与子 Agent 的并行子任务。
	 *
	 * 档位在创建 Runner 时选定，整次运行使用同一模型 —— 内核的 lane 配置
	 * 在一次 run 内不按「规划轮/执行轮」动态换模型，避免计量模型名错标。
	 */
	readonly tier?: "flagship" | "lite";
	readonly gate: PermissionGate;
	/** 步数上限，超出转 EXCEEDED。 */
	readonly maxSteps?: number;
	/**
	 * 多轮对话的历史（本轮之前的问答，按时间顺序）。
	 *
	 * 每轮是独立 Session（内核不允许同 id 重建），跨轮上下文不靠内核会话复用，
	 * 而是由宿主把历史问答显式带进新一轮，模型据此记得上文。进程重启后只要
	 * 历史事件仍在，就能重建这段记忆，因此比复用内存 Session 更稳。
	 */
	readonly history?: readonly ChatTurn[];
    readonly inputReferences?: readonly { fileId: string; name: string; sha256: string }[];
	/**
	 * 本次运行注入的技能（可复用指令）。透传给内核 harness 的 resources.skills，
	 * 模型命中使用场景时自动按指令执行。
	 */
	readonly skills?: readonly RunnerSkill[];
}

/** 传给 Runner 的技能（平台层形状，与内核 Skill 对齐）。 */
export interface RunnerSkill {
	readonly name: string;
	readonly description: string;
	readonly content: string;
}

/** 一轮历史问答，用于跨轮上下文。 */
export interface ChatTurn {
	readonly user: string;
	readonly assistant: string;
}

/** 一个运行中的会话。 */
export interface Runner {
	readonly sessionId: string;

	/**
	 * 提交一轮输入并执行到本轮结束。
	 *
	 * @param text 实际发给模型的提示（多轮时已含历史拼接）。
	 * @param rawUserText 本轮用户原文；提供时落一条持久化 user_message，
	 *   供多轮历史重建与前端展示。不传则不落（兼容旧调用）。
	 */
	prompt(text: string, rawUserText?: string): Promise<void>;

	/**
	 * 在执行期间插入消息。
	 *
	 * **不会打断执行中的工具** —— 消息落在当前 turn 及其全部工具调用完成之后。
	 * 这是内核的 steering 语义（[接口审计 §5](../../../docs/pi-interface-audit.md)），
	 * 产品文案必须据此表达为「已插入，当前步骤完成后送达」。
	 * 要真正中止只能用 `abort()`。
	 */
	steer(text: string): Promise<void>;

	/** 中止执行。这是唯一能取消进行中工具的手段。 */
	abort(reason: string): Promise<void>;
	/** 继续原来被挂起的工具调用，不重新发起模型请求。 */
	confirmAction?(actionId?: string): Promise<void>;
	listActions?(): readonly PendingAction[];

	/** 订阅事件。返回取消订阅的函数。 */
	subscribe(listener: (event: TaskEvent) => void | Promise<void>): () => void;

	/** 释放资源。幂等。 */
	close(): Promise<void>;
}

/**
 * Runner 工厂。
 *
 * 实现方必须遵守 [M0](../../../spikes/README.md) 确立的两条硬约束：
 *
 *  1. **一人一 Session。** 同一 Session 下的多个 lane 在 Session 的 mutation line
 *     上**串行**执行 —— 若让多个用户共用一个 Session，他们会互相排队。
 *  2. **必须显式传 streamFn。** 内核里 `stream-fn.ts` 的 `defaultStreamFn` 是
 *     进程级可变全局，省略即多会话共用同一模型入口。它在**构造期**解析，
 *     缺省时是启动即崩。
 */
export interface RunnerFactory {
	createRunner(spec: RunnerSpec): Promise<Runner>;
}
