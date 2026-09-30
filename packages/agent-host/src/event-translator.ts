/**
 * 内核事件 → 平台事件的翻译
 *
 * 为什么需要这一层：
 *
 *  1. **打标。** [M0 Spike 1](../../../spikes/README.md) 确认内核事件不带任何会话标识，
 *     多会话并发时无法分辨事件归属。taskId / tenant 必须由宿主在此注入。
 *  2. **业务语言。** 内核事件说的是 `tool_start / toolName: "reconcile_tables"`，
 *     用户要看的是「正在核对供应商对账表」。翻译在此完成，前端不该认识工具名。
 *  3. **隔离内核变更。** 上游改事件结构时，只有本文件需要跟着改。
 */

import type { TaskEvent, TenantContext } from "@tao/core";

/** 单调递增的事件序号生成器。断线重连后前端靠它拉增量。 */
export class EventSequencer {
	private seq = 0;
	private counter = 0;
	private readonly idPrefix: string;

	constructor(idPrefix: string) {
		this.idPrefix = idPrefix;
	}

	next(): { seq: number; eventId: string } {
		this.seq += 1;
		this.counter += 1;
		// 不用 Date.now()/随机数：事件 id 必须可复现，便于比对与回放
		return { seq: this.seq, eventId: `${this.idPrefix}-${this.counter}` };
	}
}

export interface TranslatorContext {
	readonly taskId: string;
	readonly tenant: TenantContext;
	readonly sequencer: EventSequencer;
	/** 工具名 → 面向用户的动作描述。前端不该认识工具名。 */
	readonly toolLabels: ReadonlyMap<string, string>;
	/** 取当前时间。注入以便测试可控。 */
	readonly now: () => number;
	/**
	 * 本次会话使用的模型名。
	 *
	 * **必须由宿主注入，内核事件里没有。** 第一版从 `event.row.model` 读，
	 * 实测恒为 undefined —— 内核的 `UsageRow` 只有 `{id, seq, usage, ...}`，
	 * `Usage` 里也没有模型标识。
	 *
	 * 后果很隐蔽：用量事件照常上报、token 数也对，只是模型名全是
	 * "unknown"。而 M4-1 的 `estimateCost` 按模型名查单价 ——
	 * 全归到 unknown 就等于**全部未配价**，账面金额恒为 0。
	 * 功能测试全绿（任务能跑、token 有数），只有对账时才发现钱算不出来。
	 */
	readonly model: string;
}

/** 内核事件的最小形状 —— 只声明我们实际消费的字段，减少对上游结构的耦合。 */
export interface KernelEvent {
	readonly type: string;
	readonly toolName?: string;
	readonly toolCallId?: string;
	readonly args?: unknown;
	readonly isError?: boolean;
	readonly row?: {
		readonly usage?: {
			readonly input?: number;
			readonly output?: number;
			readonly cacheRead?: number;
			readonly cacheWrite?: number;
		};
	};
}

/** 步骤计数器。工具调用即一个步骤 —— 这是用户能理解的粒度。 */
export class StepCounter {
	private step = 0;
	private readonly byCallId = new Map<string, number>();

	/** 开始一个步骤，返回其序号。 */
	start(toolCallId: string): number {
		this.step += 1;
		this.byCallId.set(toolCallId, this.step);
		return this.step;
	}

	/** 取已开始步骤的序号。未知调用返回当前步骤（容忍事件缺失）。 */
	resolve(toolCallId: string | undefined): number {
		if (toolCallId === undefined) return this.step;
		return this.byCallId.get(toolCallId) ?? this.step;
	}

	get current(): number {
		return this.step;
	}
}

/**
 * 把一个内核事件翻译成零个或多个平台事件。
 *
 * 返回数组而非单个值：有些内核事件不产生平台事件（返回空），
 * 未来也可能一个内核事件要拆成多个平台事件。
 */
export function translate(
	event: KernelEvent,
	ctx: TranslatorContext,
	steps: StepCounter,
): TaskEvent[] {
	const base = () => {
		const { seq, eventId } = ctx.sequencer.next();
		return { eventId, seq, taskId: ctx.taskId, tenant: ctx.tenant, at: ctx.now() };
	};

	const label = (toolName: string | undefined): string =>
		(toolName === undefined ? undefined : ctx.toolLabels.get(toolName)) ?? toolName ?? "处理中";

	switch (event.type) {
		case "tool_start": {
			if (event.toolCallId === undefined) return [];
			return [
				{
					...base(),
					type: "step",
					step: steps.start(event.toolCallId),
					action: label(event.toolName),
					phase: "started",
				},
			];
		}

		case "tool_update": {
			return [
				{
					...base(),
					type: "step",
					step: steps.resolve(event.toolCallId),
					action: label(event.toolName),
					phase: "progress",
				},
			];
		}

		case "tool_end": {
			return [
				{
					...base(),
					type: "step",
					step: steps.resolve(event.toolCallId),
					action: label(event.toolName),
					// 失败的步骤要明确标出来，否则用户看到「已完成」却没有产物会困惑
					phase: event.isError === true ? "failed" : "finished",
				},
			];
		}

		case "usage": {
			const usage = event.row?.usage;
			if (usage === undefined) return [];
			return [
				{
					...base(),
					type: "usage",
					// 模型名来自宿主注入，内核事件里没有（见 TranslatorContext.model）
					model: ctx.model,
					inputTokens: usage.input ?? 0,
					outputTokens: usage.output ?? 0,
					cacheReadTokens: usage.cacheRead ?? 0,
					cacheWriteTokens: usage.cacheWrite ?? 0,
				},
			];
		}

		default:
			// 其余内核事件（turn_start、message_update、compaction 等）不直接面向用户。
			// 刻意不做兜底转发 —— 否则内核新增事件会不受控地泄漏到前端。
			return [];
	}
}
