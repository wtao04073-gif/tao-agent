/**
 * 长程任务内存存储 —— 测试与开发态用，与 FileJobStore 同契约。
 */
import type { JobStore, StoredJob } from "@tao/core";

export class MemoryJobStore implements JobStore {
	private readonly jobs = new Map<string, StoredJob>();

	create(job: StoredJob): boolean {
		if (this.jobs.has(job.jobId)) return false;
		this.jobs.set(job.jobId, job);
		return true;
	}

	put(job: StoredJob): void {
		this.jobs.set(job.jobId, job);
	}

	get(jobId: string): StoredJob | undefined {
		return this.jobs.get(jobId);
	}

	listByTenant(tenantId: string, workspaceId: string): readonly StoredJob[] {
		return Array.from(this.jobs.values())
			.filter((j) => j.tenant.tenantId === tenantId && j.tenant.workspaceId === workspaceId)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}
}
