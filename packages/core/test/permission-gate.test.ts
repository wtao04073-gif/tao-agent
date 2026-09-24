/**
 * 权限门测试
 *
 * 重点验三件事：默认拒绝真的是默认、高危动作确实转确认、每次决策都有审计。
 */

import { describe, expect, it } from "vitest";
import { type AuditEntry, createPermissionGate } from "../src/permission-gate.ts";
import type { TenantContext } from "../src/tenant.ts";

const TENANT: TenantContext = { tenantId: "t1", workspaceId: "w1", userId: "u1" };
const WORKSPACE = "/workspace/task-1";

function gateWith(
	policies: Parameters<typeof createPermissionGate>[0]["policies"],
	grantedDirs: string[] = [],
) {
	const audit: AuditEntry[] = [];
	const gate = createPermissionGate({
		policies,
		workspace: WORKSPACE,
		grantedDirs,
		audit: (entry) => void audit.push(entry),
	});
	const ask = (toolName: string, args: unknown = {}) =>
		gate({ toolName, args, tenant: TENANT, taskId: "task-1" });
	return { gate, ask, audit };
}

describe("权限门 · 默认拒绝", () => {
	it("未登记的工具一律拒绝", async () => {
		const { ask } = gateWith([{ tool: "read_table" }]);
		const decision = await ask("delete_everything");
		expect(decision.kind).toBe("block");
		expect(decision.kind === "block" ? decision.reason : "").toContain("未被授权");
	});

	it("空白名单时任何工具都不放行", async () => {
		// 「忘记登记权限」的后果必须是不可用，而不是不受控
		const { ask } = gateWith([]);
		for (const tool of ["read_table", "write_file", "send_email"]) {
			expect((await ask(tool)).kind).toBe("block");
		}
	});

	it("白名单内的工具放行", async () => {
		const { ask } = gateWith([{ tool: "read_table" }]);
		expect((await ask("read_table")).kind).toBe("allow");
	});
});

describe("权限门 · 路径参数校验", () => {
	const policies = [{ tool: "read_table", pathParams: ["path"] }];

	it("工作区内路径放行", async () => {
		const { ask } = gateWith(policies);
		expect((await ask("read_table", { path: "input.xlsx" })).kind).toBe("allow");
	});

	it("凭据路径拒绝", async () => {
		const { ask } = gateWith(policies);
		const decision = await ask("read_table", { path: "/home/a/.ssh/id_rsa" });
		expect(decision.kind).toBe("block");
	});

	it("穿越拒绝", async () => {
		const { ask } = gateWith(policies);
		expect((await ask("read_table", { path: "../../etc/passwd" })).kind).toBe("block");
	});

	it("数组形态的路径参数逐个校验", async () => {
		// 「多表核对」这类工具接收路径数组，只查第一个是不够的
		const { ask } = gateWith([{ tool: "compare", pathParams: ["files"] }]);
		const decision = await ask("compare", {
			files: ["ok.xlsx", "/etc/passwd"],
		});
		expect(decision.kind).toBe("block");
	});

	it("未声明为路径的参数不做路径校验", async () => {
		// 避免把普通字符串参数误判为路径而拒绝
		const { ask } = gateWith([{ tool: "search", pathParams: ["path"] }]);
		const decision = await ask("search", { keyword: "../../etc/passwd" });
		expect(decision.kind).toBe("allow");
	});
});

describe("权限门 · 高危动作转确认", () => {
	it("requiresConfirm 的工具返回 confirm 而非 allow", async () => {
		const { ask } = gateWith([
			{ tool: "send_email", requiresConfirm: true, confirmReason: "将向外部发送邮件" },
		]);
		const decision = await ask("send_email");
		expect(decision.kind).toBe("confirm");
		expect(decision.kind === "confirm" ? decision.reason : "").toBe("将向外部发送邮件");
	});

	it("路径非法时优先拒绝，不进入确认", async () => {
		// 顺序很重要：非法路径应被直接拒绝，而不是让用户去确认一个本就不该做的操作
		const { ask } = gateWith([
			{ tool: "delete_file", pathParams: ["path"], requiresConfirm: true },
		]);
		const decision = await ask("delete_file", { path: "/etc/passwd" });
		expect(decision.kind).toBe("block");
	});

	it("未提供 confirmReason 时给出兜底说明", async () => {
		const { ask } = gateWith([{ tool: "bulk_update", requiresConfirm: true }]);
		const decision = await ask("bulk_update");
		expect(decision.kind).toBe("confirm");
		expect(decision.kind === "confirm" ? decision.reason : "").toContain("bulk_update");
	});
});

describe("权限门 · 审计", () => {
	it("放行也要记审计，不只是拒绝", async () => {
		// 只记拒绝的话，事后无法回答「谁在什么时候动了什么」
		const { ask, audit } = gateWith([{ tool: "read_table" }]);
		await ask("read_table", { path: "a.xlsx" });
		expect(audit).toHaveLength(1);
		expect(audit[0]?.decision).toBe("allowed");
		expect(audit[0]?.tool).toBe("read_table");
	});

	it("拒绝时记录原因与规则类别", async () => {
		const { ask, audit } = gateWith([{ tool: "read_table", pathParams: ["path"] }]);
		await ask("read_table", { path: "/home/a/.aws/credentials" });
		expect(audit[0]?.decision).toBe("blocked");
		expect(audit[0]?.reason).toBeTruthy();
		// 规则类别用于把「探测行为」与「误操作」分开告警
		expect(audit[0]?.rule).toBe("credential");
	});

	it("审计包含原始参数（供事后追溯）", async () => {
		const { ask, audit } = gateWith([{ tool: "read_table" }]);
		await ask("read_table", { path: "a.xlsx", sheet: "Sheet1" });
		expect(audit[0]?.args).toEqual({ path: "a.xlsx", sheet: "Sheet1" });
	});

	it("每次调用都产生恰好一条审计（不重不漏）", async () => {
		const { ask, audit } = gateWith([
			{ tool: "a" },
			{ tool: "b", requiresConfirm: true },
			{ tool: "c", pathParams: ["path"] },
		]);
		await ask("a");
		await ask("b");
		await ask("c", { path: "/etc/passwd" });
		await ask("unknown");
		expect(audit).toHaveLength(4);
		expect(audit.map((e) => e.decision)).toEqual([
			"allowed",
			"await_confirm",
			"blocked",
			"blocked",
		]);
	});
});

describe("权限门 · 不吞异常（fail-closed 依赖内核）", () => {
	it("审计回调抛异常时异常向上传播", async () => {
		// M0 验证过内核在 before_tool 抛异常时 fail-closed（拒绝执行）。
		// 所以这里刻意不 try/catch —— 自己兜底反而可能把拒绝变成放行。
		const gate = createPermissionGate({
			policies: [{ tool: "read_table" }],
			workspace: WORKSPACE,
			audit: () => {
				throw new Error("审计写入失败");
			},
		});
		await expect(
			gate({ toolName: "read_table", args: {}, tenant: TENANT, taskId: "t" }),
		).rejects.toThrow("审计写入失败");
	});
});
