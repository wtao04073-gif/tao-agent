/**
 * 进程内 Runner 实现
 *
 * 全平台**唯一**接触 vendor/pi 的地方（由 `scripts/check-boundaries.mjs` 守卫）。
 *
 * 三条来自 [M0](../../../spikes/README.md) 的约束在此被强制，而非仅写在文档里：
 *
 *  1. **显式传 streamFn** —— 省略会落到内核的进程级全局 `defaultStreamFn`，
 *     导致多会话共用同一模型入口。本文件从不省略。
 *  2. **一人一 Session** —— 每个 Runner 独占一个 Session。
 *     同 Session 的多 lane 在 mutation line 上串行，共用会让用户互相排队。
 *  3. **权限门 fail-closed** —— `before_tool` 抛异常时内核会拒绝执行，
 *     所以此处不吞异常、不做「出错就放行」的兜底。
 */

import {
	AgentHarness,
	type AgentHarnessTool,
	type AgentLane,
	type Session,
} from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { createModels, type Model, type Api } from "@earendil-works/pi-ai";
import type {
	PermissionGate,
	PlatformTool,
	Runner,
	RunnerFactory,
	RunnerSpec,
	TaskEvent,
	ToolDecision,
} from "@tao/core";
import {
	EventSequencer,
	type KernelEvent,
	StepCounter,
	translate,
	type TranslatorContext,
} from "./event-translator.ts";

/** 宿主运行所需的外部依赖。全部注入 —— 便于测试与私有化部署替换。 */
export interface HostRuntime {
	/** 创建一个独占的会话存储。一人一 Session 由调用方保证。 */
	createSession(sessionId: string): Promise<Session>;
	/** 模型清单与 provider。 */
	models: ReturnType<typeof createModels>;
	/** 本次会话使用的模型。 */
	model: Model<Api>;
	/** 取当前时间。注入以便测试可控。 */
	now?: () => number;
}

/** 把平台工具适配成内核工具。参数 schema 与执行签名在此转换。 */
function toKernelTool(
	tool: PlatformTool,
	ctx: { taskId: string; tenant: RunnerSpec["tenant"]; emitDetail: (detail: string) => void },
): AgentHarnessTool<undefined> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		// 平台侧用 JSON Schema 描述参数，内核直接接受该形状
		parameters: tool.parameters as AgentHarnessTool<undefined>["parameters"],
		replay: tool.replay ?? "never",
		async execute(_toolCallId, args, _onUpdate, _toolContext, _invocation, context) {
			const outcome = await tool.execute({
				args,
				tenant: ctx.tenant,
				taskId: ctx.taskId,
				report: ctx.emitDetail,
				// 内核通过 context 传递中止信号；没有则给一个永不中止的
				signal: context.abortSignal ?? new AbortController().signal,
			});
			return {
				content: [{ type: "text", text: outcome.text }],
				details: outcome.details,
				...(outcome.isError === true ? { isError: true } : {}),
			} as Awaited<ReturnType<AgentHarnessTool<undefined>["execute"]>>;
		},
	};
}

class InProcessRunner implements Runner {
	private readonly listeners = new Set<(event: TaskEvent) => void | Promise<void>>();
	private readonly steps = new StepCounter();
	private readonly translatorContext: TranslatorContext;
	private closed = false;
	/**
	 * 最近一次运行的失败原因。
	 *
	 * 内核把生成阶段的失败（模型不可用、`activeToolNames` 里有未注册的工具、
	 * provider 报错）通过 `run_end{status:"failed"}` 事件上报，**而不是**
	 * 让 `lane.prompt()` 抛异常 —— prompt 正常 resolve。
	 *
	 * 不接这个事件的后果极其隐蔽：任务被报成成功，但模型一次都没被调用、
	 * 没有任何产出。用户看到「已完成」却拿不到文件，而日志里一切正常。
	 */
	private runFailure: string | undefined;

	readonly sessionId: string;
	private readonly session: Session;
	private readonly lane: AgentLane;
	private readonly spec: RunnerSpec;

	constructor(sessionId: string, session: Session, lane: AgentLane, spec: RunnerSpec, now: () => number) {
		this.sessionId = sessionId;
		this.session = session;
		this.lane = lane;
		this.spec = spec;
		this.translatorContext = {
			taskId: spec.taskId,
			tenant: spec.tenant,
			sequencer: new EventSequencer(spec.taskId),
			toolLabels: new Map(spec.tools.map((t) => [t.name, t.label])),
			now,
		};
	}

