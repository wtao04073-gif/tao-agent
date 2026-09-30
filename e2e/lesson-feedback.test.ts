/**
 * M3-3 验收：同类任务第二次产出不再犯上次被改的错
 *
 * **这是 M3 的验收门禁，也是整个产品最核心的差异化能力。**
 *
 * 验收标准（需求 §6）原文：同类任务第二次产出不再犯上次被改的错。
 *
 * 这条标准怎么验才不算自欺：
 *
 *  - ❌ 只断言「经验被注入了」—— 那测的是字符串拼接
 *  - ❌ 用假模型硬编码第二次的正确产出 —— 那是测试自己在作弊
 *  - ✅ 让假模型**按注入的上下文决定产出**，再用 `findRepeatedMistakes`
 *       对两次产出做客观判定
 *
 * 第三种做法的关键：假模型的响应函数会读取真实收到的 system prompt。
 * 若经验没被注入，它就产出旧写法；注入了才产出新写法。
 * 这样「经验起作用」成为**可观测的因果关系**，而非我们声称的事实。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemoryStorage } from "../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../vendor/pi/agent/src/harness/session/session.ts";
import {
	activateableTools,
	compileLessons,
	compilePrompt,
	createPermissionGate,
	findRepeatedMistakes,
	learnFromRevisions,
	PRESET_CARDS,
	resolveCard,
	restrictPolicies,
	Scope,
	TaskStatus,
	type AuditEntry,
	type ScenarioCard,
} from "@tao/core";
import {
	createDocToolset,
	createOfficeToolset,
	DOC_TOOL_POLICIES,
	OFFICE_TOOL_POLICIES,
	readDocx,
} from "@tao/office";
import {
	extractDocumentRevisions,
	MemoryLessonStore,
	type ComparableParagraph,
} from "@tao/knowledge";
import { InProcessRunnerFactory } from "@tao/agent-host";
import { TaskOrchestrator } from "@tao/orchestrator";
import { afterEach, describe, expect, it } from "vitest";

const TENANT = { tenantId: "univ-002", workspaceId: "admin", userId: "sun" };
const SCENARIO_ID = "univ.rectification-ledger";
const clock = () => 1_700_000_000_000;

const dirs: string[] = [];
const sessions: StorageBackedSession[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "m3c-e2e-"));
	dirs.push(dir);
	return dir;
}

async function assemble(ws: string) {
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
			sessions.push(session);
			return session;
		},
		models,
		model: faux.getModel(),
		now: () => 1_700_000_000_000,
	});

	const orchestrator = new TaskOrchestrator(factory, { now: () => 1_700_000_000_000 });
	const tools = [
		...createOfficeToolset({ workspace: ws, now: () => new Date("2026-09-25T10:00:00Z") }),
		...createDocToolset({ workspace: ws }),
	];
	const allPolicies = [...OFFICE_TOOL_POLICIES, ...DOC_TOOL_POLICIES];

	return { orchestrator, faux, tools, allPolicies, audit };
}

function gateFor(
	card: ScenarioCard,
	allPolicies: readonly { tool: string; pathParams?: readonly string[] }[],
	ws: string,
	audit: AuditEntry[],
) {
	return createPermissionGate({
		policies: restrictPolicies(allPolicies, card.tools),
		workspace: ws,
		audit: (entry) => void audit.push(entry),
	});
}

/** 台账的表头。第 3 列是那个会被用户改掉的地方。 */
function ledgerBlocks(thirdColumn: string, dateFormat: string) {
	return [
		{
			type: "table",
			header: ["序号", "问题描述", thirdColumn, "完成期限"],
			rows: [["1", "部分课程大纲未及时更新", "教务处", dateFormat]],
		},
	];
}

/** 从产出文档读回可比较的段落。 */
async function readParagraphs(path: string): Promise<ComparableParagraph[]> {
	const { paragraphs } = await readDocx(path);
	return paragraphs.map((p) => ({ index: p.index, text: p.text, isHeading: p.isHeading }));
}

