/**
 * 长程任务（Job）文件存储测试
 *
 * 验证：整条覆盖读写、按租户隔离、新实例重放同目录（重启不丢）、
 * 重复 create 幂等返回 false、jobId 白名单挡路径穿越。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredJob, TenantContext } from "@tao/core";
import { FileJobStore } from "../src/index.ts";

const TENANT_A: TenantContext = { tenantId: "ta", workspaceId: "wa", userId: "u1" };
const TENANT_B: TenantContext = { tenantId: "tb", workspaceId: "wb", userId: "u2" };

function makeJob(over: Partial<StoredJob> = {}): StoredJob {
	const now = 1_000;
	return {
		jobId: "job-1",
		tenant: TENANT_A,
		title: "开发系统",
		goal: "做一个 XX 管理系统",
		status: "active",
		createdAt: now,
		updatedAt: now,
		conversationIds: [],
		memory: [],
		...over,
	};
}

describe("FileJobStore", () => {
	let dir = "";
	afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

	function newStore() {
		dir = mkdtempSync(join(tmpdir(), "tao-jobs-"));
		return new FileJobStore({ dir });
	}

	it("写入后可读出，字段完整", () => {
		const s = newStore();
		s.create(makeJob({ memory: [{ conversationId: "c1", at: 2, summary: "已完成登录模块" }] }));
		const got = s.get("job-1");
		expect(got?.title).toBe("开发系统");
		expect(got?.memory[0]?.summary).toBe("已完成登录模块");
	});

	it("整条覆盖更新（追加会话与记忆）", () => {
		const s = newStore();
		s.create(makeJob());
		const cur = s.get("job-1") as StoredJob;
		s.put({
			...cur,
			conversationIds: ["conv-1"],
			memory: [{ conversationId: "conv-1", at: 3, summary: "进展" }],
			updatedAt: 4,
		});
		expect(s.get("job-1")?.conversationIds).toEqual(["conv-1"]);
		expect(s.get("job-1")?.memory).toHaveLength(1);
	});

	it("重复 create 返回 false，不覆盖", () => {
		const s = newStore();
		expect(s.create(makeJob())).toBe(true);
		expect(s.create(makeJob({ title: "被篡改" }))).toBe(false);
		expect(s.get("job-1")?.title).toBe("开发系统");
	});

	it("按租户隔离：B 看不到 A 的任务", () => {
		const s = newStore();
		s.create(makeJob());
		s.create(makeJob({ jobId: "job-2", tenant: TENANT_B }));
		expect(s.listByTenant("ta", "wa").map((j) => j.jobId)).toEqual(["job-1"]);
		expect(s.listByTenant("tb", "wb").map((j) => j.jobId)).toEqual(["job-2"]);
		expect(s.get("job-2")?.tenant.tenantId === "ta").toBe(false);
	});

	it("新实例重放同一目录，状态不丢（模拟重启）", () => {
		const d = mkdtempSync(join(tmpdir(), "tao-jobs-restart-"));
		const s1 = new FileJobStore({ dir: d });
		s1.create(makeJob({ title: "持久任务" }));
		const s2 = new FileJobStore({ dir: d });
		expect(s2.get("job-1")?.title).toBe("持久任务");
		rmSync(d, { recursive: true, force: true });
	});

	it("非法 jobId 抛错，挡住路径穿越", () => {
		const s = newStore();
		expect(() => s.create(makeJob({ jobId: "../evil" }))).toThrow();
		expect(s.get("../../x")).toBeUndefined();
	});
});