	/** 发布一个平台事件。监听器异常不影响其他监听器，也不影响执行。 */
	private async publish(event: TaskEvent): Promise<void> {
		for (const listener of this.listeners) {
			try {
				await listener(event);
			} catch {
				// 事件消费方的问题不应中断任务执行 —— 进度上报失败不等于任务失败
			}
		}
	}

	/** 消费一个内核事件。由工厂在装配时接线。 */
	async ingest(event: KernelEvent): Promise<void> {
		for (const translated of translate(event, this.translatorContext, this.steps)) {
			await this.publish(translated);
		}
	}

	/** 由权限门与工具回调用来直接发事件（不经内核事件流）。 */
	async emit(
		build: (base: {
			eventId: string;
			seq: number;
			taskId: string;
			tenant: RunnerSpec["tenant"];
			at: number;
		}) => TaskEvent,
	): Promise<void> {
		const { seq, eventId } = this.translatorContext.sequencer.next();
		await this.publish(
			build({
				eventId,
				seq,
				taskId: this.spec.taskId,
				tenant: this.spec.tenant,
				at: this.translatorContext.now(),
			}),
		);
	}

	/** 记录内核上报的运行失败。由工厂接线 `run_end` 事件时调用。 */
	noteRunFailure(reason: string): void {
		this.runFailure = reason;
	}

	async prompt(text: string): Promise<void> {
		this.assertOpen();
		this.runFailure = undefined;
		await this.lane.prompt(text, [], BACKGROUND_CONTEXT);
		// 内核不会因生成失败而让 prompt reject，所以这里必须显式检查。
		// 抛出去让编排层把任务转入 FAILED —— 静默成功比报错难查得多。
		if (this.runFailure !== undefined) throw new Error(this.runFailure);
	}

	async steer(text: string): Promise<void> {
		this.assertOpen();
		// 先记录用户消息已入队，再真正入队 —— 顺序反了的话，
		// 若入队抛错用户会看到「已插入」却没生效
		await this.emit((base) => ({
			...base,
			type: "user_message",
			text,
			// 口径固定为「当前步骤完成后送达」：steering 永不打断执行中的工具
			delivery: "queued_after_current_step",
		}));
		await this.lane.steer(text, [], BACKGROUND_CONTEXT);
	}

	async abort(reason: string): Promise<void> {
		this.assertOpen();
		// abort 是唯一能取消进行中工具的手段（steer 不能）
		await this.lane.abort(BACKGROUND_CONTEXT);
		await this.emit((base) => ({
			...base,
			type: "status",
			from: null,
			to: "CANCELLED",
			reason,
		}));
	}

	subscribe(listener: (event: TaskEvent) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(): Promise<void> {
		if (this.closed) return; // 幂等
		this.closed = true;
		this.listeners.clear();
		await this.session.close(BACKGROUND_CONTEXT);
	}

	private assertOpen(): void {
		if (this.closed) throw new Error(`Runner ${this.sessionId} 已关闭`);
	}
}

/**
 * 把平台权限门接到内核的 `before_tool` 钩子。
 *
 * 关键语义（[M0 Spike 3](../../../spikes/README.md) 验证）：
 *  - 返回 `{ block }` 时工具的 execute **零次**被调用
 *  - 本函数**不 try/catch** —— 抛异常时内核 fail-closed（拒绝），
 *    这正是我们要的行为。自己兜底反而可能把拒绝变成放行。
 */
function installGate(
	harness: { hooks: { on: (name: string, handler: (event: never) => unknown) => () => void } },
	gate: PermissionGate,
	runner: InProcessRunner,
	spec: RunnerSpec,
): void {
	harness.hooks.on("before_tool", (async (event: {
		toolName: string;
		args: unknown;
	}) => {
		const decision: ToolDecision = await gate({
			toolName: event.toolName,
			args: event.args,
			tenant: spec.tenant,
			taskId: spec.taskId,
		});

		await runner.emit((base) => ({
			...base,
			type: "tool_decision",
			toolName: event.toolName,
			decision:
				decision.kind === "allow"
					? "allowed"
					: decision.kind === "block"
						? "blocked"
						: "await_confirm",
			...(decision.kind === "allow" ? {} : { reason: decision.reason }),
		}));

		if (decision.kind === "allow") return undefined;
		// confirm 与 block 都先拦下执行。两者的区别在编排层：
		// confirm 会把任务转入 AWAIT_CONFIRM 等用户决定，block 是终局拒绝。
		return { block: { reason: decision.reason } };
	}) as (event: never) => unknown);
}

/** 进程内 Runner 工厂。 */
export class InProcessRunnerFactory implements RunnerFactory {
	private readonly runtime: HostRuntime;

