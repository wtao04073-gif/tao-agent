/**
 * M5-5 验收：轻量档有真实可验证的选路入口
 *
 * 缺陷背景：RunnerSpec.tier 只有声明和读取，SubmitOptions / 编排器 / HTTP
 * 都不写 tier，lite 永远不生效。本用例装配**双端点**（两个 faux provider，
 * 各自一个不同模型 id），分别以 tier:"lite" 与 tier:"flagship" 跑一次，
 * 断言落账 UsageRecord.model 与实际调用的模型一致 —— 防止计量模型名错档。
 */

import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../vendor/pi/agent/src/harness/session/session.ts";
import { TaskStatus, type TenantContext, type UsageRecord } from "@tao/core";
import { MemoryMeteringStore } from "@tao/knowledge";
import { InProcessRunnerFactory } from "@tao/agent-host";
import { TaskOrchestrator } from "@tao/orchestrator";
import { afterEach, describe, expect, it } from "vitest";

const TENANT: TenantContext = { tenantId: "tier-001", workspaceId: "qa", userId: "u" };
const NOW = 1_700_000_000_000;
const FLAG_MODEL = "flagship-model-x";
const LITE_MODEL = "lite-model-y";

const sessions: StorageBackedSession[] = [];
afterEach(async () => {
	for (const s of sessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
});

/** 装配双端点：两个 faux provider（不同 provider id / model id）。 */
function buildDualRuntime() {
	const models = createModels();

	const flag = fauxProvider({
		provider: "tier-flagship",
		models: [{ id: FLAG_MODEL, name: FLAG_MODEL }],
	});
	const lite = fauxProvider({
		provider: "tier-lite",
		models: [{ id: LITE_MODEL, name: LITE_MODEL }],
	});
	models.setProvider(flag.provider);
	models.setProvider(lite.provider);

	flag.setResponses([fauxAssistantMessage("旗舰答复")]);
	lite.setResponses([fauxAssistantMessage("轻量答复")]);

	return {
		models,
		flag,
		lite,
		modelForTier: (tier: "flagship" | "lite") =>
			(tier === "lite" ? lite.getModel() : flag.getModel()) as never,
	};
}

async function runWithTier(tier: "flagship" | "lite", taskId: string) {
	const runtime = buildDualRuntime();
	const store = new MemoryMeteringStore();
	const factory = new InProcessRunnerFactory({
		async createSession(id) {
			const session = new StorageBackedSession(
				{ id, createdAt: 1, storageVersion: 1 },
				new MemoryStorage(),
			);
			sessions.push(session);
			return session;
		},
		models: runtime.models,
		model: runtime.flag.getModel() as never,
		modelForTier: runtime.modelForTier,
		now: () => NOW,
		meter: (r) => store.record(r as UsageRecord),
	});
	const orchestrator = new TaskOrchestrator(factory, { now: () => NOW });

	await orchestrator.submit({
		tenant: TENANT,
		taskId,
		sessionId: taskId,
		prompt: "你好",
		systemPrompt: "s",
		tools: [],
		gate: async () => ({ kind: "allow" }),
		tier,
	});
	const result = await orchestrator.run(taskId, "你好");
	const records = await store.list(TENANT.tenantId, { from: NOW - 1000, to: NOW + 1_000_000 });
	return { result, records };
}

describe("M5-5 档位选路", () => {
	it("tier:lite 的用量落账到轻量模型名，且只有轻量端点被调用", async () => {
		const { result, records } = await runWithTier("lite", "tier-lite-1");
		expect(result.status).toBe(TaskStatus.Succeeded);
		expect(records.length).toBeGreaterThan(0);
		expect(records.every((r) => r.model === LITE_MODEL)).toBe(true);
		expect(records.some((r) => r.model === FLAG_MODEL)).toBe(false);
	});

	it("tier:flagship 的用量落账到旗舰模型名", async () => {
		const { result, records } = await runWithTier("flagship", "tier-flag-1");
		expect(result.status).toBe(TaskStatus.Succeeded);
		expect(records.length).toBeGreaterThan(0);
		expect(records.every((r) => r.model === FLAG_MODEL)).toBe(true);
	});

	it("缺省 tier 回落旗舰（与既有单模型装配语义一致）", async () => {
		const runtime = buildDualRuntime();
		const store = new MemoryMeteringStore();
		const factory = new InProcessRunnerFactory({
			async createSession(id) {
				const session = new StorageBackedSession(
					{ id, createdAt: 1, storageVersion: 1 },
					new MemoryStorage(),
				);
				sessions.push(session);
				return session;
			},
			models: runtime.models,
			model: runtime.flag.getModel() as never,
			modelForTier: runtime.modelForTier,
			now: () => NOW,
			meter: (r) => store.record(r as UsageRecord),
		});
		const orchestrator = new TaskOrchestrator(factory, { now: () => NOW });
		const taskId = "tier-default-1";
		// 注意：这里不传 tier
		await orchestrator.submit({
			tenant: TENANT,
			taskId,
			sessionId: taskId,
			prompt: "你好",
			systemPrompt: "s",
			tools: [],
			gate: async () => ({ kind: "allow" }),
		});
		await orchestrator.run(taskId, "你好");
		const records = await store.list(TENANT.tenantId, { from: NOW - 1000, to: NOW + 1_000_000 });
		expect(records.every((r) => r.model === FLAG_MODEL)).toBe(true);
	});
});
