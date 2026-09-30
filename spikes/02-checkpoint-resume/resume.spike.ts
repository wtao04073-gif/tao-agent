/**
 * Spike 2 · 检查点续跑
 *
 * 验证问题：长任务执行到一半进程崩溃，重启后能否从检查点接力，
 * **且已完成的步骤不重复消耗模型调用**？
 *
 * 为什么必须验证：这是 Spec 验收标准「执行节点强制重启后，任务可从检查点续跑，
 * 已完成步骤不重复消耗模型调用」的唯一验证方式。重复消耗直接推高成本，
 * 而成本目标（≤10 元/人/月）是产品能否卖动的关键。
 *
 * 两个关键设计决定（来自对源码的核实，均与最初假设相反）：
 *
 *   1. **不能用底层 agent-loop 验证。** 那一层无持久化，且 `runAgentLoop` 被调用
 *      一次就必然发起至少一次模型请求（`hasMoreToolCalls` 初值为 true，
 *      streamAssistantResponse 在任何 tool-call 检查之前）。`Agent.continue()`
 *      在历史尾部是 assistant 时**抛错**而非幂等跳过 —— 抛错 ≠ 续跑。
 *      「不重复消耗」只在 harness 层成立，由耐久 OperationState 的离散叶子决定。
 *
 *   2. **必须用真实文件后端。** 上游 harness 层的 resume 测试全部跑在 MemoryStorage
 *      上，没有一个跑在 JsonlSessionRepo 上 —— 「真进程重启」这条端到端路径
 *      是上游测试的空白，而它恰恰是我们的验收标准。
 */

import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "../../vendor/pi/agent/src/harness/context.ts";
import { NodeExecutionEnv } from "../../vendor/pi/agent/src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../vendor/pi/agent/src/harness/session/jsonl/repo.ts";
import { restoreLane } from "../../vendor/pi/agent/src/harness/runtime/restore.ts";

