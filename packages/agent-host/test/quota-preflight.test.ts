/**
 * M5-5 出网前配额闸测试
 *
 * 验收硬指标：超配额账号提交「不调任何工具、只让模型生成长文本」的任务，
 * 必须在**第一次模型调用之前**被拒，且零模型消耗。
 *
 * 用 faux 模型 + 一个纯文本响应（不含工具调用）模拟纯文本任务：若预检不生效，
 * 模型会被真正调用并产生 usage；预检生效时 prompt 在出网前抛出、无 usage 事件。
 */

import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../../../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../vendor/pi/agent/src/harness/session/session.ts";
import type { QuotaVerdict, TaskEvent, TenantContext, ToolDecision } from "@tao/core";
import { afterEach, describe, expect, it } from "vitest";
import { InProcessRunnerFactory, type HostRuntime } from "../src/in-process-runner.ts";

const TENANT: TenantContext = { tenantId: "t1", workspaceId: "w1", userId: "u1" };
const openSessions: StorageBackedSession[] = [];
afterEach(async () => {
	for (const s of openSessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
});

function runtime(preflight: HostRuntime["preflightModel"]) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let clock = 1000;
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
		now: () => (clock += 1),
		...(preflight === undefined ? {} : { preflightModel: preflight }),
	});
	return { factory, faux };
}

const allowAll: ToolDecision = { kind: "allow" };

describe("M5-5 出网前配额闸", () => {
	it("预检超限时 prompt 在第一次模型调用前抛出，且无任何 usage 事件（零消耗）", async () => {
		const exceeded: QuotaVerdict = {
			ok: false,
			reason: "本月 token 额度已用完，请联系管理员调整配额",
			exceeded: "tokens",
		};
		let checked = 0;
		const { factory, faux } = runtime(() => {
			checked += 1;
			return Promise.resolve(exceeded);
		});

		// 准备一个纯文本响应（无工具调用）——若模型被调用就会产生 usage
		faux.setResponses([fauxAssistantMessage("这是一段很长的纯文本回答……")]);

		const runner = await factory.createRunner({
			tenant: TENANT,
			taskId: "quota-1",
			sessionId: "quota-1",
			systemPrompt: "s",
			tools: [],
			gate: () => allowAll,
		});
		const events: TaskEvent[] = [];
		runner.subscribe((e) => void events.push(e));

		await expect(runner.prompt("随便写点什么")).rejects.toThrow(/额度已用完/);

		expect(checked).toBe(1);
		// 模型零消耗；页面仍收到准备与失败步骤，不会伪装成没有执行反馈
		expect(events.filter((e) => e.type === "usage")).toHaveLength(0);
		expect(events.filter(e=>e.type==="step").map(e=>e.type==="step"?e.phase:"")).toEqual(["started","failed"]);
        expect(events.filter(e=>e.type==="artifact")).toHaveLength(0);
		await runner.close();
	});

	it("预检放行（ok:true）时任务正常执行", async () => {
		const { factory, faux } = runtime(() => Promise.resolve({ ok: true }));
		faux.setResponses([fauxAssistantMessage("好的")]);
		const runner = await factory.createRunner({
			tenant: TENANT,
			taskId: "quota-2",
			sessionId: "quota-2",
			systemPrompt: "s",
			tools: [],
			gate: () => allowAll,
		});
		await runner.prompt("你好");
		await runner.close();
	});

	it("预检返回 undefined（未配配额）时不拦截，模型正常调用", async () => {
		const { factory, faux } = runtime(() => Promise.resolve(undefined));
		faux.setResponses([fauxAssistantMessage("无配额限制")]);
		const runner = await factory.createRunner({
			tenant: TENANT,
			taskId: "quota-3",
			sessionId: "quota-3",
			systemPrompt: "s",
			tools: [],
			gate: () => allowAll,
		});
		await runner.prompt("继续");
		await runner.close();
	});
});
