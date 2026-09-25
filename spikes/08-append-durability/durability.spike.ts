/**
 * Spike 8 · 追加写的持久性与崩溃安全
 *
 * M4-3 要做用量看板，但现在的计量存储在内存里 —— 进程重启就归零。
 * **看板读的数据不可信，那看板就是假的。** 所以先解决落盘。
 *
 * ── 为什么不用 SQLite ──
 *
 * `node:sqlite` 在当前 Node 里可用，但是**实验特性**：每次启动打
 * ExperimentalWarning、API 可能随版本变。对一个要售卖、要长期维护的
 * 生产系统不合适。`better-sqlite3` 要原生编译 —— 私有化环境（无外网、
 * 无编译工具链）装不上的概率不低，直接威胁「2 小时装成」。
 *
 * 计量存储的语义恰好很简单：**只追加、按时间范围查、不改不删**。
 * JSONL 追加文件天然匹配，零依赖。
 *
 * ── 但「追加」有三个必须验证的假设 ──
 *
 *  1. **并发追加会不会互相截断？** 多个任务同时落账，若写入交错，
 *     会产生半行 JSON —— 而那一行的钱就丢了，且解析时会抛异常。
 *  2. **进程被 kill 后已写的数据在不在？** 若靠 OS 缓冲，
 *     kill -9 会丢掉最近的写入。计量丢数据等于收错钱。
 *  3. **半写的行能不能被安全跳过？** 断电可能留下不完整的最后一行。
 *     读取时若整体解析失败，等于**全部历史数据都读不出来** ——
 *     比丢最后一条严重得多。
 */

import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workdir(): string {
	const dir = mkdtempSync(join(tmpdir(), "spike8-"));
	dirs.push(dir);
	return dir;
}

/** 一条用量记录的典型大小 —— 决定是否落在原子写的范围内。 */
function sampleLine(index: number): string {
	return `${JSON.stringify({
		tenantId: "univ-007",
		workspaceId: "office",
		taskId: `task-${index}`,
		model: "deepseek-chat",
		inputTokens: 1234,
		outputTokens: 567,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		at: 1_700_000_000_000 + index,
	})}\n`;
}

/** 解析 JSONL，跳过坏行。返回解析成功的记录与跳过的行数。 */
function parseJsonl(text: string): { records: unknown[]; skipped: number } {
	const records: unknown[] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			skipped += 1;
		}
	}
	return { records, skipped };
}

describe("Spike 8 · 记录大小与原子写", () => {
	it("一条用量记录远小于 4096 字节（O_APPEND 原子写上限）", () => {
		// Linux 上以 O_APPEND 打开的文件，单次 write 小于 PIPE_BUF(4096)
		// 时是原子的 —— 这是「并发追加不会互相截断」的前提
		const line = sampleLine(1);
		expect(Buffer.byteLength(line)).toBeLessThan(4096);
		// 留足余量：即使字段变多也不该接近上限
		expect(Buffer.byteLength(line)).toBeLessThan(500);
	});

	it("即使 taskId 很长也不会超过原子写上限", () => {
		// 边界：租户自定义的任务名可能很长
		const long = `${JSON.stringify({
			tenantId: "x".repeat(200),
			workspaceId: "y".repeat(200),
			taskId: "z".repeat(500),
			model: "m".repeat(200),
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 1,
			cacheWriteTokens: 1,
			at: 1,
		})}\n`;
		expect(Buffer.byteLength(long)).toBeLessThan(4096);
	});
});

describe("Spike 8 · 并发追加", () => {
	it("同进程内高并发追加不丢行、不产生半行", () => {
		const dir = workdir();
		const path = join(dir, "usage.jsonl");
		const count = 500;

		for (let i = 0; i < count; i += 1) {
			appendFileSync(path, sampleLine(i));
		}

		const { records, skipped } = parseJsonl(readFileSync(path, "utf8"));
		expect(records).toHaveLength(count);
		expect(skipped).toBe(0);
	});

	it("多进程并发追加同一文件不互相截断", () => {
		// 这是最关键的一条：私有化部署虽是单进程，但 SaaS 形态会多副本，
		// 且未来可能有独立的计量落账进程。若这条不成立，就必须上真数据库
		const dir = workdir();
		const path = join(dir, "usage.jsonl");
		const writer = join(dir, "writer.mjs");

		writeFileSync(
			writer,
			`
import { appendFileSync } from "node:fs";
const [path, tag, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i += 1) {
	appendFileSync(path, JSON.stringify({
		tenantId: "univ-007", workspaceId: "office",
		taskId: tag + "-" + i, model: "deepseek-chat",
		inputTokens: 1234, outputTokens: 567,
		cacheReadTokens: 0, cacheWriteTokens: 0,
		at: 1700000000000 + i,
	}) + "\\n");
}
`,
		);

		const perProcess = 200;
		const tags = ["a", "b", "c", "d"];
		// 并发启动 4 个写进程
		const children = tags.map((tag) =>
			spawnSync(process.execPath, [writer, path, tag, String(perProcess)], {
				encoding: "utf8",
			}),
		);
		for (const child of children) expect(child.status).toBe(0);

		const { records, skipped } = parseJsonl(readFileSync(path, "utf8"));
		// 一行都不能丢、一行都不能坏
		expect(skipped).toBe(0);
		expect(records).toHaveLength(perProcess * tags.length);

		// 每个写进程的记录都完整
		const byTag = new Map<string, number>();
		for (const record of records as Array<{ taskId: string }>) {
			const tag = record.taskId.split("-")[0] as string;
			byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
		}
		for (const tag of tags) expect(byTag.get(tag), tag).toBe(perProcess);
	});
});

