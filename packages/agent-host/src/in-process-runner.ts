import { toolSummary } from "@tao/core";
import { ResponseStream } from "./response-stream.ts";
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
 *     [Spike 5](../../../spikes/05-subagent-parallel/) 修正了 M0 的表述：
 *     同 Session 的多 lane 只在**存储读-改-写**上排队，模型调用本来就并发。
 *     所以独占 Session 是为了减少写入争用、故障隔离与独立检查点。
 *  3. **权限门 fail-closed** —— `before_tool` 抛异常时内核会拒绝执行，
 *     所以此处不吞异常、不做「出错就放行」的兜底。
 */

import { Confirmations } from "./confirmations.ts";
import { statSync } from "node:fs";
import { basename } from "node:path";
import {
	AgentHarness,
	type AgentHarnessTool,
	type AgentLane,
	type Session,
} from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { createModels, type Model, type Api } from "@earendil-works/pi-ai";
import type {
	ChatTurn,
	PermissionGate,
	PlatformTool,
	Runner,
	RunnerFactory,
	RunnerSpec,
	TaskEvent,
	ToolDecision,
	UsageRecord,
} from "@tao/core";
import {
	EventSequencer,
	type KernelEvent,
	StepCounter,
	translate,
	type TranslatorContext,
} from "./event-translator.ts";
import { TenantTaskGate, type ReleaseReservation } from "./tenant-gate.ts";

/** 宿主运行所需的外部依赖。全部注入 —— 便于测试与私有化部署替换。 */
export interface HostRuntime {
	saveAction?: (action: import("@tao/core").StoredAction) => void | Promise<void>;
	approvalTimeoutMs?: number;
	/** 创建一个独占的会话存储。一人一 Session 由调用方保证。 */
	createSession(sessionId: string): Promise<Session>;
	/** 模型清单与 provider。 */
	models: ReturnType<typeof createModels>;
	/**
	 * 默认（旗舰）模型。与 {@link HostRuntime.modelForTier} 二选一：
	 * 单模型装配继续给 model；多档位装配给 modelForTier。
	 */
	model?: Model<Api>;
	/**
	 * 按档位取模型（M5-5）。多档位时由它决定每次 run 用哪个模型；
	 * 省略则所有 run 都用 {@link HostRuntime.model}。
	 */
	modelForTier?: (tier: "flagship" | "lite") => Model<Api>;
	/**
	 * 出网前配额预检（M5-5）。在 Runner.prompt() 发起**第一次模型调用之前**
	 * 执行，知道租户与档位。返回 ok:false 时 prompt 直接抛错（编排器把任务转
	 * FAILED），**零字节出网、零模型消耗**。返回 undefined 或 ok:true 放行。
	 */
	preflightModel?: (input: {
		tenant: RunnerSpec["tenant"];
		taskId: string;
		tier: "flagship" | "lite";
		/**
		 * 进入预检临界区时该租户**已预留但尚未结束**的在途任务数，含本次任务
		 * （等于 inflightTaskIds.length）。仅保留作计数便利；maxTasks 判定须以
		 * inflightTaskIds 与已落账 taskId 集合的**并集去重**为准，不能把它直接
		 * 加到 totals.taskCount 上 —— 已落首轮用量的在途任务会被重复计数。
		 */
		inflightCount: number;
		/**
		 * 临界区时刻「此前在途任务 ∪ 本次任务」的 taskId 集合（含本次 taskId）。
		 * maxTasks 须比较「本周期已落账 usage 的 taskId 集合 ∪ 本集合」的大小，
		 * 使已落账但尚未结束的任务在两个集合里只算一次。
		 */
		inflightTaskIds: readonly string[];
	}) => Promise<import("@tao/core").QuotaVerdict | undefined>;
	/** 取当前时间。注入以便测试可控。 */
	now?: () => number;
	/**
	 * 用量落账回调。
	 *
	 * 挂在这里而不是让编排层订阅 `usage` 事件，是因为**计量不能漏**：
	 * 事件订阅者的异常被适配层刻意吞掉（进度上报失败不该影响执行），
	 * 那套宽容策略用在计量上就变成了静默丢账。这里单独走一条路径，
	 * 失败会被记录成任务级告警而非静默忽略。
	 *
	 * 仍然不让它中断执行：模型调用已经发生、token 已经烧掉，
	 * 此时中断任务既救不回钱也白费已完成的工作。
	 */
	meter?: (record: UsageRecord) => void | Promise<void>;
	/** 落账失败的告警回调。默认不处理 —— 但**不静默**：调用方应当接上。 */
	onMeterError?: (error: Error, taskId: string) => void;
}