const tempDirs: string[] = [];
const openRepos: JsonlSessionRepo[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "spike2-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * 打开一个基于真实 JSONL 文件的 repo。
 *
 * 模拟「进程重启」的方式：丢弃全部内存对象（repo、harness、lane、faux），
 * 用同一个磁盘目录重新构造。这样恢复只能依赖落盘内容，
 * 任何依赖内存状态的实现都会在这里暴露。
 */
function openRepo(cwd: string): JsonlSessionRepo {
	const repo = new JsonlSessionRepo({
		fileSystem: new NodeExecutionEnv({ cwd }),
		sessionsRoot: join(cwd, "sessions"),
	});
	openRepos.push(repo);
	return repo;
}

describe("Spike 2 · 检查点续跑（真实文件后端）", () => {
	afterEach(async () => {
		for (const repo of openRepos.splice(0)) await repo.close(BACKGROUND_CONTEXT).catch(() => {});
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("会话内容真正落盘：重建 repo 后能读回完整历史", async () => {
		const cwd = createTempDir();

		// —— 第一个「进程」：写入内容后关闭 ——
		{
			const repo = openRepo(cwd);
			const session = await repo.create({ id: "task-1", cwd }, BACKGROUND_CONTEXT);
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			faux.setResponses([fauxAssistantMessage("persisted-answer")]);

			const { harness } = await AgentHarness.create(
				{ session, models, model: faux.getModel() },
				BACKGROUND_CONTEXT,
			);
			const lane = await harness.lane("main", BACKGROUND_CONTEXT);
			await lane.prompt("persisted-question", [], BACKGROUND_CONTEXT);
			await session.close(BACKGROUND_CONTEXT);
			await repo.close(BACKGROUND_CONTEXT);
		}

		// —— 第二个「进程」：全新 repo，只能靠磁盘 ——
		const repo2 = openRepo(cwd);
		const listed = await repo2.list({ cwd }, BACKGROUND_CONTEXT);
		expect(listed.map((m) => m.id)).toContain("task-1");

		const reopened = await repo2.open(
			listed.find((m) => m.id === "task-1")!,
			BACKGROUND_CONTEXT,
		);
		const dump = JSON.stringify(
			await reopened.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
		);
		expect(dump).toContain("persisted-question");
		expect(dump).toContain("persisted-answer");
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("核心验收：已完成的任务重启后零模型调用（不重复消耗）", async () => {
		const cwd = createTempDir();

		// —— 进程 1：跑完一轮任务 ——
		{
			const repo = openRepo(cwd);
			const session = await repo.create({ id: "task-2", cwd }, BACKGROUND_CONTEXT);
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			faux.setResponses([fauxAssistantMessage("finished-work")]);

			const { harness } = await AgentHarness.create(
				{ session, models, model: faux.getModel() },
				BACKGROUND_CONTEXT,
			);
			const lane = await harness.lane("main", BACKGROUND_CONTEXT);
			await lane.prompt("long-running-task", [], BACKGROUND_CONTEXT);
			expect(faux.state.callCount).toBe(1); // 第一次执行确实调了模型
			await session.close(BACKGROUND_CONTEXT);
			await repo.close(BACKGROUND_CONTEXT);
		}

		// —— 进程 2：重启，用**全新的** faux（调用计数从 0 开始）——
		const repo2 = openRepo(cwd);
		const metadata = (await repo2.list({ cwd }, BACKGROUND_CONTEXT)).find((m) => m.id === "task-2")!;
		const session2 = await repo2.open(metadata, BACKGROUND_CONTEXT);

		const faux2 = fauxProvider();
		const models2 = createModels();
		models2.setProvider(faux2.provider);
		// 刻意不给任何响应：若恢复过程试图调模型，会立刻暴露为错误
		const { harness: harness2, open } = await AgentHarness.create(
			{ session: session2, models: models2, model: faux2.getModel() },
			BACKGROUND_CONTEXT,
		);

		// 已完成的任务不应留下待续跑的操作
		expect(open).toEqual([]);

		// 核心断言：恢复过程零模型调用
		expect(faux2.state.callCount).toBe(0);

		// 历史完整可读（恢复不是靠丢弃状态换来的）
		const lane2 = await harness2.lane("main", BACKGROUND_CONTEXT);
		const dump = JSON.stringify(await lane2.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT));
		expect(dump).toContain("long-running-task");
		expect(dump).toContain("finished-work");
		expect(faux2.state.callCount).toBe(0); // 读历史也不触发模型

		await session2.close(BACKGROUND_CONTEXT);
	});

	it("resume 幂等：对已完成的任务调 resume 返回 NothingToResume 且不调模型", async () => {
		const cwd = createTempDir();

		const repo = openRepo(cwd);
		const session = await repo.create({ id: "task-3", cwd }, BACKGROUND_CONTEXT);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("done-once")]);

		const { harness } = await AgentHarness.create(
			{ session, models, model: faux.getModel() },
			BACKGROUND_CONTEXT,
		);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await lane.prompt("task", [], BACKGROUND_CONTEXT);

		const callsAfterRun = faux.state.callCount;
		expect(callsAfterRun).toBe(1);

		// 反复 resume 都不应再消耗模型调用 —— 这是幂等性的直接验证。
		// 生产环境里恢复逻辑可能被重复触发（重试、多副本抢占），
		// 若 resume 不幂等就会重复计费。
		for (let i = 0; i < 3; i++) {
			const result = await lane.resume(BACKGROUND_CONTEXT);
			expect(result.ok).toBe(false); // NothingToResume
			expect(faux.state.callCount).toBe(callsAfterRun);
		}

		await session.close(BACKGROUND_CONTEXT);
	});

	it("黄金不变量：内存中的 lane 状态与从磁盘恢复出的状态完全相等", async () => {
		// 这是上游自己用的核心不变量（expectProjectionRestores）。
		// 它的含义是「任意时刻拔电，恢复后状态一致」——
		// 比逐字段断言更强，因为它覆盖全部字段而不是我们想到的那几个。
		const cwd = createTempDir();

		const repo = openRepo(cwd);
		const session = await repo.create({ id: "task-4", cwd }, BACKGROUND_CONTEXT);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);

		const { harness } = await AgentHarness.create(
			{ session, models, model: faux.getModel() },
			BACKGROUND_CONTEXT,
		);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);

		await lane.prompt("turn-1", [], BACKGROUND_CONTEXT);
		expect(lane.state).toEqual(await restoreLane(session, "main", BACKGROUND_CONTEXT));

		await lane.prompt("turn-2", [], BACKGROUND_CONTEXT);
		expect(lane.state).toEqual(await restoreLane(session, "main", BACKGROUND_CONTEXT));

		await session.close(BACKGROUND_CONTEXT);
	});

	it("反向验证：断言真的能失败（新任务重启后确实会调模型）", async () => {
		// 若「零模型调用」的断言在任何情况下都成立，它就只是装饰。
		// 这里证明：同样的重启路径下，提交新任务确实会消耗模型调用。
		const cwd = createTempDir();

		{
			const repo = openRepo(cwd);
			const session = await repo.create({ id: "task-5", cwd }, BACKGROUND_CONTEXT);
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			faux.setResponses([fauxAssistantMessage("first")]);
			const { harness } = await AgentHarness.create(
				{ session, models, model: faux.getModel() },
				BACKGROUND_CONTEXT,
			);
			const lane = await harness.lane("main", BACKGROUND_CONTEXT);
			await lane.prompt("original", [], BACKGROUND_CONTEXT);
			await session.close(BACKGROUND_CONTEXT);
			await repo.close(BACKGROUND_CONTEXT);
		}

		const repo2 = openRepo(cwd);
		const metadata = (await repo2.list({ cwd }, BACKGROUND_CONTEXT)).find((m) => m.id === "task-5")!;
		const session2 = await repo2.open(metadata, BACKGROUND_CONTEXT);
		const faux2 = fauxProvider();
		const models2 = createModels();
		models2.setProvider(faux2.provider);
		faux2.setResponses([fauxAssistantMessage("second")]);

		const { harness: harness2 } = await AgentHarness.create(
			{ session: session2, models: models2, model: faux2.getModel() },
			BACKGROUND_CONTEXT,
		);
		const lane2 = await harness2.lane("main", BACKGROUND_CONTEXT);

		expect(faux2.state.callCount).toBe(0); // 恢复本身不调
		await lane2.prompt("follow-up", [], BACKGROUND_CONTEXT);
		expect(faux2.state.callCount).toBe(1); // 新任务会调 —— 证明计数器有效

		// 且旧历史仍在（续跑是在原有上下文上继续，不是重新开始）
		const dump = JSON.stringify(await lane2.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT));
		expect(dump).toContain("original");
		expect(dump).toContain("follow-up");

		await session2.close(BACKGROUND_CONTEXT);
	});
});
