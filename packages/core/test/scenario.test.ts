/**
 * 场景卡测试
 *
 * 重点验三件事：必需输入未齐备时拦住提交、指令编译结果稳定、
 * 租户自建正确覆盖平台场景。
 */

import { describe, expect, it } from "vitest";
import {
	compilePrompt,
	FieldType,
	listCards,
	resolveCard,
	validateSubmission,
	type ScenarioCard,
} from "../src/scenario.ts";
import { Scope } from "../src/tenant.ts";

const card = (over: Partial<ScenarioCard> = {}): ScenarioCard => ({
	id: "reconcile",
	title: "核对供应商对账单",
	summary: "比对我方台账与供应商对账单，产出差异报告",
	industry: "manufacturing",
	category: "采购管理",
	fields: [
		{
			name: "ourLedger",
			label: "我方台账",
			type: FieldType.File,
			required: true,
			accept: [".xlsx", ".xls"],
		},
		{
			name: "supplierBill",
			label: "供应商对账单",
			type: FieldType.File,
			required: true,
			accept: [".xlsx"],
		},
		{
			name: "keyColumns",
			label: "匹配依据",
			type: FieldType.MultiSelect,
			required: true,
			options: [
				{ value: "code", label: "物料编码" },
				{ value: "batch", label: "批次号" },
			],
		},
		{
			name: "tolerance",
			label: "允许误差",
			type: FieldType.Number,
			required: false,
			min: 0,
			max: 1000,
		},
		{ name: "note", label: "补充说明", type: FieldType.TextArea, required: false },
	],
	tools: ["read_table", "reconcile_tables"],
	systemPrompt: "你是制造业采购助手。",
	promptTemplate: [
		"请核对以下两份文件：",
		"我方台账：{{ourLedger}}",
		"供应商对账单：{{supplierBill}}",
		"匹配依据：{{keyColumns}}",
		"允许误差：{{tolerance}}",
		"补充说明：{{note}}",
	].join("\n"),
	scope: Scope.Platform,
	tenantId: null,
	enabled: true,
	...over,
});

const complete = {
	ourLedger: "/ws/台账.xlsx",
	supplierBill: "/ws/对账单.xlsx",
	keyColumns: ["code"],
};

describe("场景卡 · 必需输入校验", () => {
	it("必需字段齐备时通过", () => {
		expect(validateSubmission(card(), complete).valid).toBe(true);
	});

	it("缺必需字段时拦住提交，并指出缺哪个", () => {
		// 让用户带着缺失数据提交，Agent 只能靠猜，产出必然不可用
		const outcome = validateSubmission(card(), { ourLedger: "/ws/a.xlsx" });
		expect(outcome.valid).toBe(false);
		// 报错要用业务标签，不是字段名
		const messages = outcome.errors.map((e) => e.message).join("|");
		expect(messages).toContain("供应商对账单");
		expect(messages).toContain("匹配依据");
		expect(messages).not.toContain("supplierBill");
	});

	it("空字符串与空数组算未填", () => {
		const outcome = validateSubmission(card(), {
			...complete,
			ourLedger: "   ",
			keyColumns: [],
		});
		expect(outcome.valid).toBe(false);
		expect(outcome.errors).toHaveLength(2);
	});

	it("数字 0 与布尔 false 算已填（不能当成未填）", () => {
		// 常见 bug：用 falsy 判断导致「误差填 0」被当成没填
		const c = card({
			fields: [
				{ name: "tolerance", label: "允许误差", type: FieldType.Number, required: true },
				{ name: "strict", label: "严格模式", type: FieldType.Boolean, required: true },
			],
		});
		expect(validateSubmission(c, { tolerance: 0, strict: false }).valid).toBe(true);
	});

	it("可选字段未填不报错", () => {
		expect(validateSubmission(card(), complete).valid).toBe(true);
	});
});

describe("场景卡 · 字段类型校验", () => {
	it("数字超出范围时报错", () => {
		const low = validateSubmission(card(), { ...complete, tolerance: -1 });
		expect(low.valid).toBe(false);
		expect(low.errors[0]?.message).toContain("不能小于 0");

		const high = validateSubmission(card(), { ...complete, tolerance: 9999 });
		expect(high.valid).toBe(false);
		expect(high.errors[0]?.message).toContain("不能大于 1000");
	});

	it("非数字填入数字字段时报错", () => {
		const outcome = validateSubmission(card(), { ...complete, tolerance: "很多" });
		expect(outcome.valid).toBe(false);
		expect(outcome.errors[0]?.message).toContain("需要填数字");
	});

	it("多选含无效选项时报错并列出无效值", () => {
		const outcome = validateSubmission(card(), { ...complete, keyColumns: ["code", "不存在"] });
		expect(outcome.valid).toBe(false);
		expect(outcome.errors[0]?.message).toContain("不存在");
	});

	it("文件格式不符时报错并说明接受什么", () => {
		const outcome = validateSubmission(card(), { ...complete, ourLedger: "/ws/台账.pdf" });
		expect(outcome.valid).toBe(false);
		expect(outcome.errors[0]?.message).toContain(".xlsx");
	});

	it("文件格式判断忽略大小写", () => {
		expect(validateSubmission(card(), { ...complete, ourLedger: "/ws/台账.XLSX" }).valid).toBe(true);
	});

	it("日期格式错误时报错", () => {
		const c = card({
			fields: [{ name: "deadline", label: "截止日期", type: FieldType.Date, required: true }],
		});
		expect(validateSubmission(c, { deadline: "不是日期" }).valid).toBe(false);
		expect(validateSubmission(c, { deadline: "2026-09-24" }).valid).toBe(true);
	});

	it("单选取值不在选项内时报错", () => {
		const c = card({
			fields: [
				{
					name: "standard",
					label: "体系标准",
					type: FieldType.Select,
					required: true,
					options: [
						{ value: "iso9001", label: "ISO9001" },
						{ value: "iatf16949", label: "IATF16949" },
					],
				},
			],
		});
		expect(validateSubmission(c, { standard: "gb" }).valid).toBe(false);
		expect(validateSubmission(c, { standard: "iso9001" }).valid).toBe(true);
	});
});