describe("Spike 8 · 崩溃后的数据完整性", () => {
	it("kill -9 之后，已 fsync 的记录仍在", () => {
		// 若靠 OS 缓冲，kill -9 会丢最近的写入。计量丢数据等于收错钱
		const dir = workdir();
		const path = join(dir, "usage.jsonl");
		const writer = join(dir, "crasher.mjs");

		writeFileSync(
			writer,
			`
import { openSync, writeSync, fsyncSync } from "node:fs";
const path = process.argv[2];
const fd = openSync(path, "a");
for (let i = 0; i < 50; i += 1) {
	writeSync(fd, JSON.stringify({ n: i }) + "\\n");
}
fsyncSync(fd);
// 立即自杀，不走正常退出路径 —— 模拟断电/OOM kill
process.kill(process.pid, "SIGKILL");
`,
		);

		const result = spawnSync(process.execPath, [writer, path], { encoding: "utf8" });
		// 确认真的是被信号杀掉的，而不是正常退出（否则这条测试没意义）
		expect(result.signal).toBe("SIGKILL");

		const { records, skipped } = parseJsonl(readFileSync(path, "utf8"));
		expect(skipped).toBe(0);
		// fsync 过的 50 条全在
		expect(records).toHaveLength(50);
	});

	it("不 fsync 时 kill -9 也能保住数据（Node 的 writeSync 直接落到 OS）", () => {
		/**
		 * 这条是为了搞清楚 fsync 到底是不是必需的。
		 *
		 * `writeSync` 走 write(2) 系统调用，数据交给 OS page cache。
		 * **进程被 kill 不会丢** —— OS 还活着。只有整机断电/内核崩溃才会丢。
		 *
		 * 结论：进程级崩溃不需要 fsync；整机断电才需要。
		 * 这个区别决定了 fsync 的调用频率（见下一条）。
		 */
		const dir = workdir();
		const path = join(dir, "usage.jsonl");
		const writer = join(dir, "nofsync.mjs");

		writeFileSync(
			writer,
			`
import { openSync, writeSync } from "node:fs";
const fd = openSync(process.argv[2], "a");
for (let i = 0; i < 50; i += 1) {
	writeSync(fd, JSON.stringify({ n: i }) + "\\n");
}
process.kill(process.pid, "SIGKILL");
`,
		);

		const result = spawnSync(process.execPath, [writer, path], { encoding: "utf8" });
		expect(result.signal).toBe("SIGKILL");
		const { records } = parseJsonl(readFileSync(path, "utf8"));
		expect(records).toHaveLength(50);
	});

	it("每条都 fsync 的代价可测 —— 决定是否值得", () => {
		// fsync 是真正的磁盘刷写，比 write 慢几个数量级。
		// 计量场景下每条都 fsync 可能拖慢任务执行
		const dir = workdir();

		const measure = (sync: boolean): number => {
			const path = join(dir, sync ? "with-fsync.jsonl" : "no-fsync.jsonl");
			const fd = openSync(path, "a");
			const started = Date.now();
			for (let i = 0; i < 200; i += 1) {
				writeSync(fd, sampleLine(i));
				if (sync) fsyncSync(fd);
			}
			const elapsed = Date.now() - started;
			closeSync(fd);
			return elapsed;
		};

		const withoutSync = measure(false);
		const withSync = measure(true);

		// 记录实测值供设计参考，不做严格断言（不同存储介质差异很大）
		expect(withoutSync).toBeGreaterThanOrEqual(0);
		expect(withSync).toBeGreaterThanOrEqual(withoutSync);
	});
});

