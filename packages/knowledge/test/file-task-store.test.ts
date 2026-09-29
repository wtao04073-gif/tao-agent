/**
 * 文件任务 / 审计存储测试
 *
 * 重点不是「能写能读」，而是 M5-1 承诺的持久化语义：
 *  - 当前态是变更流折叠结果（多次迁移 + 产物累积）；
 *  - 新实例重放同一目录得到同样状态（模拟进程重启）；
 *  - 坏行逐行容错，不拖垮整个任务；
 *  - 审计按天分片、按时间窗查；
 *  - taskId 白名单挡住路径穿越。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStatus, type StoredAuditEntry, type TaskChange, type TaskEvent, type TenantContext } from "@tao/core";
import {
	auditShardName,
	FileAuditStore,
	FileTaskStore,
	isSafeTaskId,
} from "../src/index.ts";
import { writeFullySync } from "../src/file-task-store.ts";

/**
 * ESM 命名导出不可重新定义（vi.spyOn 对 node:fs 会抛 "not configurable"），
 * 因此用 hoisted 局部 mock 给 writeSync 开一个可控缝：未注入实现时完全委托
 * 真实 writeSync，只在两条 appendLine 测试里临时替换为短写 / 抛错桩。
 */
const writeSyncMock = vi.hoisted(() => ({
	current: null as null | ((...args: unknown[]) => unknown),
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeSync: (...args: unknown[]) =>
			writeSyncMock.current !== null
				? writeSyncMock.current(...args)
				: (actual.writeSync as (...a: unknown[]) => unknown)(...args),
	};
});

const TENANT: TenantContext = { tenantId: "t1", workspaceId: "w1", userId: "u1" };
const OTHER: TenantContext = { tenantId: "t2", workspaceId: "w2", userId: "u2" };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tao-taskstore-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function change(over: Partial<TaskChange> & { taskId: string; seq: number; to: TaskStatus }): TaskChange {
	return {
		tenant: TENANT,
		sessionId: "s1",
		at: 1_000 * over.seq,
		from: null,
		...over,
	} as TaskChange;
}

