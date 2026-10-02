/**
 * 长程任务（Job）
 *
 * 与「对话（conversation）」的区分（产品语义）：
 *
 * - **轮（turn）**：用户问一句、智能体答一次（一次执行单元，内部 task）。
 * - **对话（conversation）**：为完成一个短期目标而连续进行的多轮对话，
 *   临时、短期，处于同一组上下文内。
 * - **任务（job，长程）**：用户为一个较长久的目标（如开发一个软件）建立的
 *   独立对象，会跨数天、跨多组上下文进行多次对话；也可以很短。
 *
 * 关系：Job 1—N conversation 1—N turn（内部执行 task）。
 *
 * 跨天记忆不靠把全部原文塞进上下文窗口，而是把每次会话的结论摘要沉淀为
 * JobMemory 条目；新会话自动带上「任务目标 + 历次结论」，因此隔天、换一组
 * 上下文也能接上。
 */
import type { TenantContext } from "./tenant.ts";

/** 长程任务状态。 */
export type JobStatus = "active" | "done" | "archived";

/**
 * 一次会话沉淀下来的长期记忆条目（结论 / 关键决定 / 进展）。
 * 每次会话结束后追加；下次会话注入模型上下文。
 */
export interface JobMemoryEntry {
	/** 产生该条记忆的会话 id。 */
	readonly conversationId: string;
	/** 该条记忆的时间戳（毫秒）。 */
	readonly at: number;
	/** 结论摘要文本（给模型看，也是给用户看的进展记录）。 */
	readonly summary: string;
}

/** 一个长程任务的当前态。 */
export interface StoredJob {
	readonly jobId: string;
	readonly tenant: TenantContext;
	/** 任务标题。 */
	readonly title: string;
	/** 长期目标描述（首轮创建时的原话）。 */
	readonly goal: string;
	readonly status: JobStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** 该任务下已经发起过的会话 id，按时间顺序。 */
	readonly conversationIds: readonly string[];
	/** 历次会话沉淀的长期记忆。 */
	readonly memory: readonly JobMemoryEntry[];
}

/**
 * 长程任务存储。
 *
 * 读按租户隔离；写都是整条覆盖（任务数量少、读多写少、单进程），
 * 与任务事件流的「只追加」刻意不同。
 */
export interface JobStore {
	/** 创建任务；jobId 已存在返回 false。 */
	create(job: StoredJob): boolean;
	/** 整条更新当前态（追加会话、写记忆、改状态）。 */
	put(job: StoredJob): void;
	/** 取单个任务；不存在/越权返回 undefined。 */
	get(jobId: string): StoredJob | undefined;
	/** 列出某租户可见的全部长程任务，按更新时间倒序。 */
	listByTenant(tenantId: string, workspaceId: string): readonly StoredJob[];
}
