/**
 * 内存任务 / 审计存储
 *
 * 测试与「不需要重启恢复」的开发态用。生产装配走文件版（file-task-store）。
 * 当前态由变更流折叠得到，与文件版同一套回放逻辑 —— 两种实现读出来的
 * 任务状态必须一致，否则测试绿了、重启却读不对。
 */

import {
	TaskStatus,
	type StoredAuditEntry,
	type StoredTask,
	type TaskChange,
	type TaskEvent,
	type TaskStore,
	type AuditStore,
} from "@tao/core";

/** 把一条变更应用到当前态，得到下一个当前态。 */
export function foldChange(cur: StoredTask, change: TaskChange): StoredTask {
	return {
		...cur,
		status: change.to,
		...(change.reason === undefined ? {} : { reason: change.reason }),
		artifacts: change.artifacts ? [...cur.artifacts, ...change.artifacts] : cur.artifacts,
		updatedAt: change.at,
	};
}

/** 由首条变更建立任务的初始态。 */
function seed(change: TaskChange): StoredTask {
	return {
		taskId: change.taskId,
		tenant: change.tenant,
		sessionId: change.sessionId,
		...(change.scenarioId === undefined ? {} : { scenarioId: change.scenarioId }),
		status: change.to,
		...(change.reason === undefined ? {} : { reason: change.reason }),
		artifacts: change.artifacts ? [...change.artifacts] : [],
		createdAt: change.at,
		updatedAt: change.at,
	};
}

export class MemoryTaskStore implements TaskStore {
	private readonly changes = new Map<string, TaskChange[]>();
	private readonly eventLog = new Map<string, TaskEvent[]>();

	create(change: TaskChange): boolean {
		if (this.changes.has(change.taskId)) return false;
		this.changes.set(change.taskId, [change]);
		this.eventLog.set(change.taskId, []);
		return true;
	}

	appendChange(change: TaskChange): void {
		const log = this.changes.get(change.taskId);
		if (log === undefined) throw new Error(`任务 ${change.taskId} 尚未创建`);
		log.push(change);
	}

	appendEvent(event: TaskEvent): void {
		const log = this.eventLog.get(event.taskId);
		if (log === undefined) this.eventLog.set(event.taskId, [event]);
		else log.push(event);
	}

	get(taskId: string): StoredTask | undefined {
		const log = this.changes.get(taskId);
		if (log === undefined || log.length === 0) return undefined;
		return log.reduce<StoredTask>((acc, c) => foldChange(acc, c), seed(log[0] as TaskChange));
	}

	listByTenant(tenantId: string, workspaceId: string): readonly StoredTask[] {
		const out: StoredTask[] = [];
		for (const [id, log] of this.changes) {
			const first = log[0];
			if (first === undefined) continue;
			if (first.tenant.tenantId !== tenantId || first.tenant.workspaceId !== workspaceId) continue;
			out.push(this.get(id) as StoredTask);
		}
		return out;
	}

	events(taskId: string, afterSeq = 0): readonly TaskEvent[] {
		return (this.eventLog.get(taskId) ?? []).filter((e) => e.seq > afterSeq);
	}

	maxChangeSeq(taskId: string): number {
		// 与文件版同一口径：只看变更流，与可能缺号的事件流无关。
		// 恢复路径每任务只调一次，直接在数组上折叠。
		return (this.changes.get(taskId) ?? []).reduce((m, c) => Math.max(m, c.seq), 0);
	}

	listAll(): readonly StoredTask[] {
		const out: StoredTask[] = [];
		for (const id of this.changes.keys()) out.push(this.get(id) as StoredTask);
		return out;
	}
}

export class MemoryAuditStore implements AuditStore {
	private entries: StoredAuditEntry[] = [];

	append(entry: StoredAuditEntry): void {
		this.entries.push(entry);
	}

	list(tenantId: string, from: number, to: number): readonly StoredAuditEntry[] {
		return this.entries.filter(
			(e) => e.tenantId === tenantId && e.at >= from && e.at < to,
		);
	}
}

/** 测试用：把处于非终态的任务当前态改写（重启恢复打标 INTERRUPTED 用）。 */
export function isRecoverableRunning(status: TaskStatus): boolean {
	return status === TaskStatus.Running;
}
