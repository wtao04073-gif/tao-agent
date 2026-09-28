/**
 * 落盘任务 / 审计存储（JSONL 追加）
 *
 * 与 [file-metering-store](./file-metering-store.ts) 同一套零依赖范式，
 * 但写模式不同，所以目录布局也不同：
 *
 *   <dir>/
 *     tasks/<taskId>.jsonl    任务状态变更流（每任务一文件，只追加）
 *     events/<taskId>.jsonl   完整事件流（含 step/usage/artifact…，供断线重连）
 *     audit/audit-YYYY-MM-DD.jsonl   审计日志，按天分片
 *
 * 当前态 = 变更流回放折叠的结果，见 [task-store](../../core/src/task-store.ts)。
 *
 * ── 为什么变更与事件分两个文件 ──
 *
 * 重建任务列表只需折叠变更（每任务通常十几条），而事件流含 step/usage 等
 * 高频事件，列任务时把它们全读一遍是浪费；两者生命周期也不同（事件将来
 * 可能裁剪只留最近 N 条，变更流不能裁）。
 *
 * ── 文件名安全 ──
 *
 * taskId 由服务端生成（`task-<时间>-<随机>`），但仍按路径分隔符做白名单校验，
 * 避免任何来源的 id 把 `../` 带进文件路径。
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
} from "node:fs";
import { join } from "node:path";
import {
	TaskStatus,
	type AuditStore,
	type StoredAuditEntry,
	type StoredTask,
	type TaskChange,
	type TaskEvent,
	type TaskStore,
} from "@tao/core";
import { foldChange } from "./memory-task-store.ts";

/** taskId 只允许字母数字、连字符、下划线 —— 挡掉路径分隔符与 `..`。 */
export function isSafeTaskId(taskId: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(taskId);
}

/** 审计日志按天分片。 */
export function auditShardName(at: number): string {
	const d = new Date(at);
	const day = String(d.getUTCDate()).padStart(2, "0");
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	// 与计量分片一致用 UTC —— 服务器改时区不影响历史定位
	return `audit-${d.getUTCFullYear()}-${month}-${day}.jsonl`;
}

/** 逐行解析 JSONL，坏行跳过并计数。 */
function parseLines<T>(text: string, isValid: (v: unknown) => v is T): { rows: T[]; skipped: number } {
	const rows: T[] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (isValid(parsed)) rows.push(parsed);
			else skipped += 1;
		} catch {
			skipped += 1;
		}
	}
	return { rows, skipped };
}

function isChange(v: unknown): v is TaskChange {
	if (typeof v !== "object" || v === null) return false;
	const c = v as Record<string, unknown>;
	return (
		typeof c.taskId === "string" &&
		typeof c.at === "number" &&
		typeof c.seq === "number" &&
		typeof c.to === "string" &&
		typeof c.tenant === "object" &&
		c.tenant !== null
	);
}

function isEvent(v: unknown): v is TaskEvent {
	if (typeof v !== "object" || v === null) return false;
	const e = v as Record<string, unknown>;
	return (
		typeof e.taskId === "string" &&
		typeof e.at === "number" &&
		typeof e.seq === "number" &&
		typeof e.type === "string"
	);
}

function isAudit(v: unknown): v is StoredAuditEntry {
	if (typeof v !== "object" || v === null) return false;
	const a = v as Record<string, unknown>;
	return typeof a.at === "number" && typeof a.tenantId === "string" && typeof a.tool === "string";
}

export interface FileTaskStoreOptions {
	readonly dir: string;
	/** 发现坏行时的回调（不静默，但也不抛异常拖垮读取）。 */
	readonly onCorruptLine?: (info: { file: string; skipped: number }) => void;
}

export class FileTaskStore implements TaskStore {
	private readonly tasksDir: string;
	private readonly eventsDir: string;
	private readonly onCorruptLine?: FileTaskStoreOptions["onCorruptLine"];
	/** 进程内已确认存在的任务，避免每次都 stat。 */
	private readonly known = new Set<string>();

	constructor(options: FileTaskStoreOptions) {
		this.tasksDir = join(options.dir, "tasks");
		this.eventsDir = join(options.dir, "events");
		this.onCorruptLine = options.onCorruptLine;
		mkdirSync(this.tasksDir, { recursive: true });
		mkdirSync(this.eventsDir, { recursive: true });
		for (const name of readdirSync(this.tasksDir)) {
			if (name.endsWith(".jsonl")) this.known.add(name.slice(0, -".jsonl".length));
		}
	}

	private changePath(taskId: string): string {
		return join(this.tasksDir, `${taskId}.jsonl`);
	}

	private eventPath(taskId: string): string {
		return join(this.eventsDir, `${taskId}.jsonl`);
	}

	create(change: TaskChange): boolean {
		if (!isSafeTaskId(change.taskId)) throw new Error(`非法 taskId：${change.taskId}`);
		if (this.known.has(change.taskId) || existsSync(this.changePath(change.taskId))) {
			return false;
		}
		appendFileSync(this.changePath(change.taskId), `${JSON.stringify(change)}\n`);
		appendFileSync(this.eventPath(change.taskId), "");
		this.known.add(change.taskId);
		return true;
	}

