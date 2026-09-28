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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStatus, type StoredAuditEntry, type TaskChange, type TaskEvent, type TenantContext } from "@tao/core";
import {
	auditShardName,
	FileAuditStore,
	FileTaskStore,
	isSafeTaskId,
} from "../src/index.ts";

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

	it("taskId 白名单挡住路径分隔符", () => {
		const store = new FileTaskStore({ dir });
		expect(isSafeTaskId("task-1")).toBe(true);
		expect(isSafeTaskId("../evil")).toBe(false);
		expect(isSafeTaskId("a/b")).toBe(false);
		expect(() => store.create(change({ taskId: "../evil", seq: 1, to: TaskStatus.Queued }))).toThrow();
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
