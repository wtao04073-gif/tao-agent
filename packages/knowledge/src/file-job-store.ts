/**
 * 长程任务（Job）文件存储
 *
 * 一个任务一个 JSON 文件：`<dir>/jobs/<jobId>.json`。
 *
 * 与任务事件流（只追加 JSONL）刻意不同——Job 数量少、读多写少、需要整段更新
 * （追加会话 id、沉淀记忆、改状态），整条原子覆盖最简单可靠。写入用临时文件 +
 * rename，避免读到写了一半的 JSON。
 *
 * 租户隔离：文件按租户工作区目录分开（目录由调用方解析），读取再核对记录里的
 * tenantId/workspaceId，双保险。
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { JobStore, StoredJob } from "@tao/core";
import { isSafeTaskId } from "./file-task-store.ts";

export interface FileJobStoreOptions {
	readonly dir: string;
}

export class FileJobStore implements JobStore {
	private readonly jobsDir: string;

	constructor(options: FileJobStoreOptions) {
		this.jobsDir = join(options.dir, "jobs");
		mkdirSync(this.jobsDir, { recursive: true });
	}

	private path(jobId: string): string {
		return join(this.jobsDir, `${jobId}.json`);
	}

	create(job: StoredJob): boolean {
		if (!isSafeTaskId(job.jobId)) throw new Error(`非法 jobId：${job.jobId}`);
		if (existsSync(this.path(job.jobId))) return false;
		this.writeAtomic(job);
		return true;
	}

	put(job: StoredJob): void {
		if (!isSafeTaskId(job.jobId)) throw new Error(`非法 jobId：${job.jobId}`);
		this.writeAtomic(job);
	}

	get(jobId: string): StoredJob | undefined {
		if (!isSafeTaskId(jobId)) return undefined;
		if (!existsSync(this.path(jobId))) return undefined;
		try {
			return JSON.parse(readFileSync(this.path(jobId), "utf8")) as StoredJob;
		} catch {
			// 坏文件不拖垮列表：当作不存在（与事件流逐行容错同一取向）
			return undefined;
		}
	}

	listByTenant(tenantId: string, workspaceId: string): readonly StoredJob[] {
		const out: StoredJob[] = [];
		for (const name of readdirSync(this.jobsDir)) {
			if (!name.endsWith(".json")) continue;
			try {
				const job = JSON.parse(
					readFileSync(join(this.jobsDir, name), "utf8"),
				) as StoredJob;
				if (job.tenant.tenantId === tenantId && job.tenant.workspaceId === workspaceId) {
					out.push(job);
				}
			} catch {
				// 跳过坏文件
			}
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private writeAtomic(job: StoredJob): void {
		const final = this.path(job.jobId);
		const tmp = `${final}.tmp-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
		writeFileSync(tmp, JSON.stringify(job) + "\n", { encoding: "utf8" });
		renameSync(tmp, final);
	}
}