describe("场景卡 · 指令编译", () => {
	it("占位符被替换为实际值", () => {
		const prompt = compilePrompt(card(), complete);
		expect(prompt).toContain("/ws/台账.xlsx");
		expect(prompt).toContain("/ws/对账单.xlsx");
	});

	it("选项类字段渲染 label 而非 value", () => {
		// 指令里出现 "code" 对模型无意义，"物料编码" 才有
		const prompt = compilePrompt(card(), complete);
		expect(prompt).toContain("物料编码");
		expect(prompt).not.toContain("keyColumns");
	});

	it("未填的可选字段整行被移除（防止空悬内容引发幻觉）", () => {
		// 若留下「补充说明：」这种空悬行，模型会把它当成需补全的信息
		const prompt = compilePrompt(card(), complete);
		expect(prompt).not.toContain("允许误差");
		expect(prompt).not.toContain("补充说明");
		// 已填的行保留
		expect(prompt).toContain("匹配依据");
	});

	it("已填的可选字段正常出现", () => {
		const prompt = compilePrompt(card(), { ...complete, tolerance: 5, note: "急件" });
		expect(prompt).toContain("允许误差：5");
		expect(prompt).toContain("补充说明：急件");
	});

	it("多选渲染为顿号分隔", () => {
		const prompt = compilePrompt(card(), { ...complete, keyColumns: ["code", "batch"] });
		expect(prompt).toContain("物料编码、批次号");
	});

	it("布尔渲染为是/否", () => {
		const c = card({
			fields: [{ name: "strict", label: "严格模式", type: FieldType.Boolean, required: true }],
			promptTemplate: "严格模式：{{strict}}",
		});
		expect(compilePrompt(c, { strict: true })).toBe("严格模式：是");
		expect(compilePrompt(c, { strict: false })).toBe("严格模式：否");
	});

	it("同一输入编译出完全相同的指令（结果稳定）", () => {
		// 指令结构稳定才能让产出质量收敛，也才能沉淀「上次被改过哪里」
		const a = compilePrompt(card(), complete);
		const b = compilePrompt(card(), complete);
		expect(a).toBe(b);
	});

	it("数字 0 不被当成未填而丢行", () => {
		const prompt = compilePrompt(card(), { ...complete, tolerance: 0 });
		expect(prompt).toContain("允许误差：0");
	});
});

describe("场景卡 · 租户自建覆盖平台场景", () => {
	const platform = card({ title: "平台版核对", tenantId: null, scope: Scope.Platform });
	const tenantOwn = card({
		title: "本校定制核对",
		tenantId: "t1",
		scope: Scope.Tenant,
	});

	it("租户有自建版本时取自建", () => {
		const resolved = resolveCard([platform, tenantOwn], "reconcile", "t1");
		expect(resolved?.title).toBe("本校定制核对");
	});

	it("其他租户仍取平台版本", () => {
		const resolved = resolveCard([platform, tenantOwn], "reconcile", "t2");
		expect(resolved?.title).toBe("平台版核对");
	});

	it("自建版本被停用时回落到平台版本", () => {
		const disabled = { ...tenantOwn, enabled: false };
		const resolved = resolveCard([platform, disabled], "reconcile", "t1");
		expect(resolved?.title).toBe("平台版核对");
	});

	it("平台版本被停用且无自建时返回 undefined", () => {
		const resolved = resolveCard([{ ...platform, enabled: false }], "reconcile", "t1");
		expect(resolved).toBeUndefined();
	});

	it("列表里同 id 只出现一张卡（首页不显示重复）", () => {
		const list = listCards([platform, tenantOwn], "t1");
		expect(list).toHaveLength(1);
		expect(list[0]?.title).toBe("本校定制核对");
	});

	it("列表滤掉停用的卡", () => {
		const other = card({ id: "other", enabled: false });
		const list = listCards([platform, other], "t1");
		expect(list.map((c) => c.id)).toEqual(["reconcile"]);
	});
});