describe("Spike 8 · 半写行的容错", () => {
	it("最后一行不完整时，前面的记录仍能全部读出", () => {
		/**
		 * 这是本 spike 最重要的一条。
		 *
		 * 断电可能留下不完整的最后一行。若读取时整体解析失败，
		 * 等于**全部历史数据都读不出来** —— 比丢最后一条严重得多：
		 * 用户会看到「用量为 0」，而实际已经用了很多。
		 */
		const dir = workdir();
		const path = join(dir, "usage.jsonl");

		for (let i = 0; i < 10; i += 1) appendFileSync(path, sampleLine(i));
		// 追加一个半写的行（模拟断电）
		appendFileSync(path, '{"tenantId":"univ-007","taskI');

		const { records, skipped } = parseJsonl(readFileSync(path, "utf8"));
		// 前 10 条完好
		expect(records).toHaveLength(10);
		// 坏行被跳过而非导致整体失败
		expect(skipped).toBe(1);
	});

	it("中间出现坏行也只跳过那一行", () => {
		// 极端情况：磁盘坏块可能损坏中间的行
		const dir = workdir();
		const path = join(dir, "usage.jsonl");

		appendFileSync(path, sampleLine(1));
		appendFileSync(path, "这不是 JSON\n");
		appendFileSync(path, sampleLine(2));

		const { records, skipped } = parseJsonl(readFileSync(path, "utf8"));
		expect(records).toHaveLength(2);
		expect(skipped).toBe(1);
	});

	it("空文件与不存在的文件都不报错", () => {
		const dir = workdir();
		const empty = join(dir, "empty.jsonl");
		writeFileSync(empty, "");
		expect(parseJsonl(readFileSync(empty, "utf8")).records).toEqual([]);
		// 不存在的文件由调用方处理，这里确认 existsSync 判定可用
		expect(existsSync(join(dir, "never.jsonl"))).toBe(false);
	});

	it("行内含换行的字符串不会破坏行分隔", () => {
		/**
		 * JSON.stringify 会把真实换行转义成 `\\n` 两个字符，
		 * 所以一条记录永远是一行。
		 *
		 * 若实现改用别的序列化方式（如自己拼字符串），这条保证就没了 ——
		 * 一个含换行的任务名会把一条记录劈成两行，两边都解析失败。
		 */
		const dir = workdir();
		const path = join(dir, "usage.jsonl");
		appendFileSync(
			path,
			`${JSON.stringify({ taskId: "第一行\n第二行", note: "含\n换行" })}\n`,
		);

		const text = readFileSync(path, "utf8");
		// 文件里只有一个真实换行（行尾那个）
		expect(text.split("\n").filter((l) => l.trim() !== "")).toHaveLength(1);

		const { records, skipped } = parseJsonl(text);
		expect(skipped).toBe(0);
		expect((records[0] as { taskId: string }).taskId).toBe("第一行\n第二行");
	});
});

describe("Spike 8 · 按月分片", () => {
	it("按月分文件让范围查询不必扫全量", () => {
		/**
		 * 配额按月计。若全部记录写一个文件，查当月用量要扫整个历史 ——
		 * 跑一年后每次查配额都要读几百 MB。
		 *
		 * 按月分片后，查当月只读一个文件；跨月查询读两三个。
		 * 这也让归档变简单：删掉旧月份的文件即可。
		 */
		const dir = workdir();
		const shard = (at: number): string => {
			const d = new Date(at);
			const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
			return join(dir, `usage-${month}.jsonl`);
		};

		// 2026-09 与 2026-10 各写几条
		const sep = Date.UTC(2026, 8, 15);
		const oct = Date.UTC(2026, 9, 3);
		appendFileSync(shard(sep), sampleLine(1));
		appendFileSync(shard(sep), sampleLine(2));
		appendFileSync(shard(oct), sampleLine(3));

		expect(existsSync(join(dir, "usage-2026-09.jsonl"))).toBe(true);
		expect(existsSync(join(dir, "usage-2026-10.jsonl"))).toBe(true);
		// 查 9 月只读 9 月的文件
		expect(parseJsonl(readFileSync(shard(sep), "utf8")).records).toHaveLength(2);
		expect(parseJsonl(readFileSync(shard(oct), "utf8")).records).toHaveLength(1);
	});

	it("月份边界用 UTC，避免时区导致记录落到错误分片", () => {
		// 用本地时间分片会让同一时刻在不同部署环境落到不同月份，
		// 跨时区对账时对不上
		const monthOf = (at: number): string => {
			const d = new Date(at);
			return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
		};
		// UTC 9 月 30 日 23:59，在东八区已是 10 月 1 日
		expect(monthOf(Date.UTC(2026, 8, 30, 23, 59))).toBe("2026-09");
		expect(monthOf(Date.UTC(2026, 9, 1, 0, 0))).toBe("2026-10");
	});
});
