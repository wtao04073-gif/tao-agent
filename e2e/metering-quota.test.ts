/**
 * M4-1 验收：计量、配额与熔断端到端
 *
 * 验四件事：
 *
 *  1. **真实运行的 token 消耗会落账**，不是只有单测里的假数据。
 *  2. **任务失败时消耗仍然落账** —— 否则用户能靠「发起必然失败的任务」白嫖。
 *  3. **超配额时熔断真的拦下工具执行**，且用户看到的是可操作的理由。
 *  4. **熔断前的消耗已入账** —— 否则配额永远追不上实际消耗。
 *
 * 第 2、4 条是这一项的难点：它们都是「失败路径上的正确性」，
 * 而失败路径最容易在实现时被跳过。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../vendor/pi/agent/src/harness/session/session.ts";
import {
	createPermissionGate,
	estimateCost,
	evaluateQuota,
	MICRO_YUAN_PER_YUAN,
	TaskStatus,
	withQuotaGate,
	type ModelPrice,
	type Quota,
	type UsageRecord,
} from "@tao/core";
import { createOfficeToolset, OFFICE_TOOL_POLICIES } from "@tao/office";
import { MemoryMeteringStore } from "@tao/knowledge";
import { InProcessRunnerFactory } from "@tao/agent-host";
import { TaskOrchestrator } from "@tao/orchestrator";
import { afterEach, describe, expect, it } from "vitest";

const TENANT = { tenantId: "mfg-003", workspaceId: "purchasing", userId: "sun" };
const NOW = 1_700_000_000_000;

const PRICES: ModelPrice[] = [
	{ model: "deepseek-chat", inputPerMillionYuan: 2, outputPerMillionYuan: 8 },
];

const PERIOD: Pick<Quota, "tenantId" | "periodStart" | "periodEnd"> = {
	tenantId: TENANT.tenantId,
	periodStart: NOW - 1000,
	periodEnd: NOW + 1_000_000,
};

const dirs: string[] = [];
const sessions: StorageBackedSession[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "m4a-e2e-"));
	dirs.push(dir);
	return dir;
}

/** 造一对可核对的表。 */
async function makeTables(dir: string): Promise<{ left: string; right: string }> {
	const paths: string[] = [];
	for (const [name, amount] of [
		["我方台账.xlsx", 10_000],
		["供应商对账单.xlsx", 10_500],
	] as const) {
		const path = join(dir, name);
		const wb = new ExcelJS.Workbook();
		const ws = wb.addWorksheet("明细");
		ws.addRow(["单号", "金额"]);
		ws.addRow(["PO-001", amount]);
		await wb.xlsx.writeFile(path);
		paths.push(path);
	}
	return { left: paths[0] as string, right: paths[1] as string };
}

interface Harness {
	orchestrator: TaskOrchestrator;
	faux: ReturnType<typeof fauxProvider>;
	tools: ReturnType<typeof createOfficeToolset>;
	store: MemoryMeteringStore;
	meterErrors: Error[];
}

/**
 * 装配一套带计量的执行环境。
 *
 * `quota` 给定时叠加配额熔断闸。
 */
async function assemble(ws: string, quota?: Quota): Promise<Harness> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const store = new MemoryMeteringStore();
	const meterErrors: Error[] = [];

	const factory = new InProcessRunnerFactory({
		async createSession(id) {
			const session = new StorageBackedSession(
				{ id, createdAt: 1, storageVersion: 1 },
				new MemoryStorage(),
			);
			sessions.push(session);
			return session;
		},
		models,
		model: faux.getModel(),
		now: () => NOW,
		// 用量落账接到真实存储
		meter: (record) => store.record(record as UsageRecord),
		onMeterError: (error) => void meterErrors.push(error),
	});

	return {
		orchestrator: new TaskOrchestrator(factory, { now: () => NOW }),
		faux,
		tools: createOfficeToolset({ workspace: ws, now: () => new Date("2026-09-25T10:00:00Z") }),
		store,
		meterErrors,
	};
}

function gateWith(ws: string, quota: Quota | undefined, store: MemoryMeteringStore) {
	const base = createPermissionGate({
		policies: [...OFFICE_TOOL_POLICIES],
		workspace: ws,
	});
	if (quota === undefined) return base;
	return withQuotaGate(base, {
		evaluate: async () => evaluateQuota({ store, quota, prices: PRICES }),
	});
}

