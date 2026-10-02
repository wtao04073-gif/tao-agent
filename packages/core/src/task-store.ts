/**
 * 任务与审计的持久化抽象
 *
 * M5-1 落点。M4 末任务记录、事件历史、审计日志都在内存里，进程重启即丢。
 * 这个文件只定**契约**，不给实现 —— 文件版在 knowledge 包
 * （JSONL，沿用 [Spike 8](./../../knowledge/src/file-metering-store.ts)
 * 验证过的零依赖追加范式），内存版用于测试。
 *
 * ── 事件溯源的最小形态 ──
 *
 * 任务的「当前态」不是一份被反复覆写的快照，而是一条**状态变更流的折叠结果**。
 * 每次状态迁移追加一条不可变变更，启动时回放全部变更重建当前态。
 *
 * 为什么不用「每次迁移整份覆写快照」：覆写在 kill -9 时可能留下半个文件，
 * JSON.parse 直接失败 → 整个任务读不出来。只追加的写法则至多坏掉最后一行，
 * 逐行容错即可跳过，前面的状态都还在，且这条变更流本身就是
 * 「任务何时被谁改成什么」的审计轨迹，不必另造一份。
 */

import type { TaskEvent } from "./events.ts";
import type { AuditEntry } from "./permission-gate.ts";
import type { TaskStatus } from "./task-status.ts";
import type { TenantContext } from "./tenant.ts";

/**
 * 任务的静态信息。
 *
 * 与编排器内部的 TaskRecord 同一形状，但这里不依赖 orchestrator 包
 *（core 不能反向依赖上层），所以独立声明并要求二者字段兼容。
 * 租户归属、创建时刻是任务创建即固定的；状态与产物在变更流里演化。
 */
export interface StoredTask {
	readonly taskId: string;
	readonly tenant: TenantContext;
	/** 创建该任务时的会话标识。恢复后用于判断能否续跑（M5-1 不续跑会话）。 */
	readonly sessionId: string;
	/**
	 * 所属多轮对话 id。一次对话由多轮「任务」组成，每轮独立 taskId/sessionId，
	 * 但共享 conversationId；前端据此把多轮问答聚合成一条会话并续聊。
	 * 早期数据无此字段时按 taskId 单轮处理。
	 */
	readonly conversationId?: string;
	/**
	 * 对话标题（取首轮用户 query 的摘要）。用于左侧最近对话与任务中心展示，
	 * 让用户能认出每个会话，而不是一律显示「通用任务」。
	 */
	readonly title?: string;
	/**
	 * 所属长程任务（Job）id。属于某长程任务的会话才带；临时对话缺省。
	 * 一个 Job 下有多个 conversation，跨天多次会话据此归并。
	 */
	readonly jobId?: string;
	/**
	 * 发起任务所用的场景卡 id（M5-3）。
	 *
	 * 可选：早期数据与非场景入口（自由对话）没有它。任务中心据此显示场景标题，
	 * 缺失时退化为显示任务摘要而非报错。
	 */
	readonly scenarioId?: string;
	readonly status: TaskStatus;
	/** 终态非成功时面向用户的原因。 */
	readonly reason?: string;
	readonly artifacts: readonly string[];
	readonly createdAt: number;
	readonly updatedAt: number;
}

/**
 * 一条不可变的任务状态变更。
 *
 * 这是持久化的最小记录单元。`to`/`artifacts` 等字段描述「这次变更把任务
 * 改成了什么」，回放时按 seq 顺序应用即可重建 StoredTask。
 */
export interface TaskChange {
	readonly taskId: string;
	readonly tenant: TenantContext;
	readonly sessionId: string;
	/**
	 * 场景卡 id。仅在首条变更（from=null 的 create）上携带，是任务的静态属性；
	 * 折叠当前态时从首条读取。后续迁移省略。
	 */
	readonly scenarioId?: string;
	/** 对话归属与标题：同为静态属性，只在首条 create 变更上携带。 */
	readonly conversationId?: string;
	readonly title?: string;
	/** 长程任务归属：静态属性，只在首条 create 变更上携带。 */
	readonly jobId?: string;
	/** 变更序号，在任务内从 1 单调递增；即事件流里 status 事件的 seq。 */
	readonly seq: number;
	readonly at: number;
	readonly from: TaskStatus | null;
	readonly to: TaskStatus;
	readonly reason?: string;
	/** 本次变更新增的产物（artifact 事件发生时累积），无则省略。 */
	readonly artifacts?: readonly string[];
}

/** 落盘的审计记录：权限门的 AuditEntry 补上归属与时间。 */
export interface StoredAuditEntry extends AuditEntry {
	readonly at: number;
	readonly tenantId: string;
	readonly workspaceId: string;
	readonly userId: string;
	readonly taskId: string;
}

/**
 * 任务存储。
 *
 * 写都是「追加一条变更 / 追加一条事件」，读分两类：按租户列当前态、
 * 按任务拉事件流。实现必须保证同进程内多次调用看到自己刚写入的内容。
 */
export interface TaskStore {
	/**
	 * 记录任务创建（首条变更，from=null → QUEUED）。幂等 —— 同一 taskId
	 * 重复创建不应产生第二条，返回 false 表示已存在。
	 */
	create(change: TaskChange): boolean;
	/** 追加一次状态/产物变更。 */
	appendChange(change: TaskChange): void;
	/** 追加一条已由编排器编好号的事件（含非 status 事件：step/usage/…）。 */
	appendEvent(event: TaskEvent): void;
	/** 列出某租户可见的全部任务的当前态（回放变更折叠得到）。 */
	listByTenant(tenantId: string, workspaceId: string): readonly StoredTask[];
	/**
	 * 列出全部任务的当前态，**不限租户**。
	 *
	 * 仅用于进程启动恢复 —— 那时还没有请求上下文。运行时的租户查询必须走
	 * {@link TaskStore.listByTenant}，不能用这个方法做业务读，否则就是跨租户泄漏。
	 */
	listAll(): readonly StoredTask[];
	/** 按 id 取任务当前态；不存在返回 undefined。 */
	get(taskId: string): StoredTask | undefined;
	/** 取某任务事件流，可指定从某 seq 之后开始（断线重连）。 */
	events(taskId: string, afterSeq?: number): readonly TaskEvent[];
	/**
	 * 取某任务**变更流**已使用的最大 seq；任务不存在（无任何变更）时返回 0。
	 *
	 * 与事件流的最大 seq 区分：事件流落盘是 best-effort，可能因磁盘满等原因
	 * 缺号，而对应状态变更（status 事件同时写两条流）可能已成功落盘。重启
	 * 恢复分配新序号时必须取两条流的最大值，否则会复用「变更流已占用、事件
	 * 也已实时发给客户端」的序号，导致 SSE 重连把新事件误判成已收过。
	 */
	maxChangeSeq(taskId: string): number;
}

/**
 * 审计存储。只追加、按时间窗查。
 */
export interface AuditStore {
	append(entry: StoredAuditEntry): void;
	/** 取 [from, to) 时间窗内某租户的审计记录。 */
	list(tenantId: string, from: number, to: number): readonly StoredAuditEntry[];
}