/** 按产物扩展名推断 MIME；未知类型回退为通用二进制（不影响下载，仅用于展示）。 */
function mimeFor(fileName: string): string {
	const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
	const table: Record<string, string> = {
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		xls: "application/vnd.ms-excel",
		csv: "text/csv",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		doc: "application/msword",
		pdf: "application/pdf",
		pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		txt: "text/plain",
		json: "application/json",
	};
	return table[ext] ?? "application/octet-stream";
}

/**
 * 从工具结果里取出产物文件的绝对路径。
 *
 * 约定：办公类工具把产物路径放在 `details.outputPath`（office/doc 两套 toolset
 * 都这么返回）。不是所有工具都产文件（read_table/search_knowledge 等），
 * 取不到就返回 undefined —— 这些工具不产 artifact 事件。
 */
function extractOutputPath(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const p = (details as { outputPath?: unknown }).outputPath;
	return typeof p === "string" && p !== "" ? p : undefined;
}

/**
 * 从一条内核助手消息里抽取给用户看的纯文本。
 *
 * 助手 content 是块数组：text 块是回答，toolCall 块是工具调用（不是给用户的文字）。
 * content 也可能直接是字符串。工具调用回合（无 text 块）返回空串，调用方据此跳过，
 * 避免把一次"仅调用工具、没有文字"的回合误当成空回答推给前端。
 */
function assistantText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block !== null &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			const t = (block as { text: string }).text.trim();
			if (t !== "") parts.push(t);
		}
	}
	return parts.join("\n\n").trim();
}

/**
 * 把多轮历史与本轮问题拼成一段提示。
 *
 * 不依赖内核的会话复用（每轮独立 Session、且内存 Session 重启即失），而是把
 * 过往问答以清晰的角色分隔写进本轮输入。只要历史事件还在，进程重启后也能续聊。
 * 无历史时原样返回本轮问题。
 */
function withHistory(text: string, history: readonly ChatTurn[] | undefined): string {
	if (!history || history.length === 0) return text;
	const lines: string[] = ["以下是我们之前的对话，请结合上下文回答最后的新问题。", ""];
	for (const turn of history) {
		lines.push("用户：" + turn.user);
		lines.push("助手：" + turn.assistant);
		lines.push("");
	}
	lines.push("新问题：" + text);
	return lines.join("\n");
}

/** 把平台工具适配成内核工具。参数 schema 与执行签名在此转换。 */
function toKernelTool(
	tool: PlatformTool,
	ctx: {
		taskId: string;
		tenant: RunnerSpec["tenant"];
		emitDetail: (detail: string) => void;
		emitArtifact: (path: string, details?: unknown) => Promise<void>;
	},
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
			// 成功产出文件时发 artifact 事件（失败结果不发，避免把坏文件当可交付物）。
			// 这是「取产物」全链路的数据源：编排器据此累积任务产物、前端据此给下载入口。
			if (outcome.isError !== true) {
				const outputPath = extractOutputPath(outcome.details);
				if (outputPath !== undefined) await ctx.emitArtifact(outputPath, outcome.details);
				const paths = (outcome.details as { outputPaths?: unknown } | undefined)?.outputPaths;
				if (Array.isArray(paths)) for (const path of paths) if (typeof path === "string") await ctx.emitArtifact(path);
			}
			return {
				content: [{ type: "text", text: outcome.text }],
				details: outcome.details,
				...(outcome.isError === true ? { isError: true } : {}),
			} as Awaited<ReturnType<AgentHarnessTool<undefined>["execute"]>>;
		},
	};
}