describe("M3-3 验收 · 修改意见回写闭环", () => {
	afterEach(async () => {
		for (const s of sessions.splice(0)) await s.close(BACKGROUND_CONTEXT).catch(() => {});
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("完整闭环：第一次被改 → 学习 → 第二次模型按经验产出，且客观判定不再犯错", async () => {
		const ws = workspace();
		const lessonStore = new MemoryLessonStore();
		const card = resolveCard(PRESET_CARDS, SCENARIO_ID, TENANT.tenantId) as ScenarioCard;
		const formValues = { feedback: ["/ws/检查反馈函.docx"], deadline: "2026-12-31" };

		// ══ 第一轮：没有经验，模型用「负责人」与斜杠日期 ══
		{
			const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws);
			faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("write_document", {
						title: "整改台账",
						outputName: "台账-第一次.docx",
						blocks: ledgerBlocks("负责人", "2026/12/31"),
					}),
				]),
				fauxAssistantMessage("台账已生成。"),
			]);

			const prompt = compilePrompt(card, formValues);
			await orchestrator.submit({
				tenant: TENANT,
				taskId: "round-1",
				sessionId: "s-round-1",
				prompt,
				systemPrompt: card.systemPrompt,
				tools,
				gate: gateFor(card, allPolicies, ws, audit),
				activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
			});
			expect((await orchestrator.run("round-1", prompt)).status).toBe(TaskStatus.Succeeded);
		}

		const firstOutput = await readParagraphs(join(ws, "台账-第一次.docx"));
		expect(firstOutput.map((p) => p.text).join()).toContain("负责人");

		// ══ 用户改产出：负责人 → 责任部门，日期格式统一 ══
		const userRevised: ComparableParagraph[] = firstOutput.map((p) => ({
			...p,
			text: p.text.replaceAll("负责人", "责任部门").replaceAll("2026/12/31", "2026-12-31"),
		}));

		const extracted = extractDocumentRevisions(firstOutput, userRevised);
		expect(extracted.abandoned).toBe(false);
		expect(extracted.revisions.length).toBeGreaterThan(0);

		// ══ 沉淀为经验 ══
		const { learned } = await learnFromRevisions(lessonStore, extracted.revisions, {
			tenantId: TENANT.tenantId,
			scenarioId: SCENARIO_ID,
			scope: Scope.Tenant,
			now: clock,
		});
		expect(learned.length).toBeGreaterThan(0);

		const lessons = await lessonStore.list(TENANT.tenantId, SCENARIO_ID);
		const lessonContext = compileLessons(lessons);
		expect(lessonContext).toContain("责任部门");

		// ══ 第二轮：注入经验。模型按**实际收到的 system prompt** 决定产出 ══
		{
			const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws);

			let sawLessons = false;
			faux.setResponses([
				(ctx: { messages: Array<{ role: string; content?: unknown }> }) => {
					// 模型读自己真实收到的系统提示 —— 这是因果关系的关键。
					// 若经验没被注入，它就产出旧写法。
					//
					// 检测标记用 compileLessons 的固定开头，**不能用「责任部门」**：
					// 场景卡的 systemPrompt 里本来就含那个词（「责任部门无法判断的
					// 标注待分工」），会让未注入的情况被误判为已注入。
					// 第一版就踩了这个坑，反向验证用例把它暴露了出来。
					const system = ctx.messages.find((m) => m.role === "system");
					const text =
						typeof system?.content === "string"
							? system.content
							: JSON.stringify(system?.content ?? "");
					sawLessons = text.includes("历史修改记录");

					return fauxAssistantMessage([
						fauxToolCall("write_document", {
							title: "整改台账",
							outputName: "台账-第二次.docx",
							blocks: sawLessons
								? ledgerBlocks("责任部门", "2026-11-30")
								: ledgerBlocks("负责人", "2026/11/30"),
						}),
					]);
				},
				fauxAssistantMessage("台账已生成。"),
			]);

			// 经验拼进 system prompt —— 这是回写链路在执行侧的落地点
			const systemWithLessons = [card.systemPrompt, "", lessonContext].join("\n");
			const prompt = compilePrompt(card, {
				feedback: ["/ws/新一轮反馈函.docx"],
				deadline: "2026-11-30",
			});

			await orchestrator.submit({
				tenant: TENANT,
				taskId: "round-2",
				sessionId: "s-round-2",
				prompt,
				systemPrompt: systemWithLessons,
				tools,
				gate: gateFor(card, allPolicies, ws, audit),
				activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
			});
			expect((await orchestrator.run("round-2", prompt)).status).toBe(TaskStatus.Succeeded);

			// 经验真的到了模型手里
			expect(sawLessons).toBe(true);
		}

		// ══ 客观判定：第二次产出不再含上次被改掉的内容 ══
		const secondOutput = (await readParagraphs(join(ws, "台账-第二次.docx")))
			.map((p) => p.text)
			.join("\n");

		expect(secondOutput).toContain("责任部门");
		expect(secondOutput).not.toContain("负责人");

		// 这是验收标准的自动化判据
		expect(findRepeatedMistakes(secondOutput, lessons)).toEqual([]);
	});

	it("反向验证：不注入经验时模型仍犯旧错，且被检出", async () => {
		// 这条是上一条的对照组。没有它，上一条可能只是「假模型恰好产出了正确内容」——
		// 而不能证明经验起了作用。
		const ws = workspace();
		const lessonStore = new MemoryLessonStore();
		const card = resolveCard(PRESET_CARDS, SCENARIO_ID, TENANT.tenantId) as ScenarioCard;

		// 先备好经验（模拟上一轮已学到）
		await learnFromRevisions(
			lessonStore,
			[
				{
					kind: "wording" as const,
					target: "表头第3列",
					before: "负责人",
					after: "责任部门",
				},
			],
			{ tenantId: TENANT.tenantId, scenarioId: SCENARIO_ID, now: clock },
		);
		const lessons = await lessonStore.list(TENANT.tenantId, SCENARIO_ID);

		const { orchestrator, faux, tools, allPolicies, audit } = await assemble(ws);
		faux.setResponses([
			(ctx: { messages: Array<{ role: string; content?: unknown }> }) => {
				const system = ctx.messages.find((m) => m.role === "system");
				const text =
					typeof system?.content === "string"
						? system.content
						: JSON.stringify(system?.content ?? "");
				// 同上：必须用只由经验注入引入的标记
				const sawLessons = text.includes("历史修改记录");

				return fauxAssistantMessage([
					fauxToolCall("write_document", {
						title: "整改台账",
						outputName: "台账-未注入.docx",
						blocks: sawLessons
							? ledgerBlocks("责任部门", "2026-11-30")
							: ledgerBlocks("负责人", "2026/11/30"),
					}),
				]);
			},
			fauxAssistantMessage("台账已生成。"),
		]);

		// **刻意不注入经验**
		const prompt = compilePrompt(card, { feedback: ["/ws/反馈.docx"] });
		await orchestrator.submit({
			tenant: TENANT,
			taskId: "round-no-inject",
			sessionId: "s-no-inject",
			prompt,
			systemPrompt: card.systemPrompt, // 没有 lessonContext
			tools,
			gate: gateFor(card, allPolicies, ws, audit),
			activeTools: activateableTools(card.tools, tools.map((t) => t.name)),
		});
		await orchestrator.run("round-no-inject", prompt);

		const output = (await readParagraphs(join(ws, "台账-未注入.docx")))
			.map((p) => p.text)
			.join("\n");

		// 没注入 → 模型犯旧错
		expect(output).toContain("负责人");
		// 而且被客观检出 —— 证明判据本身是有效的
		const repeated = findRepeatedMistakes(output, lessons);
		expect(repeated.length).toBeGreaterThan(0);
		expect(repeated[0]?.found).toContain("负责人");
	});

	it("经验不跨租户泄漏：别家的口径不影响我方产出", async () => {
		const ws = workspace();
		const lessonStore = new MemoryLessonStore();

		// 别家学到「一律用甲方乙方」这种与我方无关的口径
		await learnFromRevisions(
			lessonStore,
			[
				{
					kind: "wording" as const,
					target: "表头第3列",
					before: "责任部门",
					after: "承办单位",
				},
			],
			{ tenantId: "other-univ", scenarioId: SCENARIO_ID, now: clock },
		);

		// 我方取经验 → 应为空
		const myLessons = await lessonStore.list(TENANT.tenantId, SCENARIO_ID);
		expect(myLessons).toEqual([]);
		expect(compileLessons(myLessons)).toBe("");

		// 因此我方产出用「责任部门」不该被判为犯错
		expect(findRepeatedMistakes("序号 | 问题 | 责任部门", myLessons)).toEqual([]);
	});

	it("经验不跨场景泄漏：台账的口径不影响 8D 报告", async () => {
		const lessonStore = new MemoryLessonStore();
		await learnFromRevisions(
			lessonStore,
			[
				{
					kind: "wording" as const,
					target: "表头第3列",
					before: "负责人",
					after: "责任部门",
				},
			],
			{ tenantId: TENANT.tenantId, scenarioId: SCENARIO_ID, now: clock },
		);

		// 8D 报告里「负责人」是正常措辞（D1 小组成员的负责人），
		// 不该因为台账的口径而被判为错
		const eightDLessons = await lessonStore.list(TENANT.tenantId, "mfg.8d-report");
		expect(eightDLessons).toEqual([]);
		expect(findRepeatedMistakes("D1 小组负责人：质量部张工", eightDLessons)).toEqual([]);
	});
});