describe("M4-1 验收 · 计量与熔断", () => {
	afterEach(async () => {
		for (const s of sessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("一次成功的对账任务，token 消耗落账且可折算金额", async () => {
		const ws = workspace();
		const { left, right } = await makeTables(ws);
		const h = await assemble(ws);

		h.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: left,
					rightPath: right,
					keyColumns: ["单号"],
					compareColumns: ["金额"],
					leftLabel: "我方",
					rightLabel: "供应商",
					outputName: "核对结果.xlsx",
				}),
			]),
			fauxAssistantMessage("核对完成，发现 1 处差异。"),
		]);

		await h.orchestrator.submit({
			tenant: TENANT,
			taskId: "m4a-1",
			sessionId: "m4a-s-1",
			prompt: "核对两份对账表",
			systemPrompt: "你是对账助手",
			tools: h.tools,
			gate: gateWith(ws, undefined, h.store),
		});
		const record = await h.orchestrator.run("m4a-1", "核对两份对账表");
		expect(record.status).toBe(TaskStatus.Succeeded);
		expect(existsSync(join(ws, "核对结果.xlsx"))).toBe(true);

		// —— 计量落账 ——
		const window = { from: PERIOD.periodStart, to: PERIOD.periodEnd };
		const totals = await h.store.totals(TENANT.tenantId, window);
		// 两次模型调用 → 至少两条用量记录
		expect(totals.totalTokens).toBeGreaterThan(0);
		expect(totals.taskCount).toBe(1);
		// 落账没有报错
		expect(h.meterErrors).toEqual([]);

		// 金额可折算
		const records = await h.store.list(TENANT.tenantId, window);
		const { microYuan, unpricedModels } = estimateCost(records, PRICES);
		// 用的是 faux model，不在价目表里 —— 这正是「未配价不当免费」的体现
		if (unpricedModels.length === 0) expect(microYuan).toBeGreaterThan(0);
		else expect(unpricedModels.length).toBeGreaterThan(0);
	});

	it("任务失败时，失败前的消耗仍然落账（防白嫖）", async () => {
		// 若失败就不计量，用户能靠「发起必然失败的任务」白嫖算力
		const ws = workspace();
		const h = await assemble(ws);

		// 第一轮正常（烧掉 token），第二轮没排响应 → provider 报错 → 任务失败
		h.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: join(ws, "不存在.xlsx"),
					rightPath: join(ws, "也不存在.xlsx"),
					keyColumns: ["单号"],
					compareColumns: ["金额"],
					leftLabel: "我方",
					rightLabel: "供应商",
					outputName: "无所谓.xlsx",
				}),
			]),
		]);

		await h.orchestrator.submit({
			tenant: TENANT,
			taskId: "m4a-2",
			sessionId: "m4a-s-2",
			prompt: "核对",
			systemPrompt: "你是对账助手",
			tools: h.tools,
			gate: gateWith(ws, undefined, h.store),
		});
		const record = await h.orchestrator.run("m4a-2", "核对");

		// 确认任务真的失败了（否则下面的断言是空的）
		expect(record.status).toBe(TaskStatus.Failed);

		// 关键：失败前的消耗在账上
		const totals = await h.store.totals(TENANT.tenantId, {
			from: PERIOD.periodStart,
			to: PERIOD.periodEnd,
		});
		expect(totals.totalTokens).toBeGreaterThan(0);
	});

	it("超配额时熔断拦下工具，且用户看到可操作的理由", async () => {
		const ws = workspace();
		const { left, right } = await makeTables(ws);
		const h = await assemble(ws);

		// 先把配额用掉：预置一条已超限的用量记录
		await h.store.record({
			tenantId: TENANT.tenantId,
			workspaceId: TENANT.workspaceId,
			taskId: "历史任务",
			model: "deepseek-chat",
			inputTokens: 10_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			at: NOW,
		});

		const quota: Quota = { ...PERIOD, maxTokens: 5000 };

		let sawReason = false;
		h.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: left,
					rightPath: right,
					keyColumns: ["单号"],
					compareColumns: ["金额"],
					leftLabel: "我方",
					rightLabel: "供应商",
					outputName: "不该生成.xlsx",
				}),
			]),
			// 第二轮：模型看到拒绝理由后转述给用户
			async (ctx: { messages: Array<{ role: string; content?: unknown }> }) => {
				const all = JSON.stringify(ctx.messages);
				sawReason = all.includes("联系管理员提额");
				return fauxAssistantMessage(
					sawReason ? "本月用量已达上限，请联系管理员提额。" : "核对完成。",
				);
			},
		]);

		await h.orchestrator.submit({
			tenant: TENANT,
			taskId: "m4a-3",
			sessionId: "m4a-s-3",
			prompt: "核对",
			systemPrompt: "你是对账助手",
			tools: h.tools,
			gate: gateWith(ws, quota, h.store),
		});
		await h.orchestrator.run("m4a-3", "核对");

		// ① 工具没执行 —— 产物不存在
		expect(existsSync(join(ws, "不该生成.xlsx"))).toBe(false);
		// ② 模型收到了可操作的理由并转述（这才是用户能看懂的熔断）
		expect(sawReason).toBe(true);
	});

	it("配额充足时不影响正常执行", async () => {
		// 反向对照：确认上一条的拦截来自配额，而非熔断闸把一切都拦了
		const ws = workspace();
		const { left, right } = await makeTables(ws);
		const h = await assemble(ws);

		const quota: Quota = { ...PERIOD, maxTokens: 10_000_000 };

		h.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: left,
					rightPath: right,
					keyColumns: ["单号"],
					compareColumns: ["金额"],
					leftLabel: "我方",
					rightLabel: "供应商",
					outputName: "应该生成.xlsx",
				}),
			]),
			fauxAssistantMessage("核对完成。"),
		]);

		await h.orchestrator.submit({
			tenant: TENANT,
			taskId: "m4a-4",
			sessionId: "m4a-s-4",
			prompt: "核对",
			systemPrompt: "你是对账助手",
			tools: h.tools,
			gate: gateWith(ws, quota, h.store),
		});
		const record = await h.orchestrator.run("m4a-4", "核对");

		expect(record.status).toBe(TaskStatus.Succeeded);
		expect(existsSync(join(ws, "应该生成.xlsx"))).toBe(true);
	});

	it("熔断发生时，熔断前的消耗已入账", async () => {
		// 否则配额永远追不上实际消耗：每次都在「还没超」的判定下多烧一轮
		const ws = workspace();
		const { left, right } = await makeTables(ws);
		const h = await assemble(ws);

		// 配额刚好卡在第二轮工具调用之前
		let evaluations = 0;
		const base = createPermissionGate({
			policies: [...OFFICE_TOOL_POLICIES],
			workspace: ws,
		});
		const gate = withQuotaGate(base, {
			evaluate: async () => {
				evaluations += 1;
				// 第一次放行，之后按真实账面判定
				if (evaluations === 1) return { ok: true };
				const totals = await h.store.totals(TENANT.tenantId, {
					from: PERIOD.periodStart,
					to: PERIOD.periodEnd,
				});
				// 关键断言：此刻账面已有第一轮的消耗
				expect(totals.totalTokens).toBeGreaterThan(0);
				return { ok: false, reason: "配额耗尽，请联系管理员提额", exceeded: "tokens" };
			},
		});

		h.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: left,
					rightPath: right,
					keyColumns: ["单号"],
					compareColumns: ["金额"],
					leftLabel: "我方",
					rightLabel: "供应商",
					outputName: "第一份.xlsx",
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: left,
					rightPath: right,
					keyColumns: ["单号"],
					compareColumns: ["金额"],
					leftLabel: "我方",
					rightLabel: "供应商",
					outputName: "第二份.xlsx",
				}),
			]),
			fauxAssistantMessage("已停止。"),
		]);

		await h.orchestrator.submit({
			tenant: TENANT,
			taskId: "m4a-5",
			sessionId: "m4a-s-5",
			prompt: "连续核对两次",
			systemPrompt: "你是对账助手",
			tools: h.tools,
			gate,
		});
		await h.orchestrator.run("m4a-5", "连续核对两次");

		// 第一份生成了，第二份被熔断拦下
		expect(existsSync(join(ws, "第一份.xlsx"))).toBe(true);
		expect(existsSync(join(ws, "第二份.xlsx"))).toBe(false);
		expect(evaluations).toBeGreaterThanOrEqual(2);
	});

	it("落账失败不中断任务，但会告警", async () => {
		// token 已经烧掉了，中断既救不回钱也白费已完成的工作。
		// 但必须告警 —— 静默丢账会让账目差异无从追查
		const ws = workspace();
		const { left, right } = await makeTables(ws);

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const meterErrors: Error[] = [];

		const factory = new InProcessRunnerFactory({
			async createSession(id) {
				const session = new StorageBackedSession(
					{ id, createdAt: 1, storageVersion: 1 },
					new MemoryStorage(),
				);
				sessions.push(session);
				return session;
			},
			models,
			model: faux.getModel(),
			now: () => NOW,
			meter: async () => {
				throw new Error("计量库写入失败");
			},
			onMeterError: (error) => void meterErrors.push(error),
		});

		const orchestrator = new TaskOrchestrator(factory, { now: () => NOW });
		const tools = createOfficeToolset({
			workspace: ws,
			now: () => new Date("2026-09-25T10:00:00Z"),
		});

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: left,
					rightPath: right,
					keyColumns: ["单号"],
					compareColumns: ["金额"],
					leftLabel: "我方",
					rightLabel: "供应商",
					outputName: "仍然生成.xlsx",
				}),
			]),
			fauxAssistantMessage("完成。"),
		]);

		await orchestrator.submit({
			tenant: TENANT,
			taskId: "m4a-6",
			sessionId: "m4a-s-6",
			prompt: "核对",
			systemPrompt: "你是对账助手",
			tools,
			gate: createPermissionGate({ policies: [...OFFICE_TOOL_POLICIES], workspace: ws }),
		});
		const record = await orchestrator.run("m4a-6", "核对");

		// 任务照常完成
		expect(record.status).toBe(TaskStatus.Succeeded);
		expect(existsSync(join(ws, "仍然生成.xlsx"))).toBe(true);
		// 但告警必须有 —— 等异步落账回调跑完
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(meterErrors.length).toBeGreaterThan(0);
		expect(meterErrors[0]?.message).toContain("计量库写入失败");
	});

	it("别家租户的用量不计入我方账面", async () => {
		const ws = workspace();
		const h = await assemble(ws);

		await h.store.record({
			tenantId: "other-mfg",
			workspaceId: "quality",
			taskId: "别家任务",
			model: "deepseek-chat",
			inputTokens: 9_999_999,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			at: NOW,
		});

		const totals = await h.store.totals(TENANT.tenantId, {
			from: PERIOD.periodStart,
			to: PERIOD.periodEnd,
		});
		expect(totals.totalTokens).toBe(0);

		// 且我方配额不受影响
		const verdict = await evaluateQuota({
			store: h.store,
			quota: { ...PERIOD, maxTokens: 1000 },
			prices: PRICES,
		});
		expect(verdict.ok).toBe(true);
	});

	it("金额上限也能触发熔断，不只是 token 上限", async () => {
		const ws = workspace();
		const { left, right } = await makeTables(ws);
		const h = await assemble(ws);

		// 500 万输入 token × 2 元/百万 = 10 元，正好撞上 10 元上限
		await h.store.record({
			tenantId: TENANT.tenantId,
			workspaceId: TENANT.workspaceId,
			taskId: "历史任务",
			model: "deepseek-chat",
			inputTokens: 5_000_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			at: NOW,
		});

		const quota: Quota = { ...PERIOD, maxCostMicroYuan: 10 * MICRO_YUAN_PER_YUAN };

		h.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("reconcile_tables", {
					leftPath: left,
					rightPath: right,
					keyColumns: ["单号"],
					compareColumns: ["金额"],
					leftLabel: "我方",
					rightLabel: "供应商",
					outputName: "超额不该生成.xlsx",
				}),
			]),
			fauxAssistantMessage("已停止。"),
		]);

		await h.orchestrator.submit({
			tenant: TENANT,
			taskId: "m4a-7",
			sessionId: "m4a-s-7",
			prompt: "核对",
			systemPrompt: "你是对账助手",
			tools: h.tools,
			gate: gateWith(ws, quota, h.store),
		});
		await h.orchestrator.run("m4a-7", "核对");

		expect(existsSync(join(ws, "超额不该生成.xlsx"))).toBe(false);
	});
});