	appendChange(change: TaskChange): void {
		if (!isSafeTaskId(change.taskId)) throw new Error(`非法 taskId：${change.taskId}`);
		appendFileSync(this.changePath(change.taskId), `${JSON.stringify(change)}\n`);
	}

	appendEvent(event: TaskEvent): void {
		if (!isSafeTaskId(event.taskId)) throw new Error(`非法 taskId：${event.taskId}`);
		appendFileSync(this.eventPath(event.taskId), `${JSON.stringify(event)}\n`);
	}

	private readChanges(taskId: string): TaskChange[] {
		let text = "";
		try {
			text = readFileSync(this.changePath(taskId), "utf8");
		} catch {
			return [];
		}
		const { rows, skipped } = parseLines(text, isChange);
		if (skipped > 0) this.onCorruptLine?.({ file: this.changePath(taskId), skipped });
		// 落盘顺序即追加顺序，seq 应单调；防御性按 seq 排序，保证折叠确定性
		return rows.sort((a, b) => a.seq - b.seq);
	}

	get(taskId: string): StoredTask | undefined {
		if (!isSafeTaskId(taskId)) return undefined;
		const log = this.readChanges(taskId);
		if (log.length === 0) return undefined;
		const first = log[0];
		if (first === undefined) return undefined;
		const rest = log.slice(1);
		const seed: StoredTask = {
			taskId: first.taskId,
			tenant: first.tenant,
			sessionId: first.sessionId,
			status: first.to,
			...(first.reason === undefined ? {} : { reason: first.reason }),
			artifacts: first.artifacts ? [...first.artifacts] : [],
			createdAt: first.at,
			updatedAt: first.at,
		};
		return rest.reduce<StoredTask>((acc, c) => foldChange(acc, c), seed);
	}

	listByTenant(tenantId: string, workspaceId: string): readonly StoredTask[] {
		const out: StoredTask[] = [];
		for (const id of this.known) {
			const task = this.get(id);
			if (task === undefined) continue;
			if (task.tenant.tenantId === tenantId && task.tenant.workspaceId === workspaceId) {
				out.push(task);
			}
		}
		return out;
	}

	listAll(): readonly StoredTask[] {
		const out: StoredTask[] = [];
		for (const id of this.known) {
			const task = this.get(id);
			if (task !== undefined) out.push(task);
		}
		return out;
	}

	events(taskId: string, afterSeq = 0): readonly TaskEvent[] {
		let text = "";
		try {
			text = readFileSync(this.eventPath(taskId), "utf8");
		} catch {
			return [];
		}
		const { rows, skipped } = parseLines(text, isEvent);
		if (skipped > 0) this.onCorruptLine?.({ file: this.eventPath(taskId), skipped });
		return rows.filter((e) => e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
	}
}

export class FileAuditStore implements AuditStore {
	private readonly dir: string;
	private readonly onCorruptLine?: FileTaskStoreOptions["onCorruptLine"];

	constructor(options: FileTaskStoreOptions) {
		this.dir = join(options.dir, "audit");
		this.onCorruptLine = options.onCorruptLine;
		mkdirSync(this.dir, { recursive: true });
	}

	append(entry: StoredAuditEntry): void {
		const shard = auditShardName(entry.at);
		appendFileSync(join(this.dir, shard), `${JSON.stringify(entry)}\n`);
	}

	list(tenantId: string, from: number, to: number): readonly StoredAuditEntry[] {
		const out: StoredAuditEntry[] = [];
		for (const name of readdirSync(this.dir)) {
			if (!name.endsWith(".jsonl")) continue;
			// 从文件名取日期粗筛，避免读无关分片
			const m = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name);
			if (m === null) continue;
			const dayStart = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
			if (dayStart >= to || dayStart + 86_400_000 <= from) continue;
			let text = "";
			try {
				text = readFileSync(join(this.dir, name), "utf8");
			} catch {
				continue;
			}
			const { rows, skipped } = parseLines(text, isAudit);
			if (skipped > 0) this.onCorruptLine?.({ file: name, skipped });
			for (const e of rows) {
				if (e.tenantId === tenantId && e.at >= from && e.at < to) out.push(e);
			}
		}
		return out.sort((a, b) => a.at - b.at);
	}
}

/**
 * 重启恢复时把「正在执行但执行器已随旧进程消失」的任务标记为 INTERRUPTED。
 *
 * waiting / queued 保持原样（可被继续确认 / 被调度启动），终态保持原样，
 * 只有 RUNNING 需要改写 —— 没有任何执行器在跑它却显示 RUNNING 就是僵尸态。
 * 返回被改写的任务 id 数（测试与日志用）。
 */
export function interruptedStatusOnRestart(status: TaskStatus): TaskStatus | null {
	return status === TaskStatus.Running ? TaskStatus.Interrupted : null;
}
