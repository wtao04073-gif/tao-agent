/**
 * 任务编排
 *
 * 职责：把「一次用户请求」变成一个有状态、可观测、可取消、可恢复的任务。
 *
 * 这一层是「执行中可继续对话」的落点 —— 任务与会话解耦后，用户提交任务
 * 即刻拿到 taskId 并可继续问别的，进度通过事件流回投。
 */

import {
	canTransition,
	isTerminal,
	TaskStatus,
	type Runner,
	type RunnerFactory,
	type RunnerSpec,
	type StoredTask,
	type TaskChange,
	type TaskEvent,
	type TaskEventListener,
	type TaskStore,
	type TenantContext,
} from "@tao/core";

export interface TaskRecord {
	readonly taskId: string;
	readonly tenant: TenantContext;
	/** 创建任务时的会话标识。恢复时用于判断能否续跑。 */
	readonly sessionId: string;
	/** 发起任务的场景卡 id（M5-3）。自由对话等非场景入口缺省。 */
	readonly scenarioId?: string;
	/** 所属多轮对话 id；缺省等于独立一轮。 */
	readonly conversationId?: string;
	/** 对话标题（首轮 query 摘要）。 */
	readonly title?: string;
	/** 所属长程任务（Job）id；临时对话缺省。 */
	readonly jobId?: string;
	readonly status: TaskStatus;
	/** 面向用户的失败/取消原因。终态非成功时必须有值。 */
	readonly reason?: string;
	/** 已产出的产物路径。**失败也保留** —— 验收要求保留中间物。 */
	readonly artifacts: readonly string[];
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** 非法状态迁移。单独成类型，便于调用方区分「业务拒绝」与「程序错误」。 */
export class IllegalTransition extends Error {
	readonly from: TaskStatus;
	readonly to: TaskStatus;

	constructor(from: TaskStatus, to: TaskStatus) {
		super(`非法的状态迁移：${from} → ${to}`);
		this.name = "IllegalTransition";
		this.from = from;
		this.to = to;
	}
}

/**
 * 未编号的事件草稿。
 *
 * `seq` / `eventId` 一律由编排器在入库时统一分配，因此草稿里不带 ——
 * 类型上挡住「调用方自带序号」这条路。条件类型是为了在联合类型上逐成员
 * 做 Omit，直接 `Omit<TaskEvent, ...>` 会把各分支的专有字段都丢掉。
 */
type EventDraft<E extends TaskEvent = TaskEvent> = E extends TaskEvent
	? Omit<E, "seq" | "eventId">
	: never;

export interface SubmitOptions {
	readonly tenant: TenantContext;
	readonly taskId: string;
	readonly sessionId: string;
	/** 场景卡 id。自由对话等非场景入口可省略。 */
	readonly scenarioId?: string;
	/** 多轮对话归属与标题（续聊轮次透传，落首条变更）。 */
	readonly conversationId?: string;
	readonly title?: string;
	/** 长程任务归属。 */
	readonly jobId?: string;
	/**
	 * 模型档位（M5-5）。显式选路入口：`"flagship"`（默认）或 `"lite"`，
	 * 透传到 factory.createRunner 的 RunnerSpec.tier，决定本次 run 用哪个模型。
	 * 这是最小的显式入口；按场景卡自动分档留待后续，不在此做隐式推断。
	 */
	readonly tier?: RunnerSpec["tier"];
	readonly prompt: string;
	readonly systemPrompt: string;
	readonly tools: RunnerSpec["tools"];
	readonly gate: RunnerSpec["gate"];
	readonly activeTools?: readonly string[];
	/** 多轮续聊时本轮之前的历史问答。 */
	readonly history?: RunnerSpec["history"];
    readonly inputReferences?: RunnerSpec["inputReferences"];
	/** 本次运行注入的技能（智能体挂载的技能 + 本次显式选择的技能）。 */
	readonly skills?: RunnerSpec["skills"];
}

/**
 * 任务编排器。
 *
 * 一期是进程内实现（单机 Compose 私有化部署的形态）。分布式调度、
 * 并发配额、租约留到 M2 —— 但状态机与事件流的契约现在就定下来，
 * 因为它们是跨形态共用的部分。
 */
export class TaskOrchestrator {
	private readonly tasks = new Map<string, TaskRecord>();
	private readonly runners = new Map<string, Runner>();
	private readonly listeners = new Set<TaskEventListener>();
	/** 每个任务的事件缓冲，供断线重连后按 seq 拉增量。 */
	private readonly eventLog = new Map<string, TaskEvent[]>();
	/**
	 * 每个任务已分配到的最大 seq。
	 *
	 * 不复用 `eventLog` 的长度：一旦日志将来做裁剪（只留最近 N 条），
	 * 长度就会回退，而 seq 一旦回退，`events(afterSeq)` 与 SSE 的
	 * `Last-Event-ID` 就会把新事件误判成「客户端已收到」而永久漏发。
	 */
	private readonly seqCursor = new Map<string, number>();
	private readonly factory: RunnerFactory;
	private readonly now: () => number;
	/**
	 * 可选的持久化存储。给了就把变更与事件落盘、支持 {@link TaskOrchestrator.recover}；
	 * 不给就是纯内存编排器（测试与开发态）。
	 */
	private readonly store: TaskStore | undefined;
	/**
	 * 事件 / 产物等**非状态机关键**持久化失败时的告警回调（磁盘满、只读文件系统等）。
	 *
	 * 这类失败只告警、不中断任务：内存事件日志与内存态照常推进，SSE / UI 不受影响。
	 * 没注入时退化为写 stderr，绝不静默 —— Runner 的 publish 会吞掉监听器异常，
	 * 若不在编排器内显式上报，落盘失败将无任何痕迹。
	 */
	private readonly onPersistenceError: ((error: Error, taskId: string) => void) | undefined;

