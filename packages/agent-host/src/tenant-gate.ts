/**
 * 租户级配额预检临界区与任务席位预留
 *
 * 背景缺陷：预检原来只读历史用量、没有任何互斥或预留。同一租户的 N 个
 * prompt 并发进入时，会同时读到相同的用量快照（TOCTOU），于是
 * 「任务数上限」被并发突破；token / cost 维度也都基于同一份旧值放行。
 *
 * 这里用**每个租户一条 Promise 链**实现异步互斥（不阻塞事件循环、不引
 * 第三方锁），保证同一租户的预检临界区严格串行：
 *
 *   1. 临界区内调用 preflight，并把「当前在途任务的 taskId 集合」传给它，
 *      使 maxTasks 按「已结算 taskId 集合 ∪ 在途 taskId 集合」去重判定 ——
 *      已落账首轮用量但尚未结束的任务不会被两边各算一次；
 *   2. 预检通过后在临界区内把本次 taskId 记入在途集合（预留席位），随后立即
 *      释放锁，真正的模型执行（lane.prompt）在锁外并发进行；
 *   3. 执行结束（成功或失败）由调用方释放预留，把 taskId 从在途集合移除。
 *
 * 能力边界（诚实说明）：token / cost 是事后计量，单个任务的实际消耗要等
 * 模型调用后才知道，预检无法把「本次即将消耗的量」预留出去 —— 临界区只能
 * 保证各并发任务读到的是含此前已结算任务的**最新** totals、不再共享过期
 * 快照；任务席位（maxTasks）则因可在调用前确定而被严格预留，不会被并发突破。
 */

/** 释放本次预留的席位。幂等与否由调用方保证（在 finally 中只调一次）。 */
export type ReleaseReservation = () => void;

export class TenantTaskGate {
	/** 每个租户一条 Promise 链：链上的前一段代表「上一个临界区已结束」。 */
	private readonly chains = new Map<string, Promise<void>>();
	/** 每个租户当前已预留（在途）的任务 taskId 集合。 */
	private readonly inflight = new Map<string, Set<string>>();

	/** 某租户当前在途（已预留席位、尚未释放）的任务数。 */
	inflightCount(tenantId: string): number {
		return this.inflight.get(tenantId)?.size ?? 0;
	}

	/**
	 * 进入租户临界区执行预检，通过则预留一个任务席位。
	 *
	 * - 多个并发调用按租户串行执行 `preflight`，后进入者能看到先进入者
	 *   已预留的席位（在途集合单调反映预留结果）；
	 * - `preflight` 抛错或返回拒绝时**不预留**，异常原样抛给调用方；
	 * - 返回的释放函数在模型执行结束后调用，归还席位。临界区本身在预留
	 *   完成后即结束，不覆盖耗时的模型执行阶段。
	 *
	 * @param taskId 本次预留的任务 id；必然包含在传给 preflight 的在途并集里
	 * @param preflight 临界区内的预检回调，入参为「当前在途任务 ∪ 本次任务」的
	 *        taskId 集合（只读快照），调用方按它与已落账 taskId 集合取并集去重
	 */
	async reserve(
		tenantId: string,
		taskId: string,
		preflight: (inflightTaskIds: readonly string[]) => Promise<void>,
	): Promise<ReleaseReservation> {
		const previous = this.chains.get(tenantId) ?? Promise.resolve();
		let release!: ReleaseReservation;
		// 当前临界区：仅包含「读最新快照 + 预检 + 预留」，链在它结束后即推进，
		// 不等待返回后的 lane.prompt，因此任务执行仍可并发。
		const critical = previous.then(async () => {
			const current = this.inflight.get(tenantId) ?? new Set<string>();
			// 并集在临界区内构造：含此前全部在途任务与本次 taskId，
			// 保证当前任务即使尚未落账也占一个席位、且不会被重复计数。
			const union = new Set(current);
			union.add(taskId);
			await preflight([...union]);
			const reserved = new Set(current);
			reserved.add(taskId);
			this.inflight.set(tenantId, reserved);
			release = () => {
				const latest = this.inflight.get(tenantId);
				if (latest === undefined) return;
				latest.delete(taskId);
				if (latest.size === 0) this.inflight.delete(tenantId);
			};
		});
		// 无论临界区成败都吞掉链上 rejection，避免一个失败的预检让该租户
		// 后续所有调用永远卡在 rejected 链上（critical 仍会把异常抛给本次调用者）。
		this.chains.set(
			tenantId,
			critical.then(
				() => undefined,
				() => undefined,
			),
		);
		await critical;
		return release;
	}
}
