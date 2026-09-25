/**
 * 预置场景卡测试 —— M2 验收门禁
 *
 * 验收标准（需求 §6）：**任一场景卡可在不输入自由文本 prompt 的前提下完成任务提交。**
 *
 * 这里对「不输入自由文本 prompt」的理解要说清楚，否则测试会变成自欺：
 *
 *  - 用户**仍然要填业务内容**（客户投诉了什么、要通知什么事）。这是数据录入，
 *    是他们每天在干的事，不是 prompt 工程。Agent 不可能猜出客户的投诉内容。
 *  - 用户**不需要写任何指令**：产出该有哪些栏目、按什么标准组织、数据缺失时怎么办，
 *    全部由场景卡的 systemPrompt 与 promptTemplate 提供。
 *
 * 所以本文件的核心断言是：**只填字段就能编译出一条完整、含产出要求的指令**。
 *
 * 另有一组结构性断言，防的是数据类缺陷 —— 比如定义了字段但模板没引用，
 * 用户认真填完却被静默丢弃。这类 bug 不会报错，只会让产出莫名其妙缺内容。
 */

import { describe, expect, it } from "vitest";
import { cardsByIndustry, PRESET_CARDS } from "../src/preset-cards.ts";
import {
	compilePrompt,
	FieldType,
	validateSubmission,
	type ScenarioCard,
	type ScenarioField,
} from "../src/scenario.ts";
import { Scope } from "../src/tenant.ts";
import {
	availableToolNames,
	findTool,
	isFullyImplemented,
	unknownTools,
} from "../src/tool-catalog.ts";

/**
 * 按字段定义自动生成一个合法取值。
 *
 * 刻意做成「从卡片元数据推导」而非手写 10 组样例：前端渲染表单靠的就是这些元数据，
 * 如果这里推不出合法值，前端也渲染不出可用的表单。
 */
function sampleValue(field: ScenarioField): unknown {
	switch (field.type) {
		case FieldType.Text:
		case FieldType.TextArea:
			return `示例内容·${field.label}`;
		case FieldType.Number:
			return field.min ?? 1;
		case FieldType.Select:
			return field.options?.[0]?.value;
		case FieldType.MultiSelect:
			return [field.options?.[0]?.value];
		case FieldType.File:
			return `/ws/示例${field.accept?.[0] ?? ".xlsx"}`;
		case FieldType.FileList:
			return [`/ws/示例1${field.accept?.[0] ?? ".xlsx"}`, `/ws/示例2${field.accept?.[0] ?? ".xlsx"}`];
		case FieldType.Date:
			return "2026-10-01";
		case FieldType.Boolean:
			return true;
	}
}

/** 只填必需字段 —— 模拟最省事的用户。 */
function fillRequired(card: ScenarioCard): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const field of card.fields) {
		if (field.required) values[field.name] = sampleValue(field);
	}
	return values;
}

/** 填满所有字段。 */
function fillAll(card: ScenarioCard): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const field of card.fields) values[field.name] = sampleValue(field);
	return values;
}