	constructor(runtime: HostRuntime) {
		this.runtime = runtime;
	}

	async createRunner(spec: RunnerSpec): Promise<Runner> {
		const now = this.runtime.now ?? (() => Date.now());

		/**
		 * activeTools 必须是已注册工具的子集。
		 *
		 * 内核对此的处理是**整个运行失败**（`configured_tools_unavailable`），
		 * 而不是忽略未知名字。在这里提前报错，错误信息能指出是哪个工具名不对；
		 * 放到内核里报，只能拿到一次「任务失败」且模型一次未被调用。
		 *
		 * 调用方若要容忍「场景卡声明了尚未实现的工具」，应先用
		 * `activateableTools()` 取交集，而不是指望这里宽容处理 ——
		 * 静默丢弃工具名会让「场景卡写错工具名」变成查不出的能力缺失。
		 */
		if (spec.activeTools !== undefined) {
			const registered = new Set(spec.tools.map((t) => t.name));
			const missing = [...spec.activeTools].filter((name) => !registered.has(name));
			if (missing.length > 0) {
				throw new Error(
					`activeTools 含未注册的工具：${missing.join("、")}。` +
						`已注册：${[...registered].join("、")}。` +
						`若场景卡声明了尚未实现的工具，请先用 activateableTools() 取交集。`,
				);
			}
		}

		// 一人一 Session：每个 Runner 独占一个会话存储
		const session = await this.runtime.createSession(spec.sessionId);

		let runnerRef: InProcessRunner | undefined;
		const emitDetail = (detail: string): void => {
			// 工具内的进度上报。不 await —— 工具执行不该被事件投递阻塞
			void runnerRef?.emit((base) => ({
				...base,
				type: "step",
				step: 0, // 由 StepCounter 在事件流里给出真实步骤号；此处仅承载细节
				action: "处理中",
				phase: "progress",
				detail,
			}));
		};

		const tools = spec.tools.map((tool) =>
			toKernelTool(tool, { taskId: spec.taskId, tenant: spec.tenant, emitDetail }),
		);

		const { harness } = await AgentHarness.create(
			{
				session,
				models: this.runtime.models,
				model: this.runtime.model,
				systemPrompt: spec.systemPrompt,
				tools,
				// 白名单让工具在模型侧不可见；权限门在执行侧兜底。两层叠加。
				...(spec.activeTools === undefined
					? {}
					: { activeToolNames: [...spec.activeTools] }),
			},
			BACKGROUND_CONTEXT,
		);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const runner = new InProcessRunner(spec.sessionId, session, lane, spec, now);
		runnerRef = runner;

		// 接线：内核事件 → 平台事件
		for (const type of ["tool_start", "tool_update", "tool_end", "usage"] as const) {
			harness.events.on(type, ((event: KernelEvent) => {
				void runner.ingest(event);
			}) as never);
		}

		/**
		 * 接生成失败。
		 *
		 * 这条接线是必需的而非可选的：内核的生成失败（模型不可用、
		 * activeToolNames 含未注册工具、provider 错误）只通过
		 * `run_end{status:"failed"}` 上报，`lane.prompt()` 会正常 resolve。
		 * 不接就会把「模型一次都没调用、零产出」报成任务成功。
		 */
		harness.events.on("run_end", ((event: {
			status: "completed" | "aborted" | "failed";
			error?: { code?: string; message?: string; data?: unknown };
		}) => {
			if (event.status !== "failed") return;
			const code = event.error?.code ?? "unknown";
			const detail = event.error?.message ?? JSON.stringify(event.error?.data ?? {});
			runner.noteRunFailure(`内核运行失败（${code}）：${detail}`);
		}) as never);

		installGate(harness as never, spec.gate, runner, spec);

		return runner;
	}
}