describe("文件任务存储", () => {
	it("当前态由变更流折叠：状态迁移与产物累积都还原", () => {
		const store = new FileTaskStore({ dir });
		store.create(change({ taskId: "t-a", seq: 1, to: TaskStatus.Queued }));
		store.appendChange(change({ taskId: "t-a", seq: 2, from: TaskStatus.Queued, to: TaskStatus.Running }));
		store.appendChange(
			change({ taskId: "t-a", seq: 3, from: TaskStatus.Running, to: TaskStatus.Running, artifacts: ["a.xlsx"] }),
		);
		store.appendChange(
			change({ taskId: "t-a", seq: 4, from: TaskStatus.Running, to: TaskStatus.Succeeded }),
		);

		const got = store.get("t-a");
		expect(got?.status).toBe(TaskStatus.Succeeded);
		expect(got?.artifacts).toEqual(["a.xlsx"]);
	});

	it("新建一个 store 实例重放同一目录，得到同样状态（进程重启）", () => {
		const first = new FileTaskStore({ dir });
		first.create(change({ taskId: "t-a", seq: 1, to: TaskStatus.Queued }));
		first.appendChange(change({ taskId: "t-a", seq: 2, from: TaskStatus.Queued, to: TaskStatus.Failed, reason: "模型超时" }));
		first.appendEvent({
			eventId: "t-a-2",
			taskId: "t-a",
			tenant: TENANT,
			at: 2000,
			seq: 2,
			type: "status",
			from: TaskStatus.Queued,
			to: TaskStatus.Failed,
			reason: "模型超时",
		} satisfies TaskEvent);

		// 全新实例 = 新进程，不共享任何内存状态
		const second = new FileTaskStore({ dir });
		const restored = second.get("t-a");
		expect(restored?.status).toBe(TaskStatus.Failed);
		expect(restored?.reason).toBe("模型超时");
		// 事件流也可拉回，供断线重连
		expect(second.events("t-a", 1)).toHaveLength(1);
	});

	it("按租户隔离：listByTenant 不跨工作区返回", () => {
		const store = new FileTaskStore({ dir });
		store.create(change({ taskId: "t-a", seq: 1, to: TaskStatus.Queued }));
		store.create(change({ taskId: "t-b", seq: 1, to: TaskStatus.Queued, tenant: OTHER }));

		expect(store.listByTenant("t1", "w1").map((t) => t.taskId)).toEqual(["t-a"]);
		expect(store.listAll().map((t) => t.taskId).sort()).toEqual(["t-a", "t-b"]);
	});

	it("create 幂等：同一 taskId 第二次返回 false 且不重复", () => {
		const store = new FileTaskStore({ dir });
		expect(store.create(change({ taskId: "t-a", seq: 1, to: TaskStatus.Queued }))).toBe(true);
		expect(store.create(change({ taskId: "t-a", seq: 1, to: TaskStatus.Queued }))).toBe(false);
		expect(store.get("t-a")?.status).toBe(TaskStatus.Queued);
	});

	it("坏行逐行跳过：一行损坏不影响其它变更", () => {
		const store = new FileTaskStore({ dir });
		store.create(change({ taskId: "t-a", seq: 1, to: TaskStatus.Queued }));
		store.appendChange(change({ taskId: "t-a", seq: 2, from: TaskStatus.Queued, to: TaskStatus.Running }));
		// 追加半行坏数据（模拟 kill -9 留下的截断行），以换行结尾自成坏行
		writeFileSync(join(dir, "tasks", "t-a.jsonl"), '{"seq":3,"to":"RUN\n', { flag: "a" });
		store.appendChange(change({ taskId: "t-a", seq: 4, from: TaskStatus.Running, to: TaskStatus.Succeeded }));

		expect(store.get("t-a")?.status).toBe(TaskStatus.Succeeded);
	});

	it("变更流末尾是无换行半截行时，追加新记录会先隔离坏行再写入", () => {
		const store = new FileTaskStore({ dir });
		store.create(change({ taskId: "t-a", seq: 1, to: TaskStatus.Queued }));
		// 模拟 kill -9：末行没写完且没有换行符。新记录若直接拼到尾上，
		// 会与半截内容连成同一坏行，回放时被整体跳过
		writeFileSync(join(dir, "tasks", "t-a.jsonl"), '{"seq":2,"to":"RUNNIN', { flag: "a" });
		store.appendChange(
			change({ taskId: "t-a", seq: 3, from: TaskStatus.Queued, to: TaskStatus.Succeeded }),
		);

		const restored = new FileTaskStore({ dir });
		const got = restored.get("t-a");
		// 坏行被跳过，新记录完整生效
		expect(got?.status).toBe(TaskStatus.Succeeded);
		const raw = readFileSync(join(dir, "tasks", "t-a.jsonl"), "utf8");
		// 坏行与新行之间必须有换行隔离
		expect(raw).toContain('{"seq":2,"to":"RUNNIN\n');
	});

	it("事件流末尾是无换行半截行时，appendEvent 的新事件仍可完整回放", () => {
		const store = new FileTaskStore({ dir });
		store.create(change({ taskId: "t-a", seq: 1, to: TaskStatus.Queued }));
		writeFileSync(join(dir, "events", "t-a.jsonl"), '{"seq":1,"type":"ste', { flag: "a" });
		store.appendEvent({
			eventId: "t-a-2",
			taskId: "t-a",
			tenant: TENANT,
			at: 2000,
			seq: 2,
			type: "status",
			from: TaskStatus.Queued,
			to: TaskStatus.Running,
		} satisfies TaskEvent);

		const restored = new FileTaskStore({ dir });
		const events = restored.events("t-a");
		expect(events).toHaveLength(1);
		expect(events[0]?.seq).toBe(2);
	});

	it("审计分片末尾是无换行半截行时，append 的新条目仍可查出", () => {
		const store = new FileAuditStore({ dir });
		const at = Date.UTC(2026, 8, 10, 3, 0, 0);
		const shard = auditShardName(at);
		store.append({
			at,
			tenantId: TENANT.tenantId,
			workspaceId: TENANT.workspaceId,
			userId: TENANT.userId,
			taskId: "t-a",
			tool: "write_document",
			decision: "allowed",
			args: {},
		});
		writeFileSync(join(dir, "audit", shard), '{"at":2,"tenantId":"t1",', { flag: "a" });
		store.append({
			at: at + 1,
			tenantId: TENANT.tenantId,
			workspaceId: TENANT.workspaceId,
			userId: TENANT.userId,
			taskId: "t-a",
			tool: "send_email",
			decision: "denied",
			args: {},
		});

		const got = new FileAuditStore({ dir }).list("t1", at, at + 86_400_000);
		expect(got.map((e) => e.tool)).toEqual(["write_document", "send_email"]);
	});

	it("create 对已存在（含半截内容）的变更文件幂等拒绝，不覆盖坏文件", () => {
		const store = new FileTaskStore({ dir });
		store.create(change({ taskId: "t-a", seq: 1, to: TaskStatus.Queued }));
		writeFileSync(join(dir, "tasks", "t-a.jsonl"), '{"seq":9,"to":"FAI', { flag: "a" });
		// 文件已存在 → create 拒绝（安全追加路径不会在 create 上误覆盖）
		expect(store.create(change({ taskId: "t-a", seq: 1, to: TaskStatus.Queued }))).toBe(false);
		// 全新任务的 create 仍正常，首行可回放
		expect(store.create(change({ taskId: "t-b", seq: 1, to: TaskStatus.Queued }))).toBe(true);
		expect(new FileTaskStore({ dir }).get("t-b")?.status).toBe(TaskStatus.Queued);
	});

	it("taskId 白名单挡住路径分隔符", () => {
		const store = new FileTaskStore({ dir });
		expect(isSafeTaskId("task-1")).toBe(true);
		expect(isSafeTaskId("../evil")).toBe(false);
		expect(isSafeTaskId("a/b")).toBe(false);
		expect(() => store.create(change({ taskId: "../evil", seq: 1, to: TaskStatus.Queued }))).toThrow();
	});

	it("maxChangeSeq：只看变更流，事件流缺失也不影响其最大值", () => {
		const store = new FileTaskStore({ dir });
		expect(store.maxChangeSeq("t-a")).toBe(0);
		store.create(change({ taskId: "t-a", seq: 1, to: TaskStatus.Queued }));
		store.appendChange(change({ taskId: "t-a", seq: 2, from: TaskStatus.Queued, to: TaskStatus.Running }));
		store.appendChange(change({ taskId: "t-a", seq: 4, from: TaskStatus.Running, to: TaskStatus.Succeeded }));
		// 只落 seq=1..3 的事件（含 seq=3 非状态事件），刻意与变更流错号
		store.appendEvent({
			eventId: "t-a-1",
			taskId: "t-a",
			tenant: TENANT,
			at: 1000,
			seq: 1,
			type: "status",
			from: null,
			to: TaskStatus.Queued,
		} satisfies TaskEvent);
		store.appendEvent({
			eventId: "t-a-2",
			taskId: "t-a",
			tenant: TENANT,
			at: 2000,
			seq: 2,
			type: "status",
			from: TaskStatus.Queued,
			to: TaskStatus.Running,
		} satisfies TaskEvent);
		store.appendEvent({
			eventId: "t-a-3",
			taskId: "t-a",
			tenant: TENANT,
			at: 3000,
			seq: 3,
			type: "step",
			step: 1,
			action: "执行中",
			phase: "started",
		} satisfies TaskEvent);
		expect(store.maxChangeSeq("t-a")).toBe(4);
		// 重启后新实例口径一致
		expect(new FileTaskStore({ dir }).maxChangeSeq("t-a")).toBe(4);
	});
});