class InProcessRunner implements Runner {
	readonly confirmations: Confirmations;
	private readonly listeners = new Set<(event: TaskEvent) => void | Promise<void>>();
	private readonly steps = new StepCounter();
 private delivery:Promise<void>=Promise.resolve();
 responseStream?:ResponseStream;
 private responseStep=0;
 async responsePhase(phase:"started"|"progress"|"finished"|"failed",detail?:string):Promise<void> {
  if(phase==="started")this.responseStep=this.steps.start("model-response");
  await this.emit(base=>({...base,type:"step",step:this.responseStep,action:"模型请求与响应",phase,...(detail?{detail}:{})}));
 }
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
	/**
	 * 进入「出网前配额预检临界区」并预留任务席位（工厂按本 runner 的租户/档位
	 * 绑定）；undefined 表示该部署无配额、不预检。返回值是席位释放函数。
	 */
	private enterPreflight: (() => Promise<ReleaseReservation | undefined>) | undefined;

	constructor(
		sessionId: string,
		session: Session,
		lane: AgentLane,
		spec: RunnerSpec,
		now: () => number,
		model: string,
		enterPreflight?: () => Promise<ReleaseReservation | undefined>,
		confirmations?: Confirmations,
	) {
		this.confirmations = confirmations ?? new Confirmations(spec.taskId, spec.tenant, () => {});
		this.enterPreflight = enterPreflight;
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
			model,
		};
	}

	/** 发布一个平台事件。监听器异常不影响其他监听器，也不影响执行。 */
    private publish(event:TaskEvent):Promise<void> {
        this.delivery=this.delivery.then(async()=>{for(const listener of this.listeners){try{await listener(event);}catch{/* 展示失败不改变模型执行结果 */}}});
        return this.delivery;
    }

	/** 消费一个内核事件。由工厂在装配时接线。 */
	async ingest(event: KernelEvent): Promise<void> {
		for (const translated of translate(event, this.translatorContext, this.steps)) {
			await this.publish(translated);
		}
	}

	/**
	 * 发布一个**瞬时**事件（流式增量）：seq 固定 0、eventId 每次唯一，
	 * 供编排器识别后只实时 fanout、不进事件日志/不落盘、不参与断线补发。
	 */
	async emitTransient(event: Omit<TaskEvent, "seq" | "eventId" | "taskId" | "tenant" | "at">): Promise<void> {
		await this.publish({
			...(event as object),
			eventId: `${this.spec.taskId}-delta-${this.translatorContext.now()}-${Math.random().toString(36).slice(2, 8)}`,
			seq: 0,
			taskId: this.spec.taskId,
			tenant: this.spec.tenant,
			at: this.translatorContext.now(),
		} as TaskEvent);
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

	/**
	 * 工具产出文件后发 artifact 事件。
	 *
	 * 大小取自文件系统；取不到（文件刚被移走等极端情况）按 0 计而不是抛错 ——
	 * 产物已生成，不该因展示字段拿不到而打断任务。`final` 恒为 true：平台的
	 * 办公工具一次性落最终文件，没有「流式草稿→定稿」两段式产物。
	 */
	async emitArtifact(absPath: string, details?: unknown): Promise<void> {
		const name = basename(absPath);
		let sizeBytes = 0;
		try {
			sizeBytes = statSync(absPath).size;
		} catch {
			sizeBytes = 0;
		}
		await this.emit((base) => ({
			...base,
			type: "artifact",
			// artifactId 用相对/绝对路径：下载接口按任务工作区解析它，取 basename 展示
			artifactId: absPath,
			name,
			mimeType: mimeFor(name),
            ...(typeof (details as { revisionSummary?: unknown } | undefined)?.revisionSummary === "string" ? { revisionSummary: (details as {revisionSummary:string}).revisionSummary } : {}),
			sizeBytes,
			final: true,
		}));
	}

	async prompt(text: string, rawUserText?: string): Promise<void> {
		this.assertOpen();
		this.runFailure = undefined;

		// 先落本轮用户原文（持久化、进事件流）：多轮历史重建与前端展示都依赖它。
		// 在模型调用前发，失败也已记录用户意图。
		if (rawUserText !== undefined && rawUserText.trim() !== "") {
			await this.emit((base) => ({
				...base,
				type: "user_message",
				text: rawUserText,
                ...(this.spec.inputReferences ? { references: this.spec.inputReferences } : {}),
				delivery: "queued_after_current_step",
			}));
		}

		/**
		 * 出网前配额闸（M5-5）。在第一次模型调用之前 await —— 超配额则直接
		 * 抛出、不触碰 lane.prompt，因此**零字节出网、零模型消耗**。这道闸
		 * 与 before_tool 闸共用同一份配额状态，但落点提前到生成之前，从而拦得住
		 * 「一次工具都不调、只生成长文本」的运行。
		 *
		 * 预检在**租户临界区**内执行并预留任务席位（见 TenantTaskGate）：同租户
		 * 并发 prompt 不会再共享过期用量快照，maxTasks 也不会被并发突破。临界区
		 * 在预检通过、席位预留后即释放，模型执行在锁外并发；席位在 finally 归还。
		 */
		let release: ReleaseReservation | undefined;
        await this.responsePhase("started","正在准备请求并等待模型响应");
		try {
			if (this.enterPreflight !== undefined) {
				release = await this.enterPreflight();
			}

			// 多轮续聊：每轮是独立 Session，把历史问答显式拼进本轮输入，模型才记得上文。
			await this.lane.prompt(withHistory(text, this.spec.history), [], BACKGROUND_CONTEXT);
			// 内核不会因生成失败而让 prompt reject，所以这里必须显式检查。
			// 抛出去让编排层把任务转入 FAILED —— 静默成功比报错难查得多。
			if (this.runFailure !== undefined) throw new Error(this.runFailure);
            await this.responsePhase("finished","本轮模型执行已结束");
        } catch(error) {
            await this.responsePhase("failed","本轮未完成，请查看任务状态与失败原因");
            throw error;
        } finally {
            this.responseStream?.close();
            await this.delivery;
			release?.();
		}
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

	listActions() { return this.confirmations.list(); }
	async confirmAction(actionId?: string): Promise<void> { await this.confirmations.approve(actionId); }

	async abort(reason: string): Promise<void> {
		this.assertOpen();
		await this.confirmations.cancel();
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
		await this.confirmations.cancel();
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
 gate: PermissionGate, runner: InProcessRunner, spec: RunnerSpec,
): void {
 harness.hooks.on("before_tool", (async (event: { toolCallId: string; toolName: string; args: unknown }) => {
  const args = structuredClone(event.args);
  const request = { toolName: event.toolName, args, tenant: spec.tenant, taskId: spec.taskId };
  let decision = await gate(request);
  if (decision.kind === "confirm") {
   const pending = await runner.confirmations.request(event.toolCallId, event.toolName, args, decision.reason);
   await runner.emit(base => ({ ...base, type: "tool_decision", toolName: event.toolName,
    decision: "await_confirm", reason: decision.kind === "confirm" ? decision.reason : "需要确认",
    toolCallId:event.toolCallId, inputSummary:toolSummary(args), actionId: pending.action.actionId, expiresAt: pending.action.expiresAt }));
   if (!await pending.decision) {
    runner.noteRunFailure("动作被拒绝、过期或取消，未执行");
    return { block: { reason: "动作未获得有效授权", terminate: true } };
   }
   // 在同一次工具调用中复核路径、输入版本及配额。仅本次参数的 confirm 可被消费。
   decision = await gate(request);
   if (decision.kind === "block") {
    await runner.confirmations.finish(pending.action.actionId, "invalidated");
   } else decision = { kind: "allow" };
  }
  await runner.emit(base => ({ ...base, type: "tool_decision", toolName: event.toolName,
   toolCallId:event.toolCallId,
   ...(decision.kind === "allow" ? {inputSummary:toolSummary(args)} : {}),
   decision: decision.kind === "allow" ? "allowed" : "blocked",
   ...(decision.kind === "allow" ? {} : { reason: decision.reason }) }));
  return decision.kind === "allow" ? undefined : { block: { reason: decision.reason } };
 }) as (event: never) => unknown);
 harness.hooks.on("after_tool", (async (event: { toolCallId: string; isError: boolean }) => {
  await runner.confirmations.completed(event.toolCallId, event.isError);
 }) as (event: never) => unknown);
}

/** 进程内 Runner 工厂。 */
export class InProcessRunnerFactory implements RunnerFactory {
	private readonly runtime: HostRuntime;
	/**
	 * 按租户串行化预检临界区并预留任务席位。所有 Runner 共享同一个门：
	 * 并发是否能突破 maxTasks，取决于门里是否有全部在途任务的计数。
	 */
	private readonly tenantGate = new TenantTaskGate();

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
			toKernelTool(tool, {
				taskId: spec.taskId,
				tenant: spec.tenant,
				emitDetail,
				emitArtifact: (path, details) => runnerRef?.emitArtifact(path, details) ?? Promise.resolve(),
			}),
		);

		// 按档位选本次运行的模型。多档位装配用 modelForTier，单模型装配回落到 model。
		// 整次 run 用同一模型：lane 配置在 run 内不按规划/执行轮动态切换，
		// 这样计量落账的模型名与实际调用永远一致，不会按错档位单价收费。
		const tier = spec.tier ?? "flagship";
		const selectedModel =
			this.runtime.modelForTier?.(tier) ??
			this.runtime.model ??
			(() => {
				throw new Error("模型运行时未提供任何模型（model / modelForTier 均缺省）");
			})();

		const { harness } = await AgentHarness.create(
			{
				session,
				models: this.runtime.models,
				model: selectedModel,
				systemPrompt: spec.systemPrompt,
				tools,
				// 用户选择的技能 → 内核原生 resources.skills：模型可见技能说明，
				// 命中使用场景时按指令正文执行。filePath 非文件时给稳定逻辑名。
				...(spec.skills && spec.skills.length > 0
					? {
							resources: {
								skills: spec.skills.map((s) => ({
									name: s.name,
									description: s.description,
									content: s.content,
									filePath: `skill:${s.name}`,
								})),
							},
						}
					: {}),
				// 白名单让工具在模型侧不可见；权限门在执行侧兜底。两层叠加。
				...(spec.activeTools === undefined
					? {}
					: { activeToolNames: [...spec.activeTools] }),
			},
			BACKGROUND_CONTEXT,
		);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		// 模型名取自本次实际选中的模型 —— 轻量档的用量必须按轻量档名入账，
		// 否则 estimateCost 按名查价会系统性错账（且测试不易发现）。
		const modelName = selectedModel.id;
		const runner = new InProcessRunner(
			spec.sessionId,
			session,
			lane,
			spec,
			now,
			modelName,
			this.runtime.preflightModel === undefined
				? undefined
				: () =>
						// 在租户临界区内预检并预留席位；在途 taskId 集合（含本次）
						// 由门注入，供 main.ts 与已落账 taskId 集合取并集去重判定。
						this.tenantGate.reserve(
							spec.tenant.tenantId,
							spec.taskId,
							async (inflightTaskIds) => {
							const verdict = await this.runtime.preflightModel?.({
								tenant: spec.tenant,
								taskId: spec.taskId,
								tier,
								inflightCount: inflightTaskIds.length,
								inflightTaskIds,
							});
							if (verdict !== undefined && !verdict.ok) {
								// 临界区内抛出 → 不预留席位，prompt 直接失败
								throw new Error(verdict.reason);
							}
						}),
			new Confirmations(spec.taskId, spec.tenant, this.runtime.saveAction ?? (() => {}), now, this.runtime.approvalTimeoutMs),
		);
		runnerRef = runner;

		// 接线：内核事件 → 平台事件
		for (const type of ["tool_start", "tool_update", "tool_end", "usage"] as const) {
			harness.events.on(type, ((event: KernelEvent) => {
				void runner.ingest(event);
			}) as never);
		}

		/**
		 * 接模型的最终文字回答 → assistant_message。
		 *
		 * 自由问答不产出文件，只能靠它把答案下发。message_end 对同一条助手消息
		 * 可能在不同路径各发一次，且一次任务有多轮（含工具回合），故按 entryId
		 * （缺失时按文本）在本 run 内去重；仅工具调用、无文字的回合不推。
		 */
		const emittedAssistant = new Set<string>();

        const stream=new ResponseStream({
            delta:(channel,messageId,delta,offset)=>{void runner.emitTransient({type:channel==="answer"?"assistant_delta":"thinking_delta",messageId,delta,offset} as never);},
            snapshot:(channel,messageId,text,complete)=>{void runner.emit(base=>({...base,type:"message_progress",messageId,channel,text,complete}));},
        });
        runner.responseStream=stream;
        harness.events.on("message_start",((event:{runId?:string;message?:{role?:string}})=>{
            if(event.message?.role==="assistant")stream.begin(event.runId);
        }) as never);
        harness.events.on("message_update",((event:{runId?:string;message?:{role?:string};frame?:{type?:string;delta?:string};event?:{type?:string;delta?:string}})=>{
            if(event.message?.role!=="assistant")return;
            const frame=event.frame??event.event;
            if(typeof frame?.delta!=="string" || !frame.delta)return;
            if(frame.type==="text_delta")stream.append(event.runId,"answer",frame.delta);
            if(frame.type==="thinking_delta")stream.append(event.runId,"thinking",frame.delta);
        }) as never);
        harness.events.on("message_end",((event:{runId?:string;entryId?:string;message?:{role?:string;content?:unknown;entryId?:string}})=>{
            const msg=event.message;if(msg?.role!=="assistant")return;
            const messageId=stream.end(event.runId),text=assistantText(msg.content);
            const key=event.entryId??msg.entryId??messageId;
            if(emittedAssistant.has(key))return;emittedAssistant.add(key);
            // 部分服务只提供最终思考块，不提供thinking_delta，同样保留可展示内容。
            if(Array.isArray(msg.content)) {
                const thinking=msg.content.filter(c=>c && c.type==="thinking" && typeof c.thinking==="string").map(c=>c.thinking).join("\n");
                if(thinking)void runner.emit(base=>({...base,type:"message_progress",messageId,channel:"thinking",text:thinking,complete:true}));
            }
            if(text)void runner.emit(base=>({...base,type:"assistant_message",messageId,text}));
        }) as never);

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
			runner.noteRunFailure(/rate.?limit|tpm|tokens?.*per.?min|too many|429|限流/i.test(detail+" "+code) ? "模型服务当前限流，本次未完成。请稍后重试；若持续出现，请检查模型服务配额。" : `内核运行失败（${code}）：${detail}`);
		}) as never);

		/**
		 * 接用量落账。
		 *
		 * 单独订阅一次 `usage`（不复用上面那条翻译用的订阅），因为两者的
		 * 失败语义相反：翻译失败只影响前端展示，落账失败影响收费。
		 * 复用同一条路径会让计量继承「异常被吞」的宽容策略。
		 *
		 * [Spike 6](../../../spikes/06-metering-breaker/) 确认 usage 是**逐轮**
		 * 上报的，且生成失败前已产生的 usage 不会回滚 —— 所以只要在这里
		 * 不做过滤，失败任务的消耗同样会入账（这是防白嫖的关键）。
		 */
		const meter = this.runtime.meter;
		if (meter !== undefined) {
			harness.events.on("usage", ((event: {
				row?: {
					usage?: {
						input?: number;
						output?: number;
						cacheRead?: number;
						cacheWrite?: number;
					};
				};
			}) => {
				const u = event.row?.usage;
				if (u === undefined) return;
				void (async () => {
					try {
						await meter({
							tenantId: spec.tenant.tenantId,
							workspaceId: spec.tenant.workspaceId,
							userId: spec.tenant.userId,
							taskId: spec.taskId,
							// 同上：模型名来自配置，不是内核事件
							model: modelName,
							inputTokens: u.input ?? 0,
							outputTokens: u.output ?? 0,
							cacheReadTokens: u.cacheRead ?? 0,
							cacheWriteTokens: u.cacheWrite ?? 0,
							at: now(),
						});
					} catch (error) {
						// 不静默：落账失败必须能被发现，否则账目差异无从追查。
						// 但也不中断执行 —— token 已经烧掉了，中断救不回钱
						this.runtime.onMeterError?.(
							error instanceof Error ? error : new Error(String(error)),
							spec.taskId,
						);
					}
				})();
			}) as never);
		}

		installGate(harness as never, spec.gate, runner, spec);

		return runner;
	}
}
