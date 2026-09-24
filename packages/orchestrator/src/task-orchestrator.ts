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
	type TaskEvent,
	type TaskEventListener,
	type TenantContext,
} from "@tao/core";

export interface TaskRecord {
	readonly taskId: string;
	readonly tenant: TenantContext;
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

export interface SubmitOptions {
	readonly tenant: TenantContext;
	readonly taskId: string;
	readonly sessionId: string;
	readonly prompt: string;
	readonly systemPrompt: string;
	readonly tools: RunnerSpec["tools"];
	readonly gate: RunnerSpec["gate"];
	readonly activeTools?: readonly string[];
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
	private readonly factory: RunnerFactory;
	private readonly now: () => number;

	constructor(factory: RunnerFactory, options: { now?: () => number } = {}) {
		this.factory = factory;
		this.now = options.now ?? (() => Date.now());
	}

	/** 订阅全部任务的事件。返回取消订阅函数。 */
	subscribe(listener: TaskEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get(taskId: string): TaskRecord | undefined {
		return this.tasks.get(taskId);
	}

	/** 取某任务的事件（可指定从哪个 seq 之后开始，用于断线重连）。 */
	events(taskId: string, afterSeq = 0): readonly TaskEvent[] {
		return (this.eventLog.get(taskId) ?? []).filter((e) => e.seq > afterSeq);
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
			status: TaskStatus.Queued,
			artifacts: [],
			createdAt: at,
			updatedAt: at,
		};
		this.tasks.set(options.taskId, record);
		this.eventLog.set(options.taskId, []);
		await this.emitStatus(record, null, TaskStatus.Queued);

		const runner = await this.factory.createRunner({
			tenant: options.tenant,
			taskId: options.taskId,
			sessionId: options.sessionId,
			systemPrompt: options.systemPrompt,
			tools: options.tools,
			gate: options.gate,
			...(options.activeTools === undefined ? {} : { activeTools: options.activeTools }),
		});
		this.runners.set(options.taskId, runner);

		// Runner 的事件转投给编排器的订阅者，并落到事件日志
		runner.subscribe(async (event) => {
			this.eventLog.get(options.taskId)?.push(event);
			// 权限门要求确认时，任务转入 AWAIT_CONFIRM
			if (event.type === "tool_decision" && event.decision === "await_confirm") {
				await this.transition(options.taskId, TaskStatus.AwaitConfirm, event.reason);
			}
			if (event.type === "artifact") {
				this.updateRecord(options.taskId, (r) => ({
					...r,
					artifacts: [...r.artifacts, event.artifactId],
				}));
			}
			await this.fanout(event);
		});

		return this.tasks.get(options.taskId) as TaskRecord;
	}

	/**
	 * 执行一个已提交的任务。
	 *
	 * 与 submit 分开是刻意的：submit 立即返回让用户能继续对话，
	 * run 由调度器在有执行位时调用。一期直接串行调用。
	 */
	async run(taskId: string, prompt: string): Promise<TaskRecord> {
		const runner = this.runners.get(taskId);
		if (runner === undefined) throw new Error(`任务 ${taskId} 没有对应的 Runner`);

		await this.transition(taskId, TaskStatus.Running);
		try {
			await runner.prompt(prompt);
			const current = this.tasks.get(taskId) as TaskRecord;
			// 若执行过程中已进入终态（例如被取消），不再覆盖
			if (!isTerminal(current.status) && current.status !== TaskStatus.AwaitConfirm) {
				await this.transition(taskId, TaskStatus.Succeeded);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			// 失败保留已产出的中间物（验收要求），只改状态不清 artifacts
			await this.transition(taskId, TaskStatus.Failed, reason);
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
		const runner = this.runners.get(taskId);
		if (runner !== undefined) await runner.abort(reason);
		return this.transition(taskId, TaskStatus.Cancelled, reason);
	}

	/** 用户确认高危动作后继续执行。 */
	async confirm(taskId: string): Promise<TaskRecord> {
		return this.transition(taskId, TaskStatus.Running);
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
		await this.emitStatus(updated, from, to, reason);
		return updated;
	}

	private updateRecord(taskId: string, patch: (r: TaskRecord) => TaskRecord): TaskRecord {
		const current = this.tasks.get(taskId);
		if (current === undefined) throw new Error(`任务 ${taskId} 不存在`);
		const updated = { ...patch(current), updatedAt: this.now() };
		this.tasks.set(taskId, updated);
		return updated;
	}

	private async emitStatus(
		record: TaskRecord,
		from: TaskStatus | null,
		to: TaskStatus,
		reason?: string,
	): Promise<void> {
		const log = this.eventLog.get(record.taskId) ?? [];
		const event: TaskEvent = {
			eventId: `${record.taskId}-status-${log.length + 1}`,
			seq: log.length + 1,
			taskId: record.taskId,
			tenant: record.tenant,
			at: this.now(),
			type: "status",
			from,
			to,
			...(reason === undefined ? {} : { reason }),
		};
		log.push(event);
		this.eventLog.set(record.taskId, log);
		await this.fanout(event);
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
