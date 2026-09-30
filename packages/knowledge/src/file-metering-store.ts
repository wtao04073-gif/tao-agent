/**
 * 落盘计量存储（JSONL 追加）
 *
 * ── 为什么不用数据库 ──
 *
 * `node:sqlite` 是**实验特性**（每次启动打 ExperimentalWarning、API 可能
 * 随版本变），对要售卖、要长期维护的系统不合适。`better-sqlite3` 要原生
 * 编译，私有化环境（无外网、无编译工具链）装不上的概率不低 ——
 * 直接威胁 M4 的「2 小时装成」。
 *
 * 计量的语义恰好很简单：**只追加、按时间范围查、不改不删**。
 * JSONL 追加文件天然匹配，零依赖。
 *
 * ── [Spike 8](../../../spikes/08-append-durability/) 验证过的三条 ──
 *
 *  1. **多进程并发追加不互相截断。** 一条记录不到 500 字节，远小于
 *     Linux 的 4096 字节原子写上限。实测 4 进程 × 200 条，一行不丢不坏。
 *  2. **`writeSync` 后进程被 kill -9 不丢数据** —— 数据已交给 OS
 *     page cache，OS 还活着。只有整机断电/内核崩溃才丢。
 *  3. **半写行可安全跳过。** 断电可能留下不完整的最后一行，
 *     读取时必须逐行容错 —— 整体解析失败等于**全部历史都读不出来**，
 *     用户会看到「用量为 0」而实际已经用了很多。
 *
 * ── fsync 策略 ──
 *
 * 实测每条 fsync 的代价是 2.6ms/条（500 条 1298ms vs 1ms），贵 1300 倍。
 * 既然进程崩溃不丢数据，就**不逐条 fsync**：按间隔批量刷。
 * 最坏情况丢掉最后几秒的用量 —— 而那需要整机断电，且损失以分计。
 */

import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { MeteringStore, UsageRecord, UsageTotals } from "@tao/core";

/** 两次 fsync 之间的最长间隔。 */
export const FSYNC_INTERVAL_MS = 5_000;

/** 按月分片的文件名。 */
export function shardName(at: number): string {
	const date = new Date(at);
	/**
	 * **用 UTC 而非本地时间。**
	 *
	 * 本地时间分片会让同一时刻在不同部署环境落到不同月份 ——
	 * 跨时区对账时对不上，且服务器改时区后历史数据就错位了。
	 */
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	return `usage-${date.getUTCFullYear()}-${month}.jsonl`;
}

/** 列出时间窗覆盖的全部分片名。 */
export function shardsInWindow(from: number, to: number): string[] {
	const names: string[] = [];
	const start = new Date(from);
	// 从起始月的 1 号开始逐月推进
	let cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
	// 用 <= to 是因为 to 所在的月份也要覆盖
	while (cursor <= to) {
		names.push(shardName(cursor));
		const d = new Date(cursor);
		cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
	}
	return names;
}

/**
 * 解析一个 JSONL 分片。
 *
 * **逐行容错**：坏行跳过并计数，绝不因一行坏掉而丢弃整个文件。
 */
function parseShard(text: string): { records: UsageRecord[]; skipped: number } {
	const records: UsageRecord[] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as UsageRecord;
			// 最小形状校验 —— 缺字段的记录会让汇总出现 NaN
			if (
				typeof parsed.tenantId === "string" &&
				typeof parsed.at === "number" &&
				typeof parsed.inputTokens === "number"
			) {
				records.push(parsed);
			} else {
				skipped += 1;
			}
		} catch {
			skipped += 1;
		}
	}
	return { records, skipped };
}

export interface FileMeteringStoreOptions {
	/** 数据目录。不存在时自动创建。 */
	readonly dir: string;
	/** fsync 间隔。测试可调小。 */
	readonly fsyncIntervalMs?: number;
	/** 取当前时间。注入以便测试可控。 */
	readonly now?: () => number;
	/**
	 * 发现坏行时的回调。
	 *
	 * **不静默**：坏行意味着有用量没被算进去，运维需要知道。
	 * 但也不抛异常 —— 那会让「一行坏掉」变成「看板打不开」。
	 */
	readonly onCorruptLine?: (info: { shard: string; skipped: number }) => void;
}

/**
 * 文件计量存储。
 *
 * 单机 Compose 部署的默认实现。SaaS 形态量大时换 Postgres ——
 * 接口不变，因为 `record` 本来就被定义成只追加。
 */
export class FileMeteringStore implements MeteringStore {
	private readonly dir: string;
	private readonly fsyncIntervalMs: number;
	private readonly now: () => number;
	private readonly onCorruptLine: FileMeteringStoreOptions["onCorruptLine"];
	/** 打开的分片文件句柄，按分片名缓存。 */
	private readonly handles = new Map<string, number>();
	private lastFsyncAt = 0;