describe("预置场景卡 · 覆盖两个行业各 5 个（M2 验收）", () => {
	it("制造业 5 个", () => {
		expect(cardsByIndustry("manufacturing")).toHaveLength(5);
	});

	it("高校 5 个", () => {
		expect(cardsByIndustry("university")).toHaveLength(5);
	});

	it("场景 id 不重复", () => {
		const ids = PRESET_CARDS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("全部为平台级、默认启用、不归属租户", () => {
		for (const card of PRESET_CARDS) {
			expect(card.scope, card.id).toBe(Scope.Platform);
			expect(card.tenantId, card.id).toBeNull();
			expect(card.enabled, card.id).toBe(true);
		}
	});
});

describe("预置场景卡 · 不写 prompt 即可提交（核心验收项）", () => {
	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：只填必需字段即通过校验",
		(_id, card) => {
			const outcome = validateSubmission(card, fillRequired(card));
			expect(outcome.errors).toEqual([]);
			expect(outcome.valid).toBe(true);
		},
	);

	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：只填必需字段即编译出完整指令",
		(_id, card) => {
			const prompt = compilePrompt(card, fillRequired(card));

			// 没有残留占位符 —— 有残留说明模板引用了不存在的字段，
			// 指令里会出现字面量 {{xxx}}，模型会把它当成待填内容
			expect(prompt).not.toMatch(/\{\{/);
			// 产出要求由场景卡提供，不靠用户描述
			expect(prompt).toContain("要求：");
			expect(prompt.length).toBeGreaterThan(50);
		},
	);

	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：填满全部字段同样编译正常",
		(_id, card) => {
			expect(validateSubmission(card, fillAll(card)).valid).toBe(true);
			expect(compilePrompt(card, fillAll(card))).not.toMatch(/\{\{/);
		},
	);

	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：漏填必需字段时被拦住",
		(_id, card) => {
			const required = card.fields.filter((f) => f.required);
			// 每张卡都必须有至少一个必需字段，否则空提交也能过，Agent 只能瞎猜
			expect(required.length).toBeGreaterThan(0);

			const values = fillRequired(card);
			const first = required[0] as ScenarioField;
			delete values[first.name];

			const outcome = validateSubmission(card, values);
			expect(outcome.valid).toBe(false);
			expect(outcome.errors.map((e) => e.field)).toContain(first.name);
		},
	);
});

describe("预置场景卡 · 结构完整性（防静默丢弃用户输入）", () => {
	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：每个字段都被模板引用",
		(_id, card) => {
			const referenced = new Set(
				[...card.promptTemplate.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string),
			);
			const orphans = card.fields.filter((f) => !referenced.has(f.name)).map((f) => f.name);
			// 定义了却没被引用的字段 = 用户认真填完、系统静默丢弃
			expect(orphans).toEqual([]);
		},
	);

	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：模板引用的字段都有定义",
		(_id, card) => {
			const names = new Set(card.fields.map((f) => f.name));
			const referenced = [...card.promptTemplate.matchAll(/\{\{(\w+)\}\}/g)].map(
				(m) => m[1] as string,
			);
			expect(referenced.filter((r) => !names.has(r))).toEqual([]);
		},
	);

	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：字段名不重复",
		(_id, card) => {
			const names = card.fields.map((f) => f.name);
			expect(new Set(names).size).toBe(names.length);
		},
	);

	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：选项类字段必须有选项",
		(_id, card) => {
			for (const field of card.fields) {
				if (field.type === FieldType.Select || field.type === FieldType.MultiSelect) {
					expect(field.options?.length ?? 0, `${card.id}.${field.name}`).toBeGreaterThan(0);
				}
			}
		},
	);

	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：默认值必须合法",
		(_id, card) => {
			// 默认值非法时，用户什么都不改直接提交就会被校验拦住 —— 极易漏测
			const values: Record<string, unknown> = {};
			for (const field of card.fields) {
				if (field.defaultValue !== undefined) values[field.name] = field.defaultValue;
				else if (field.required) values[field.name] = sampleValue(field);
			}
			expect(validateSubmission(card, values).errors).toEqual([]);
		},
	);

	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：文件字段必须限制格式",
		(_id, card) => {
			for (const field of card.fields) {
				if (field.type === FieldType.File || field.type === FieldType.FileList) {
					// 不限制格式的话，用户上传 .zip 会一路走到工具层才失败
					expect(field.accept?.length ?? 0, `${card.id}.${field.name}`).toBeGreaterThan(0);
				}
			}
		},
	);
});

describe("预置场景卡 · 工具白名单与安全", () => {
	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))("%s：声明了工具白名单", (_id, card) => {
		expect(card.tools.length).toBeGreaterThan(0);
	});

	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：声明的工具都在目录里登记",
		(_id, card) => {
			// 工具名是字符串，打错一个字母不会报错，只会让白名单静默失效
			expect(unknownTools([...card.tools])).toEqual([]);
		},
	);

	it("没有任何场景声明 bash 或等价的自由命令执行", () => {
		// 安全决策 4：不提供自由 shell。场景卡是最容易偷偷开口子的地方
		const forbidden = ["bash", "shell", "exec", "run_command", "python"];
		for (const card of PRESET_CARDS) {
			for (const tool of card.tools) {
				expect(forbidden, `${card.id} 声明了 ${tool}`).not.toContain(tool);
			}
		}
	});

	it("表格核对类场景激活了核对工具链", () => {
		for (const id of ["mfg.supplier-reconcile", "univ.data-cross-check"]) {
			const card = PRESET_CARDS.find((c) => c.id === id);
			expect(card?.tools, id).toContain("reconcile_tables");
			expect(card?.tools, id).toContain("read_table");
		}
	});

	it("十张场景卡全部可跑到产出（M3-2 后达成）", () => {
		// 这条断言刻意会随进度失败，已生效两次：
		//   M3-1 交付文档工具 → 从 2 张变 6 张
		//   M3-2 交付知识库工具 → 从 6 张变 10 张
		// 每次失败都逼我们把新事实写准，而不是让文档停留在旧状态。
		const runnable = PRESET_CARDS.filter((c) => isFullyImplemented([...c.tools]));
		expect(runnable).toHaveLength(PRESET_CARDS.length);

		// 反向确认：目录里没有遗留的待实现工具被场景卡引用
		const available = availableToolNames();
		for (const card of PRESET_CARDS) {
			expect(card.tools.filter((t) => !available.has(t)), card.id).toEqual([]);
		}
	});
});