	constructor(
		factory: RunnerFactory,
		options: {
			now?: () => number;
			store?: TaskStore;
			onPersistenceError?: (error: Error, taskId: string) => void;
		} = {},
	) {
		this.factory = factory;
		this.now = options.now ?? (() => Date.now());
		this.store = options.store;
		this.onPersistenceError = options.onPersistenceError;
	}

	/**
	 * 上报非状态机关键的持久化失败，保证不静默且不阻断调用方的内存态推进。
	 *
	 * 本方法**自身保证不抛**：ingest 的事件落盘 catch 会调用它，Runner 的
	 * publish 会吞掉监听器抛出的异常 —— 若注入的 onPersistenceError 自己
	 * 抛错，异常会从 ingest 冒泡出监听器，后续 fanout 与 tool_decision 派生
	 * 的 AWAIT_CONFIRM 转换全部被跳过，任务会停在错误状态。因此告警回调的
	 * 异常必须在此隔离：回调抛错时退化为 stderr 记录；stderr 理论上也可能
	 * 抛（极端 IO 故障），再用最外层兜底吞掉。
	 */
	private reportPersistenceError(error: unknown, taskId: string): void {
		const err = error instanceof Error ? error : new Error(String(error));
		try {
			if (this.onPersistenceError !== undefined) {
				try {
					this.onPersistenceError(err, taskId);
				} catch (callbackError) {
					// 告警实现自身故障：退化为 stderr，不能让它中断业务控制流
					this.writePersistenceAlert(
						`[持久化] 任务 ${taskId} 事件/产物落盘失败：${err.message}；且告警回调抛错：${
							callbackError instanceof Error ? callbackError.message : String(callbackError)
						}\n`,
					);
				}
			} else {
				this.writePersistenceAlert(
					`[持久化] 任务 ${taskId} 事件/产物落盘失败：${err.message}\n`,
				);
			}
		} catch {
			// 兜底：连 stderr 都写失败时也不能让告警路径抛出
		}
	}