describe("writeFullySync · 短写必须可感知", () => {
	it("底层一次只写部分字节时循环续写到写满，偏移按已写字节严格推进", () => {
		const chunks: Array<{ offset: number; length: number }> = [];
		const buf = Buffer.from("0123456789", "utf8");
		// 每次写最多 3 字节，制造多次短写
		const write = vi.fn((_fd: number, _buffer: Buffer, offset: number, length: number) => {
			const n = Math.min(3, length);
			chunks.push({ offset, length: n });
			return n;
		});
		writeFullySync(write, 7, buf);
		expect(write.mock.calls.length).toBe(4); // 3 + 3 + 3 + 1
		expect(chunks.map((c) => c.length)).toEqual([3, 3, 3, 1]);
		expect(chunks.map((c) => c.offset)).toEqual([0, 3, 6, 9]);
	});

	it("底层返回 0 字节（无法推进）时抛错，绝不静默成功", () => {
		const write = vi.fn(() => 0);
		expect(() => writeFullySync(write, 1, Buffer.from("abc"))).toThrow(/同步写入未完成/);
		expect(write.mock.calls.length).toBe(1);
	});

	it("底层写入抛错时原样向上抛", () => {
		const write = vi.fn(() => {
			throw new Error("ENOSPC: 磁盘已满");
		});
		expect(() => writeFullySync(write, 1, Buffer.from("abc"))).toThrow(/磁盘已满/);
	});

	it("空 Buffer 不触发任何写入", () => {
		const write = vi.fn(() => 1);
		writeFullySync(write, 1, Buffer.alloc(0));
		expect(write.mock.calls.length).toBe(0);
	});

	it("appendLine 遇到短写仍写出完整文件：补换行与正文都循环写满", async () => {
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		const store = new FileTaskStore({ dir });
		store.create(change({ taskId: "t-a", seq: 1, to: TaskStatus.Queued }));
		// 末行无换行的半截坏尾，迫使 appendLine 先补 1 字节换行
		writeFileSync(join(dir, "tasks", "t-a.jsonl"), '{"seq":2,"to":"RUNNIN', { flag: "a" });
		const next = change({
			taskId: "t-a",
			seq: 3,
			from: TaskStatus.Queued,
			to: TaskStatus.Succeeded,
		});

		// 桩住 writeSync：正文（长度 > 2 的写入）第一次只落 2 字节制造短写，
		// 补换行（1 字节）及其后续续写都委托真实写入写满
		let bodyShortWritten = false;
		writeSyncMock.current = (fd: number, data: unknown, offset?: unknown, length?: unknown) => {
			const buffer =
				typeof data === "string"
					? Buffer.from(data)
					: Buffer.isBuffer(data)
						? data
						: Buffer.from(data as Uint8Array);
			const off = typeof offset === "number" ? offset : 0;
			const len = typeof length === "number" ? length : buffer.length - off;
			if (len > 2 && !bodyShortWritten) {
				bodyShortWritten = true;
				return actual.writeSync(fd, buffer, off, 2, null);
			}
			return actual.writeSync(fd, buffer, off, len, null);
		};
		try {
			store.appendChange(next);
		} finally {
			writeSyncMock.current = null;
		}

		const raw = readFileSync(join(dir, "tasks", "t-a.jsonl"), "utf8");
		// 文件以完整新行结尾，且整行就是本次写入的 JSON（短写后续传补齐）
		expect(raw.endsWith(`${JSON.stringify(next)}\n`)).toBe(true);
		const restored = new FileTaskStore({ dir });
		expect(restored.get("t-a")?.status).toBe(TaskStatus.Succeeded);
		expect(restored.maxChangeSeq("t-a")).toBe(3);
	});

	it("appendLine 在 writeSync 抛错时把异常传给调用方，不返回成功", () => {
		writeSyncMock.current = () => {
			throw new Error("ENOSPC: 磁盘已满");
		};
		try {
			const store = new FileTaskStore({ dir });
			expect(() =>
				store.appendChange(
					change({ taskId: "t-a", seq: 1, from: null, to: TaskStatus.Queued }),
				),
			).toThrow(/磁盘已满/);
		} finally {
			writeSyncMock.current = null;
		}
	});
});