describe("预置场景卡 · 面向用户的文案质量", () => {
	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：标题与说明用业务语言",
		(_id, card) => {
			expect(card.title.length).toBeGreaterThan(0);
			expect(card.summary.length).toBeGreaterThan(10);
			expect(card.category.length).toBeGreaterThan(0);
			// 标题不该出现技术词
			expect(card.title).not.toMatch(/[a-z]+_[a-z]+/);
		},
	);

	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：systemPrompt 含防幻觉约束",
		(_id, card) => {
			// 目标客户拿产出去过审核，编造数据的代价是不符合项甚至丢标。
			// 每张卡都必须显式约束模型「不知道就说不知道」
			expect(card.systemPrompt).toMatch(/不要|不得|绝不|严禁|明确(告知|说明|指出|标注)/);
		},
	);

	it.each(PRESET_CARDS.map((c) => [c.id, c] as const))(
		"%s：可选字段都有填写提示或自解释的标签",
		(_id, card) => {
			for (const field of card.fields) {
				// 可选字段最容易让用户困惑「填不填有什么区别」
				if (!field.required && field.type !== FieldType.Boolean) {
					const selfExplaining = field.label.length >= 4;
					expect(
						field.hint !== undefined || selfExplaining,
						`${card.id}.${field.name} 既无提示、标签也不自解释`,
					).toBe(true);
				}
			}
		},
	);
});

describe("预置场景卡 · 指令编译的实际产物", () => {
	it("对账场景：选项渲染为中文标签而非原始值", () => {
		const card = PRESET_CARDS.find((c) => c.id === "mfg.supplier-reconcile") as ScenarioCard;
		const prompt = compilePrompt(card, {
			ourLedger: "/ws/我方台账.xlsx",
			supplierBill: "/ws/供应商对账单.xlsx",
			keyColumns: ["物料编码", "批次"],
			compareColumns: ["数量", "金额"],
			tolerance: 0.01,
		});

		expect(prompt).toContain("匹配依据：物料编码、批次号");
		expect(prompt).toContain("核对项：数量、金额");
		expect(prompt).toContain("允许误差：0.01");
		expect(prompt).toContain("/ws/我方台账.xlsx");
	});

	it("对账场景：未填允许误差时整行消失", () => {
		const card = PRESET_CARDS.find((c) => c.id === "mfg.supplier-reconcile") as ScenarioCard;
		const prompt = compilePrompt(card, fillRequired(card));
		// 留下「允许误差：」空悬会让模型自行编一个容差
		expect(prompt).not.toContain("允许误差：");
	});

	it("8D 场景：未填根本原因时不留空悬标签", () => {
		const card = PRESET_CARDS.find((c) => c.id === "mfg.8d-report") as ScenarioCard;
		const prompt = compilePrompt(card, {
			problemDescription: "客户反馈刹车盘端面跳动超差",
			productInfo: "刹车盘 BP-2024，批次 20260801",
		});

		expect(prompt).not.toContain("已查明的原因：");
		expect(prompt).not.toContain("客户：");
		expect(prompt).toContain("客户反馈刹车盘端面跳动超差");
		expect(prompt).toContain("D1");
	});

	it("申报书场景：布尔字段渲染为是/否", () => {
		const card = PRESET_CARDS.find((c) => c.id === "univ.project-application") as ScenarioCard;
		const yes = compilePrompt(card, { ...fillRequired(card), checkOnly: true });
		const no = compilePrompt(card, { ...fillRequired(card), checkOnly: false });

		expect(yes).toContain("仅检查完整性：是");
		expect(no).toContain("仅检查完整性：否");
	});

	it("多文件字段渲染为可读的路径列表", () => {
		const card = PRESET_CARDS.find((c) => c.id === "univ.rectification-ledger") as ScenarioCard;
		const prompt = compilePrompt(card, {
			feedback: ["/ws/反馈函.docx", "/ws/专家意见.docx"],
		});
		expect(prompt).toContain("/ws/反馈函.docx、/ws/专家意见.docx");
	});
});