	/** stderr 告警单独成方法，集中表达「此处任何异常都由调用方兜底」。 */
	private writePersistenceAlert(message: string): void {
		process.stderr.write(message);
	}

	/** 订阅全部任务的事件。返回取消订阅函数。 */
	subscribe(listener: TaskEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * 从持久化存储恢复任务到内存（进程重启后调用一次）。
	 *
	 * 恢复语义见 [M5-1](../../../docs/M5.md)：
	 *  - 终态与已经中断的任务原样恢复；
	 *  - **QUEUED/RUNNING/AWAIT_CONFIRM/EXCEEDED 改写为 INTERRUPTED** —— 执行器随旧进程消失，会话上下文也丢了，
	 *    恢复成 RUNNING 是没有执行器的僵尸态；用户可从检查点重试。
	 *
	 * 恢复**不重建 Runner**（无法续跑会话），只恢复可读的任务列表与事件历史，
	 * 并为每个任务重建事件日志与 seq 游标。Runner 在用户重试时由 factory 新建。
	 *
	 * @returns 被标记为 INTERRUPTED 的任务 id（供启动日志/通知用）
	 */
	recover(): readonly string[] {
		if (this.store === undefined) return [];
		// listAll 仅限此处启动恢复使用，业务读必须走按租户的 list
		const all = this.store.listAll();
		const interrupted: string[] = [];
		for (const stored of all) {
			const events = this.store.events(stored.taskId);
			this.eventLog.set(stored.taskId, [...events]);
			const eventMaxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
			// 游标必须取事件流与变更流的最大 seq，不能只看事件流：appendEvent
			// 是 best-effort（磁盘满等只告警不阻断），可能存在「同 seq 的状态
			// 变更已落盘、事件也已实时 fanout 给客户端，但事件流落盘失败」的
			// 缺口，此时事件流最大 seq 小于真实已分配过的 seq。只按事件流恢复
			// 游标，就会为 RUNNING→INTERRUPTED 再次分配已使用的序号，携带该
			// Last-Event-ID 重连的客户端会把恢复事件按「已收过」过滤掉，变更流
			// 也出现重复 seq。变更流对状态事件是关键落盘，其最大 seq 即「真正
			// 已分配过」的下界。
			//
			// eventLog 仅由事件流重建，故其长度可能小于游标（中间有未落盘事件）。
			// 这是允许的：游标只决定「下一个 seq」，缺号事件无法补造也不应补造
			// （客户端本就没收到），只要新事件 seq 严格大于任何已发过的号即可；
			// events(afterSeq) 与 SSE 按数值单向过滤，缺号不影响正确性。
			const changeMaxSeq = this.store.maxChangeSeq(stored.taskId);
			const maxSeq = Math.max(eventMaxSeq, changeMaxSeq);
			this.seqCursor.set(stored.taskId, maxSeq);

			if (!isTerminal(stored.status) && stored.status !== TaskStatus.Interrupted) {
				// 落一条 RUNNING → INTERRUPTED 的变更，让恢复结果也持久化，
				// 下次重启不会重复判定
				const at = this.now();
				const reason = "服务重启，执行上下文已失效；请新建关联原任务的重试";
				const recovered: TaskRecord = {
					...stored,
					status: TaskStatus.Interrupted,
					reason,
					updatedAt: at,
				};
				this.tasks.set(stored.taskId, recovered);
				// 这条变更同时是一条 status 事件，必须走统一入库路径 ingest：
				// 它会基于上面设置的 maxSeq 游标分配 seq=maxSeq+1，把事件写入
				// 事件流、把变更写入变更流，并把 seqCursor 推进到该序号。
				// 三者缺一不可 —— 只写变更不写事件，SSE 重连永远收不到
				// RUNNING→INTERRUPTED，且游标停在 maxSeq 会让后续事件复用同一序号。
				// 不调 emitStatus：恢复期间没有订阅者，也不应借 fanout 重放 SSE。
				// best-effort：单任务落盘异常不应中断整批恢复（游标与内存事件已就绪）。
				this.ingest(
					stored.taskId,
					{
						taskId: stored.taskId,
						tenant: stored.tenant,
						at,
						type: "status",
						from: stored.status,
						to: TaskStatus.Interrupted,
						reason,
					},
					{ statusPersistence: "best-effort" },
				);
				interrupted.push(stored.taskId);
			} else {
				this.tasks.set(stored.taskId, { ...stored });
			}
		}
		return interrupted;
	}

	get(taskId: string): TaskRecord | undefined {
		return this.tasks.get(taskId);
	}

	/** 取某任务的事件（可指定从哪个 seq 之后开始，用于断线重连）。 */
	events(taskId: string, afterSeq = 0): readonly TaskEvent[] {
		return (this.eventLog.get(taskId) ?? []).filter((e) => e.seq > afterSeq);
	}

    /** 等待确认/预算的任务仍持有执行快照，部署配置切换前也必须计入。 */
    get pendingTaskIds(): readonly string[] {
        return [...this.tasks.values()].filter(t=>['QUEUED','RUNNING','AWAIT_CONFIRM','EXCEEDED'].includes(t.status)).map(t=>t.taskId);
    }

	list(tenant: TenantContext): readonly TaskRecord[] {
		// 租户隔离：绝不跨租户返回。一期虽是单租户，但边界从现在就守住
		return [...this.tasks.values()].filter(
			(t) => t.tenant.tenantId === tenant.tenantId && t.tenant.workspaceId === tenant.workspaceId,
		);
	}

	/**
	 * 提交任务。
	 *
	 * **立即返回**，不等执行完成 —— 这是「执行中可继续对话」的前提。
	 * 执行在后台进行，进度通过事件流回投。
	 */
	async submit(options: SubmitOptions): Promise<TaskRecord> {
		if (this.tasks.has(options.taskId)) {
			throw new Error(`任务 ${options.taskId} 已存在`);
		}

		const at = this.now();
		const record: TaskRecord = {
			taskId: options.taskId,
			tenant: options.tenant,
			sessionId: options.sessionId,
			...(options.scenarioId === undefined ? {} : { scenarioId: options.scenarioId }),
			...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
			...(options.title === undefined ? {} : { title: options.title }),
			...(options.jobId === undefined ? {} : { jobId: options.jobId }),
			status: TaskStatus.Queued,
			artifacts: [],
			createdAt: at,
			updatedAt: at,
		};
		this.tasks.set(options.taskId, record);
		this.eventLog.set(options.taskId, []);
		this.seqCursor.set(options.taskId, 0);
		// 变更随首条状态事件一起落盘（见 emitStatus），先于事件对外发送。
		// 首事件落盘失败保持原有语义：submit 直接失败（此时还未创建 Runner，
		// 不会留下无执行器的持久化任务）
		await this.emitStatus(record, null, TaskStatus.Queued);

		let runner: Runner;
		try {
			runner = await this.factory.createRunner({
				tenant: options.tenant,
				taskId: options.taskId,
				sessionId: options.sessionId,
				systemPrompt: options.systemPrompt,
				tools: options.tools,
				gate: options.gate,
				...(options.activeTools === undefined ? {} : { activeTools: options.activeTools }),
				// 档位显式透传；缺省由 Runner 侧回落旗舰（RunnerSpec.tier 默认）
				...(options.tier === undefined ? {} : { tier: options.tier }),
				...(options.history === undefined ? {} : { history: options.history }),
                ...(options.inputReferences === undefined ? {} : { inputReferences: options.inputReferences }),
				...(options.skills === undefined ? {} : { skills: options.skills }),
			});
		} catch (error) {
			// QUEUED 记录此刻已落内存并落盘，而 runners 中没有执行器。
			// 必须补偿：把任务迁移到 FAILED 终态，否则它会以 QUEUED 永久残留，
			// 重启恢复也原样保留，且没有任何入口会再次为它创建 Runner。
			await this.failAfterCreateRunnerError(options.taskId, error);
			throw error;
		}
		this.runners.set(options.taskId, runner);

		// Runner 的事件转投给编排器的订阅者，并落到事件日志。
		// Runner 有自己从 1 开始的序号空间，直接入库会与状态事件的序号撞车，
		// 因此这里统一重新编号（见 ingest）
		runner.subscribe(async (event) => {
			// 瞬时事件（流式增量 seq=0）：只实时 fanout，不进事件日志、不落盘、
			// 不推进 seq 游标、不触发派生状态迁移。断线/轮询不补发，由定稿事件补全。
			if (event.seq === 0) {
				await this.fanout(event);
				return;
			}
			// ingest 内部已把「内存事件日志推进」与「落盘」解耦：磁盘写失败只经
			// onPersistenceError 告警，不抛错。这样 Runner 的 publish 不会因监听器
			// 异常吞掉后续处理，fanout 与派生状态迁移也不会被落盘失败跳过。
			const stamped = this.ingest(options.taskId, event);
			// 先投递本事件再处理派生状态：派生出的状态事件 seq 更大，若晚于它
			// 送达，客户端的重连锚点（Last-Event-ID / afterSeq）就会停在更大的
			// 序号上，本事件从此再也拉不到
			await this.fanout(stamped);
			// 权限门要求确认时，任务转入 AWAIT_CONFIRM
			if (stamped.type === "tool_decision" && stamped.decision === "await_confirm") {
				await this.transition(options.taskId, TaskStatus.AwaitConfirm, stamped.reason);
			}
			if (stamped.type === "artifact") {
				const withArtifact = this.updateRecord(options.taskId, (r) => ({
					...r,
					artifacts: [...r.artifacts, stamped.artifactId],
				}));
				// 产物追加也进变更流（状态不变，仅累积 artifacts），
				// 否则重启后当前态的产物列表会丢。产物落盘失败同样只告警不中断。
				try {
					this.store?.appendChange({
						taskId: options.taskId,
						tenant: withArtifact.tenant,
						sessionId: withArtifact.sessionId,
						seq: stamped.seq,
						at: this.now(),
						from: withArtifact.status,
						to: withArtifact.status,
						artifacts: [stamped.artifactId],
					});
				} catch (error) {
					this.reportPersistenceError(error, options.taskId);
				}
			}
		});

		return this.tasks.get(options.taskId) as TaskRecord;
	}

	/**
	 * createRunner 失败后的补偿：把已落盘的 QUEUED 任务迁移到 FAILED 终态。
	 *
	 * 不删除记录而是改为 FAILED —— 终态任务重启不会复活，审计上也能看到失败原因。
	 * 迁移本身的落盘若仍失败（如磁盘满），记录保留在内存 FAILED 态并尽力告警，
	 * 不覆盖原始的 createRunner 错误。
	 */
	private async failAfterCreateRunnerError(taskId: string, cause: unknown): Promise<void> {
		const reason = `执行器创建失败：${cause instanceof Error ? cause.message : String(cause)}`;
		try {
			await this.transition(taskId, TaskStatus.Failed, reason);
		} catch (persistError) {
			this.reportPersistenceError(persistError, taskId);
		}
	}

	/**
	 * 执行一个已提交的任务。
	 *
	 * 与 submit 分开是刻意的：submit 立即返回让用户能继续对话，
	 * run 由调度器在有执行位时调用。一期直接串行调用。
	 */
	async run(taskId: string, prompt: string, userText?: string): Promise<TaskRecord> {
		const runner = this.runners.get(taskId);
		if (runner === undefined) throw new Error(`任务 ${taskId} 没有对应的 Runner`);

		await this.transition(taskId, TaskStatus.Running);
		try {
			await runner.prompt(prompt, userText);
			const current = this.tasks.get(taskId) as TaskRecord;
			// 若执行过程中已进入终态（例如被取消），不再覆盖
			if (current.status === TaskStatus.Running) {
				await this.transition(taskId, TaskStatus.Succeeded);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			// 失败保留已产出的中间物（验收要求），只改状态不清 artifacts
			if (![TaskStatus.Exceeded, TaskStatus.Interrupted].includes((this.tasks.get(taskId) as TaskRecord).status as "EXCEEDED" | "INTERRUPTED") && !isTerminal((this.tasks.get(taskId) as TaskRecord).status)) await this.transition(taskId, TaskStatus.Failed, reason);
		}
		return this.tasks.get(taskId) as TaskRecord;
	}

	/**
	 * 在执行期间插入消息。
	 *
	 * 口径：**已插入，将在当前步骤完成后送达** —— 内核 steering 永不打断
	 * 执行中的工具。承诺打断是无法兑现的。
	 */
	async steer(taskId: string, text: string): Promise<void> {
		const runner = this.runners.get(taskId);
		if (runner === undefined) throw new Error(`任务 ${taskId} 没有对应的 Runner`);
		await runner.steer(text);
	}

	/** 取消任务。这是唯一能中止进行中工具的手段。 */
	async cancel(taskId: string, reason: string): Promise<TaskRecord> {
		const record = await this.transition(taskId, TaskStatus.Cancelled, reason);
        const runner = this.runners.get(taskId);
        if (runner !== undefined) await runner.abort(reason);
        return record;
	}

	/** 用户确认高危动作后继续执行。 */
	async confirm(taskId: string, actionId?: string): Promise<TaskRecord> {
		const runner = this.runners.get(taskId);
		if (!runner?.confirmAction) throw new Error("执行上下文不可恢复，请重新提交任务");
		const actions = runner.listActions?.() ?? [];
		const pending = actions.filter(a => a.status === "pending");
		const chosen = actionId ? actions.find(a => a.actionId === actionId) : pending.length === 1 ? pending[0] : actions.length === 1 ? actions[0] : undefined;
		if (!chosen) throw new Error("请指定唯一的待确认 actionId");
		if (chosen.status === "approved" || chosen.status === "executed") return this.tasks.get(taskId) as TaskRecord;
		if (chosen.status !== "pending" || chosen.expiresAt <= this.now()) throw new Error("动作已过期或不再等待确认");
		await this.transition(taskId, TaskStatus.Running);
		try { await runner.confirmAction(chosen.actionId); }
		catch (error) { await this.transition(taskId, TaskStatus.Failed, "授权失败，动作未执行"); throw error; }
		return this.tasks.get(taskId) as TaskRecord;
	}

	/** 用户拒绝高危动作 → 取消任务。 */
	async reject(taskId: string, reason: string): Promise<TaskRecord> {
		return this.cancel(taskId, reason);
	}

	/** 释放任务占用的资源。 */
	async close(taskId: string): Promise<void> {
		const runner = this.runners.get(taskId);
		if (runner !== undefined) {
			await runner.close();
			this.runners.delete(taskId);
		}
	}

	/**
	 * 状态迁移。
	 *
	 * 非法迁移**抛异常而非静默忽略** —— 静默忽略会让「已完成的任务被
	 * 重复结算」这类 bug 潜伏很久才暴露。
	 */
	private async transition(
		taskId: string,
		to: TaskStatus,
		reason?: string,
	): Promise<TaskRecord> {
		const record = this.tasks.get(taskId);
		if (record === undefined) throw new Error(`任务 ${taskId} 不存在`);

		if (record.status === to) return record; // 幂等
		if (!canTransition(record.status, to)) {
			throw new IllegalTransition(record.status, to);
		}

		const from = record.status;
		const updated = this.updateRecord(taskId, (r) => ({
			...r,
			status: to,
			...(reason === undefined ? {} : { reason }),
		}));
		try {
			await this.emitStatus(updated, from, to, reason, "critical");
		} catch (error) {
			// 关键状态迁移落盘失败（磁盘满 / 只读文件系统等）：不能让任务停在
			// 一个磁盘上并不存在、重启后会回退的状态上。内存态改写为可诊断的
			// FAILED 并上报，随后把异常抛给调用方（run 的 catch 对 FAILED 是
			// 幂等的，不会再二次迁移或刷屏）。
			const detail = error instanceof Error ? error.message : String(error);
			const failed = this.updateRecord(taskId, (r) => ({
				...r,
				status: TaskStatus.Failed,
				reason: `状态迁移 ${from} → ${to} 落盘失败：${detail}`,
			}));
			this.reportPersistenceError(error, taskId);
			// 尽力通知订阅者任务已失败：事件以 best-effort 入库（磁盘此刻可能
			// 仍不可写，但内存事件日志与 fanout 不受影响），不让这里再抛错
			try {
				await this.emitStatus(
					failed,
					from,
					TaskStatus.Failed,
					failed.reason,
					"best-effort",
				);
			} catch {
				// 通知失败也不能掩盖原始的落盘异常
			}
			throw error;
		}
		return updated;
	}

	private updateRecord(taskId: string, patch: (r: TaskRecord) => TaskRecord): TaskRecord {
		const current = this.tasks.get(taskId);
		if (current === undefined) throw new Error(`任务 ${taskId} 不存在`);
		const updated = { ...patch(current), updatedAt: this.now() };
		this.tasks.set(taskId, updated);
		return updated;
	}

	/**
	 * @param persistence status 变更落盘的失败策略。
	 * - `"critical"`（默认）：用于状态机迁移（含 submit 的 QUEUED 首事件），
	 *   变更流必须落盘，失败要抛出 —— submit 时直接失败（此时还没 Runner，
	 *   不留僵尸），运行中迁移失败则由 transition 改写为可诊断的 FAILED；
	 * - `"best-effort"`：用于重启恢复补写的 INTERRUPTED 事件、以及关键迁移
	 *   失败后向订阅者补发的 FAILED 通知，失败只告警不抛出。
	 */
	private async emitStatus(
		record: TaskRecord,
		from: TaskStatus | null,
		to: TaskStatus,
		reason?: string,
		persistence: "critical" | "best-effort" = "critical",
	): Promise<void> {
		const event = this.ingest(
			record.taskId,
			{
				taskId: record.taskId,
				tenant: record.tenant,
				at: this.now(),
				type: "status",
				from,
				to,
				...(reason === undefined ? {} : { reason }),
			},
			{ statusPersistence: persistence },
		);
		await this.fanout(event);
	}

	/**
	 * 给事件打上编排器的序号并落入事件日志。
	 *
	 * 进入 `eventLog` 的**唯一**入口。状态事件与 Runner 事件必须共用同一个
	 * 序号空间：Runner 自己的序号从 1 开始，与状态事件混在一条日志里会出现
	 * 重复且倒退的 seq，而 `events(afterSeq)` 和 SSE 的 `Last-Event-ID` 都是
	 * 按数值单向过滤的 —— 序号一倒退，倒退区间内的事件就永久拉不到。
	 *
	 * Runner 原有的 seq / eventId 在此被丢弃（`TaskEvent` 上二者是 readonly，
	 * 故以展开方式构造新对象）。Runner 侧序号只用于其内部排序与回放比对，
	 * 跨层后不再有意义。
	 *
	 * @param options.statusPersistence status 事件对应**变更流**落盘的失败策略：
	 * - `"critical"`（默认）用于状态机迁移 —— 变更流落盘失败必须抛出，交给
	 *   transition 把任务转入可诊断的 FAILED，不能让磁盘态落后于内存态；
	 * - `"best-effort"` 用于提交瞬间的 QUEUED 首事件与重启恢复 —— 只告警不抛。
	 *
	 * 事件流（appendEvent）的落盘失败一律只告警：它影响的是断线重连的历史，
	 * 不应阻断内存事件日志、fanout 以及 await_confirm / artifact 等派生处理。
	 */
	private ingest(
		taskId: string,
		draft: EventDraft,
		options: { statusPersistence?: "critical" | "best-effort" } = {},
	): TaskEvent {
		const statusPersistence = options.statusPersistence ?? "critical";
		const seq = (this.seqCursor.get(taskId) ?? 0) + 1;
		this.seqCursor.set(taskId, seq);

		const event = {
			...draft,
			seq,
			// 序号在任务内唯一，拼上 taskId 后全局唯一，且可复现便于回放比对
			eventId: `${taskId}-${seq}`,
		} as TaskEvent;

		// 内存事件日志先推进：它是 SSE / events() 的唯一来源，绝不能被磁盘拖垮
		const log = this.eventLog.get(taskId) ?? [];
		log.push(event);
		this.eventLog.set(taskId, log);

		// 状态事件同时是一条持久化变更（当前态折叠自这条流）
		if (event.type === "status") {
			const r = this.tasks.get(taskId);
			if (r !== undefined) {
				try {
					this.persistChange(
						r,
						event.from,
						seq,
						event.reason === undefined ? undefined : { reason: event.reason },
					);
				} catch (error) {
					if (statusPersistence === "critical") throw error;
					this.reportPersistenceError(error, taskId);
				}
			}
		}

		// 事件流落盘（含 step/usage 等非状态事件），供重启后断线重连。
		// 失败只告警：事件已在内存日志里，fanout 与派生状态迁移照常进行。
		try {
			this.store?.appendEvent(event);
		} catch (error) {
			this.reportPersistenceError(error, taskId);
		}
		return event;
	}

	/**
	 * 把一次任务变更追加到持久化变更流。
	 *
	 * 变更序号取自对应状态事件的 seq（事件溯源：当前态是这条流的折叠）。
	 * 首条（from=null）走 create，幂等挡住重复创建；其余追加。
	 */
	private persistChange(
		record: TaskRecord,
		from: TaskStatus | null,
		seq: number,
		extra?: { reason?: string; artifacts?: readonly string[] },
	): void {
		const change: TaskChange = {
			taskId: record.taskId,
			tenant: record.tenant,
			sessionId: record.sessionId,
			// 场景/对话归属与标题是任务静态属性，只随首条（create）变更落盘
			...(from === null && record.scenarioId !== undefined ? { scenarioId: record.scenarioId } : {}),
			...(from === null && record.conversationId !== undefined
				? { conversationId: record.conversationId }
				: {}),
			...(from === null && record.title !== undefined ? { title: record.title } : {}),
			...(from === null && record.jobId !== undefined ? { jobId: record.jobId } : {}),
			seq,
			at: record.updatedAt,
			from,
			to: record.status,
			...(extra?.reason === undefined ? {} : { reason: extra.reason }),
			...(extra?.artifacts === undefined || extra.artifacts.length === 0
				? {}
				: { artifacts: extra.artifacts }),
		};
		if (from === null) this.store?.create(change);
		else this.store?.appendChange(change);
	}

	/** 把事件投给所有订阅者。单个订阅者异常不影响其他订阅者与任务执行。 */
	private async fanout(event: TaskEvent): Promise<void> {
		for (const listener of this.listeners) {
			try {
				await listener(event);
			} catch {
				// 事件消费方的问题不应中断任务 —— 进度上报失败不等于任务失败
			}
		}
	}
}
