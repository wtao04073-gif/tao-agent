/**
 * 权限门 × 真实内核 的端到端测试
 *
 * 为什么单元测试不够：`permission-gate.test.ts` 证明策略判断正确，
 * 但它不经过内核 —— 接线出错（钩子没注册、决策没转成 block）时
 * 单元测试依然全绿，而实际防护为零。这里跑真实内核验证防线真的在。
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../../../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../vendor/pi/agent/src/harness/session/session.ts";
import { type AuditEntry, createPermissionGate, type PlatformTool } from "@tao/core";
import { afterEach, describe, expect, it } from "vitest";
import { InProcessRunnerFactory } from "../src/in-process-runner.ts";

const WORKSPACE = "/workspace/task-1";
const openSessions: StorageBackedSession[] = [];

/** 一个会记录自己是否被执行的文件读取工具。 */
function fileTool(name: string) {
	const readPaths: string[] = [];
	const tool: PlatformTool = {
		name,
		label: "读取文件",
		description: "读取一个文件",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		async execute({ args }) {
			const path = (args as { path: string }).path;
			readPaths.push(path);
			return { text: `已读取 ${path}` };
		},
	};
	return { tool, readPaths };
}

async function setup(options: {
	policies: Parameters<typeof createPermissionGate>[0]["policies"];
	grantedDirs?: string[];
	toolName: string;
}) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const audit: AuditEntry[] = [];

	const factory = new InProcessRunnerFactory({
		async createSession(sessionId) {
			const session = new StorageBackedSession(
				{ id: sessionId, createdAt: 1, storageVersion: 1 },
				new MemoryStorage(),
			);
			openSessions.push(session);
			return session;
		},
		models,
		model: faux.getModel(),
		now: () => 1000,
	});

	const { tool, readPaths } = fileTool(options.toolName);
	const runner = await factory.createRunner({
		tenant: { tenantId: "t1", workspaceId: "w1", userId: "u1" },
		taskId: "task-1",
		sessionId: "session-1",
		systemPrompt: "你是办公助手",
		tools: [tool],
		gate: createPermissionGate({
			policies: options.policies,
			workspace: WORKSPACE,
			grantedDirs: options.grantedDirs ?? [],
			audit: (e) => void audit.push(e),
		}),
	});

	return { runner, faux, readPaths, audit };
}

describe("权限门 × 真实内核", () => {
	afterEach(async () => {
		for (const s of openSessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
	});

	it("模型索取 /etc/passwd 时被真实拦下，工具零次执行", async () => {
		const { runner, faux, readPaths, audit } = await setup({
			policies: [{ tool: "read_file", pathParams: ["path"] }],
			toolName: "read_file",
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read_file", { path: "/etc/passwd" })]),
			fauxAssistantMessage("无法读取该文件"),
		]);
		await runner.prompt("帮我看看 /etc/passwd");

		// 防线真的在：工具一次都没执行
		expect(readPaths).toEqual([]);
		expect(audit[0]?.decision).toBe("blocked");
		expect(audit[0]?.rule).toBe("system");

		await runner.close();
	});

	it("模型索取 SSH 私钥时被拦下", async () => {
		const { runner, faux, readPaths, audit } = await setup({
			policies: [{ tool: "read_file", pathParams: ["path"] }],
			toolName: "read_file",
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read_file", { path: "/home/u/.ssh/id_rsa" })]),
			fauxAssistantMessage("无法读取"),
		]);
		await runner.prompt("读一下我的 ssh key");

		expect(readPaths).toEqual([]);
		expect(audit[0]?.rule).toBe("credential");

		await runner.close();
	});

	it("工作区内的正常文件放行，工具真的执行", async () => {
		// 反向验证：若「零次执行」在任何情况下都成立，前面的断言就是装饰。
		const { runner, faux, readPaths, audit } = await setup({
			policies: [{ tool: "read_file", pathParams: ["path"] }],
			toolName: "read_file",
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read_file", { path: "对账单.xlsx" })]),
			fauxAssistantMessage("已读取"),
		]);
		await runner.prompt("读对账单");

		expect(readPaths).toEqual(["对账单.xlsx"]);
		expect(audit[0]?.decision).toBe("allowed");

		await runner.close();
	});

	it("未登记的工具即使已注册到内核也无法执行", async () => {
		// 双层防御的意义：工具在注册表里，但权限门没登记 → 仍然拒绝
		const { runner, faux, readPaths } = await setup({
			policies: [], // 空白名单
			toolName: "read_file",
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read_file", { path: "harmless.xlsx" })]),
			fauxAssistantMessage("done"),
		]);
		await runner.prompt("读文件");

		expect(readPaths).toEqual([]);

		await runner.close();
	});

	it("授权目录生效，但其中的凭据文件仍被拒（不留配置口子）", async () => {
		const { runner, faux, readPaths, audit } = await setup({
			policies: [{ tool: "read_file", pathParams: ["path"] }],
			grantedDirs: ["/mnt/share"],
			toolName: "read_file",
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read_file", { path: "/mnt/share/对账单.xlsx" })]),
			fauxAssistantMessage([fauxToolCall("read_file", { path: "/mnt/share/deploy.pem" })]),
			fauxAssistantMessage("done"),
		]);
		await runner.prompt("读共享盘");

		// 授权目录内的业务文件放行，凭据文件拒绝
		expect(readPaths).toEqual(["/mnt/share/对账单.xlsx"]);
		expect(audit.map((e) => e.decision)).toEqual(["allowed", "blocked"]);
		expect(audit[1]?.rule).toBe("credential");

		await runner.close();
	});

	it("高危动作转确认时工具不执行，事件标为 await_confirm", async () => {
		const { runner, faux, readPaths } = await setup({
			policies: [
				{
					tool: "read_file",
					pathParams: ["path"],
					requiresConfirm: true,
					confirmReason: "该操作将覆盖已有文件，请确认",
				},
			],
			toolName: "read_file",
		});

		const decisions: string[] = [];
		runner.subscribe((e) => {
			if (e.type === "tool_decision") decisions.push(e.decision);
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read_file", { path: "out.xlsx" })]),
			fauxAssistantMessage("done"),
		]);
		await runner.prompt("覆盖写入");

		expect(readPaths).toEqual([]);
		expect(decisions).toEqual(["await_confirm"]);

		await runner.close();
	});
});