describe("文件审计存储", () => {
	function audit(at: number, tenant = TENANT, over: Partial<StoredAuditEntry> = {}): StoredAuditEntry {
		return {
			at,
			tenantId: tenant.tenantId,
			workspaceId: tenant.workspaceId,
			userId: tenant.userId,
			taskId: "t-a",
			tool: "write_document",
			decision: "allowed",
			args: {},
			...over,
		};
	}

	it("按天分片、按时间窗查，跨租户不串", () => {
		const store = new FileAuditStore({ dir });
		store.append(audit(Date.UTC(2026, 8, 10, 3, 0, 0)));
		store.append(audit(Date.UTC(2026, 8, 11, 3, 0, 0)));
		store.append(audit(Date.UTC(2026, 8, 11, 4, 0, 0), OTHER, { taskId: "t-b" }));

		const day1Start = Date.UTC(2026, 8, 10);
		const day2Start = Date.UTC(2026, 8, 11);
		const got = store.list("t1", day1Start, day2Start + 86_400_000);
		expect(got).toHaveLength(2);
		expect(got.every((e) => e.tenantId === "t1")).toBe(true);
	});

	it("审计分片名是 UTC 日期", () => {
		expect(auditShardName(Date.UTC(2026, 0, 5))).toBe("audit-2026-01-05.jsonl");
	});
});