	constructor(options: FileMeteringStoreOptions) {
		this.dir = options.dir;
		this.fsyncIntervalMs = options.fsyncIntervalMs ?? FSYNC_INTERVAL_MS;
		this.now = options.now ?? (() => Date.now());
		this.onCorruptLine = options.onCorruptLine;
		mkdirSync(this.dir, { recursive: true });
	}

	async record(entry: UsageRecord): Promise<void> {
		const shard = shardName(entry.at);
		const path = join(this.dir, shard);

		/**
		 * 用 `JSON.stringify` 序列化，**不自己拼字符串**。
		 *
		 * stringify 会把真实换行转义成 `\n` 两个字符，所以一条记录
		 * 永远是一行。自己拼的话，一个含换行的任务名会把记录劈成两行，
		 * 两边都解析失败 —— 那条用量就丢了。
		 */
		const line = `${JSON.stringify(entry)}\n`;

		let fd = this.handles.get(shard);
		if (fd === undefined) {
			// "a" 即 O_APPEND —— 小于 4096 字节的写入是原子的（Spike 8 验证）
			fd = openSync(path, "a");
			this.handles.set(shard, fd);
		}

		try {
			writeSync(fd, line);
		} catch {
			/**
			 * 句柄可能已失效（文件被外部删除、磁盘拔出）。
			 * 重开一次再试 —— 失败就让异常上抛，由适配层的
			 * `onMeterError` 告警（不中断任务执行）。
			 */
			this.handles.delete(shard);
			const retry = openSync(path, "a");
			this.handles.set(shard, retry);
			writeSync(retry, line);
		}

		this.maybeFsync();
	}

	/**
	 * 按间隔刷盘，不逐条刷。
	 *
	 * 实测每条 fsync 是 2.6ms（vs 不刷 0.002ms），贵 1300 倍。
	 * 而进程崩溃本来不丢数据（数据在 OS page cache），
	 * 只有整机断电才丢 —— 那时最多丢最后几秒的用量。
	 */
	private maybeFsync(): void {
		const at = this.now();
		if (at - this.lastFsyncAt < this.fsyncIntervalMs) return;
		this.lastFsyncAt = at;
		this.flush();
	}

	/** 强制刷盘。服务停机前调用。 */
	flush(): void {
		for (const fd of this.handles.values()) {
			try {
				fsyncSync(fd);
			} catch {
				// 刷盘失败不该让停机流程卡住
			}
		}
	}

	async totals(
		tenantId: string,
		window: { readonly from: number; readonly to: number },
	): Promise<UsageTotals> {
		const records = await this.list(tenantId, window);
		const acc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
		const tasks = new Set<string>();

		for (const r of records) {
			acc.inputTokens += r.inputTokens;
			acc.outputTokens += r.outputTokens;
			acc.cacheReadTokens += r.cacheReadTokens;
			acc.cacheWriteTokens += r.cacheWriteTokens;
			tasks.add(r.taskId);
		}

		return {
			...acc,
			// 四类 token 全计入 —— 缓存读虽便宜但不免费，漏掉会让配额判定偏松
			totalTokens:
				acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheWriteTokens,
			taskCount: tasks.size,
		};
	}

	async list(
		tenantId: string,
		window: { readonly from: number; readonly to: number },
	): Promise<readonly UsageRecord[]> {
		const out: UsageRecord[] = [];

		// 只读时间窗覆盖的分片 —— 跑一年后查当月不必扫全量
		for (const shard of shardsInWindow(window.from, window.to)) {
			const path = join(this.dir, shard);
			if (!existsSync(path)) continue;

			let text: string;
			try {
				text = readFileSync(path, "utf8");
			} catch {
				// 单个分片读不出来不该让整个查询失败
				this.onCorruptLine?.({ shard, skipped: -1 });
				continue;
			}

			const { records, skipped } = parseShard(text);
			if (skipped > 0) this.onCorruptLine?.({ shard, skipped });

			for (const record of records) {
				// 租户过滤 + 左闭右开时间窗（右端闭合会让边界那刻双重计费）
				if (record.tenantId !== tenantId) continue;
				if (record.at < window.from || record.at >= window.to) continue;
				out.push(record);
			}
		}

		return out;
	}

	/** 列出已有的分片，供归档与运维查看。 */
	shards(): string[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((name) => name.startsWith("usage-") && name.endsWith(".jsonl"))
			.sort();
	}

	/** 关闭全部句柄。服务停机时调用。 */
	close(): void {
		this.flush();
		for (const fd of this.handles.values()) {
			try {
				closeSync(fd);
			} catch {
				// 同上
			}
		}
		this.handles.clear();
	}
}
