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
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	writeSync,
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

/**
 * 向已打开的 fd 同步写满整个 Buffer。
 *
 * 抽成纯函数并把底层写入器作为参数注入，是为了可直接单测短写场景：
 * 磁盘紧张 / 管道 / 信号中断时底层写入可能一次只接受部分字节甚至返回 0，
 * 此时必须按已写字节推进偏移继续写，直到全部落盘；未写满前写入器抛错则
 * 原样向上抛。**绝不能在只写了一部分时静默返回** —— 调用方会据此认为
 * 状态/事件已完整持久化，回放时却只能读到半行。
 *
 * @param write 底层写入器，签名对齐 fs.writeSync(fd, buffer, offset, length, position)
 * @param fd 已打开的文件描述符
 * @param buffer 待写内容
 */
export function writeFullySync(
	write: (
		fd: number,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number | null,
	) => number,
	fd: number,
	buffer: Buffer,
): void {
	let offset = 0;
	while (offset < buffer.length) {
		// position 传 null：fd 以 O_APPEND 打开，每次写都原子落在文件尾，
		// 不能显式给位置，否则短写续传会覆盖而不是追加
		const written = write(fd, buffer, offset, buffer.length - offset, null);
		// 返回非正数（0 字节 / 负值）说明无法继续推进，继续循环只会空转；
		// 当作写入失败抛出，避免静默留下半行
		if (!Number.isFinite(written) || written <= 0) {
			throw new Error(`同步写入未完成：期望 ${buffer.length} 字节，实际写入 ${offset} 字节`);
		}
		offset += written;
	}
}

/**
 * 安全追加一行 JSONL。
 *
 * 进程在一次 appendFileSync 中途被 kill 时，文件尾可能留下一行没写完的
 * 半截 JSON。读取侧（parseLines）会逐行容错跳过它，但若直接把新记录拼到
 * 这个坏尾后面，新记录会与半截内容连成同一坏行，在下次回放时被整体跳过 ——
 * 持久化的新状态/事件就此丢失。
 *
 * 因此追加前先读文件最后一个字节：文件非空且末尾不是 `\n` 时，先补一个
 * `\n` 把半截坏行隔离成独立一行，再写新记录。
 *
 * 用 fd + fstat 定位只读末 1 字节，而不是 readFileSync 整个文件：任务事件流
 * 会持续增长，整文件读入在追加热点上不可接受；末字节读取的开销与文件大小
 * 无关。O_APPEND 保证两个写入都落在文件尾。
 *
 * 补换行与正文都走 {@link writeFullySync} 循环写满：短写 / 返回 0 字节 /
 * 抛错都会向上传播，调用方据此感知持久化不完整，绝不会静默成功。
 */
function appendLine(path: string, line: string): void {
	// 用 "a+" 而非 "a"：O_APPEND 只保证写在文件尾，读末字节需要读权限，
	// "a"（O_WRONLY）上 readSync 会抛 EBADF
	const fd = openSync(path, "a+");
	try {
		const { size } = fstatSync(fd);
		if (size > 0) {
			const last = Buffer.alloc(1);
			// 显式定位到 size-1 读取末字节（O_APPEND 只约束写入位置，不影响读）
			const bytes = readSync(fd, last, 0, 1, size - 1);
			if (bytes === 1 && last[0] !== 0x0a) {
				writeFullySync(writeSync, fd, Buffer.from("\n"));
			}
		}
		writeFullySync(writeSync, fd, Buffer.from(line));
	} finally {
		closeSync(fd);
	}
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
		appendLine(this.changePath(change.taskId), `${JSON.stringify(change)}\n`);
		appendFileSync(this.eventPath(change.taskId), "");
		this.known.add(change.taskId);
		return true;
	}

	appendChange(change: TaskChange): void {
		if (!isSafeTaskId(change.taskId)) throw new Error(`非法 taskId：${change.taskId}`);
		appendLine(this.changePath(change.taskId), `${JSON.stringify(change)}\n`);
	}

	appendEvent(event: TaskEvent): void {
		if (!isSafeTaskId(event.taskId)) throw new Error(`非法 taskId：${event.taskId}`);
		appendLine(this.eventPath(event.taskId), `${JSON.stringify(event)}\n`);
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
			...(first.scenarioId === undefined ? {} : { scenarioId: first.scenarioId }),
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

	maxChangeSeq(taskId: string): number {
		if (!isSafeTaskId(taskId)) return 0;
		// 复用逐行容错的变更流读取：即便尾行截断，前面已落盘的最大 seq 仍有效。
		// 恢复每任务只调一次，解析整文件的开销与 list/get 折叠相同。
		return this.readChanges(taskId).reduce((m, c) => Math.max(m, c.seq), 0);
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
		appendLine(join(this.dir, shard), `${JSON.stringify(entry)}\n`);
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
