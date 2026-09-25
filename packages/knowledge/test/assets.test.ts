/**
 * 模板与口径资产测试
 *
 * 两个断言重点：
 *
 *  1. **合规校验要容忍编号风格差异。** 模板写「1 目的」，产出可能是
 *     「一、目的」——编号风格不该算不合规。这是最容易做错的地方：
 *     用精确匹配会让所有产出都被判为缺章节，功能等于废掉。
 *  2. **优先级必须明确。** 模板是用户给的规范，经验是系统的推测。
 *     冲突时以模板为准，且这一点要写进注入文本 ——
 *     否则模型面对矛盾指令时行为不可预测。
 */

import { describe, expect, it } from "vitest";
import {
	checkTemplateCompliance,
	compileDefinitions,
	compileLessons,
	compileTemplate,
	composeAssetContext,
	learnFromRevisions,
	resolveTemplate,
	RevisionKind,
	Scope,
	TemplateKind,
	type FieldDefinition,
	type Template,
} from "@tao/core";
import { MemoryAssetStore } from "../src/memory-asset-store.ts";
import { MemoryLessonStore } from "../src/memory-lesson-store.ts";

const TENANT = "mfg-001";
const clock = () => 1_700_000_000_000;

/** 一份接近真实的程序文件模板。 */
const PROCEDURE_TEMPLATE: Template = {
	id: "tpl-procedure",
	tenantId: TENANT,
	name: "程序文件模板",
	kind: TemplateKind.Document,
	scenarioId: "mfg.system-document",
	sections: [
		{ title: "1 目的", required: true, guidance: "说明本程序解决什么问题" },
		{ title: "2 适用范围", required: true },
		{ title: "3 职责", required: true, guidance: "逐部门列出职责" },
		{ title: "4 工作程序", required: true },
		{ title: "5 相关记录", required: true, guidance: "列出表单编号与保存期限" },
		{ title: "6 相关文件", required: false },
	],
	layout: {
		bodyFont: "仿宋_GB2312",
		bodySizePt: 12,
		notes: ["一级标题黑体三号", "页脚含文件编号与版本"],
	},
	scope: Scope.Tenant,
	enabled: true,
	updatedAt: clock(),
};

/** 台账表格模板。 */
const LEDGER_TEMPLATE: Template = {
	id: "tpl-ledger",
	tenantId: TENANT,
	name: "整改台账模板",
	kind: TemplateKind.Table,
	scenarioId: "univ.rectification-ledger",
	columns: [
		{ name: "序号", required: true },
		{ name: "问题描述", required: true },
		{ name: "责任部门", required: true, guidance: "落到科室，不落到个人" },
		{ name: "完成期限", required: true, guidance: "格式 YYYY-MM-DD" },
		{ name: "当前进度", required: false },
	],
	scope: Scope.Tenant,
	enabled: true,
	updatedAt: clock(),
};

const STUDENT_COUNT: FieldDefinition = {
	id: "def-students",
	tenantId: TENANT,
	name: "在校生数",
	definition: "具有正式学籍且当前处于在读状态的学生人数",
	includes: ["本科生", "研究生", "留学生"],
	excludes: ["休学学生", "已办理退学手续的学生", "进修生"],
	asOf: "每年 9 月 30 日",
	owner: "教务处",
	scope: Scope.Tenant,
	updatedAt: clock(),
};

const PASS_RATE: FieldDefinition = {
	id: "def-pass-rate",
	tenantId: TENANT,
	name: "一次合格率",
	definition: "首次检验即合格的产品数占投入数的比例",
	formula: "首检合格数 / 投入数 × 100%",
	excludes: ["返工后合格的产品"],
	owner: "质量部",
	scope: Scope.Tenant,
	updatedAt: clock(),
};

describe("模板 · 解析与优先级", () => {
	it("场景专用模板优先于通用模板", () => {
		const generic: Template = { ...PROCEDURE_TEMPLATE, id: "tpl-generic", scenarioId: null };
		const resolved = resolveTemplate([generic, PROCEDURE_TEMPLATE], "mfg.system-document");
		expect(resolved?.id).toBe("tpl-procedure");
	});

	it("无场景专用模板时回落到通用模板", () => {
		const generic: Template = { ...PROCEDURE_TEMPLATE, id: "tpl-generic", scenarioId: null };
		expect(resolveTemplate([generic], "mfg.8d-report")?.id).toBe("tpl-generic");
	});

	it("停用的模板不参与解析", () => {
		const disabled: Template = { ...PROCEDURE_TEMPLATE, enabled: false };
		expect(resolveTemplate([disabled], "mfg.system-document")).toBeUndefined();
	});

	it("无可用模板返回 undefined 而非抛错", () => {
		expect(resolveTemplate([], "any")).toBeUndefined();
	});
});

describe("模板 · 存储与租户隔离", () => {
	it("列出模板时同时返回场景专用与通用", async () => {
		const store = new MemoryAssetStore();
		await store.upsertTemplate(PROCEDURE_TEMPLATE);
		await store.upsertTemplate({ ...PROCEDURE_TEMPLATE, id: "tpl-generic", scenarioId: null });

		const list = await store.listTemplates(TENANT, "mfg.system-document");
		expect(list.map((t) => t.id).sort()).toEqual(["tpl-generic", "tpl-procedure"]);
	});

	it("别家租户的模板不可见", async () => {
		const store = new MemoryAssetStore();
		await store.upsertTemplate({ ...PROCEDURE_TEMPLATE, tenantId: "other-mfg" });
		expect(await store.listTemplates(TENANT, "mfg.system-document")).toEqual([]);
	});

	it("跨租户不能删除他人模板", async () => {
		const store = new MemoryAssetStore();
		await store.upsertTemplate(PROCEDURE_TEMPLATE);
		expect(await store.removeTemplate("other-mfg", PROCEDURE_TEMPLATE.id)).toBe(false);
		expect(await store.getTemplate(TENANT, PROCEDURE_TEMPLATE.id)).toBeDefined();
	});

	it("不相关场景的专用模板不会串进来", async () => {
		const store = new MemoryAssetStore();
		await store.upsertTemplate(LEDGER_TEMPLATE); // 台账模板
		const list = await store.listTemplates(TENANT, "mfg.system-document");
		expect(list).toEqual([]);
	});
});

describe("模板 · 编译为注入上下文", () => {
	it("必需章节与可选章节分开说明", () => {
		const text = compileTemplate(PROCEDURE_TEMPLATE);
		expect(text).toContain("必需章节");
		expect(text).toContain("1 目的");
		expect(text).toContain("可选章节");
		expect(text).toContain("6 相关文件");
	});

	it("点明缺少必需章节的后果", () => {
		// 模型需要知道这不是可选建议
		expect(compileTemplate(PROCEDURE_TEMPLATE)).toContain("审核退回");
	});

	it("章节指引被带上", () => {
		const text = compileTemplate(PROCEDURE_TEMPLATE);
		expect(text).toContain("逐部门列出职责");
		expect(text).toContain("列出表单编号与保存期限");
	});

	it("版式要求被带上", () => {
		const text = compileTemplate(PROCEDURE_TEMPLATE);
		expect(text).toContain("仿宋_GB2312");
		expect(text).toContain("一级标题黑体三号");
	});

	it("表格模板输出列定义与顺序要求", () => {
		const text = compileTemplate(LEDGER_TEMPLATE);
		expect(text).toContain("顺序与名称须一致");
		expect(text).toContain("责任部门");
		expect(text).toContain("落到科室，不落到个人");
		expect(text).toContain("格式 YYYY-MM-DD");
		// 可选列标出来
		expect(text).toContain("当前进度（可选）");
	});

	it("模板名出现在注入内容里", () => {
		// 用户要能理解产出为什么长这样
		expect(compileTemplate(PROCEDURE_TEMPLATE)).toContain("程序文件模板");
	});
});

describe("模板 · 合规校验", () => {
	it("章节齐全时通过", () => {
		const result = checkTemplateCompliance(PROCEDURE_TEMPLATE, {
			headings: ["1 目的", "2 适用范围", "3 职责", "4 工作程序", "5 相关记录"],
		});
		expect(result.ok).toBe(true);
		expect(result.issues).toEqual([]);
	});

	it("容忍编号风格差异（最易做错之处）", () => {
		// 模板写「1 目的」，产出写「一、目的」或「1. 目的」——
		// 用精确匹配会让所有产出都被判为缺章节，功能等于废掉
		const result = checkTemplateCompliance(PROCEDURE_TEMPLATE, {
			headings: ["一、目的", "二、适用范围", "三、职责", "四、工作程序", "五、相关记录"],
		});
		expect(result.issues).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it("缺少必需章节报错并指名", () => {
		const result = checkTemplateCompliance(PROCEDURE_TEMPLATE, {
			headings: ["1 目的", "2 适用范围", "3 职责"],
		});
		expect(result.ok).toBe(false);
		const messages = result.issues.map((i) => i.message).join("|");
		expect(messages).toContain("工作程序");
		expect(messages).toContain("相关记录");
	});

	it("缺少可选章节不报错", () => {
		const result = checkTemplateCompliance(PROCEDURE_TEMPLATE, {
			headings: ["1 目的", "2 适用范围", "3 职责", "4 工作程序", "5 相关记录"],
		});
		// 「6 相关文件」是可选的
		expect(result.ok).toBe(true);
	});

	it("缺少必需列报错", () => {
		const result = checkTemplateCompliance(LEDGER_TEMPLATE, {
			columns: ["序号", "问题描述", "完成期限"],
		});
		expect(result.ok).toBe(false);
		expect(result.issues.map((i) => i.message).join("|")).toContain("责任部门");
	});

	it("多出来的列是警告而非错误", () => {
		// 本次任务可能确实需要额外信息，不该判为不合规
		const result = checkTemplateCompliance(LEDGER_TEMPLATE, {
			columns: ["序号", "问题描述", "责任部门", "完成期限", "备注"],
		});
		expect(result.ok).toBe(true);
		expect(result.issues.some((i) => i.severity === "warning" && i.message.includes("备注"))).toBe(
			true,
		);
	});

	it("空产出被判为缺全部必需章节", () => {
		const result = checkTemplateCompliance(PROCEDURE_TEMPLATE, { headings: [] });
		expect(result.ok).toBe(false);
		expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(5);
	});
});

describe("口径 · 编译为注入上下文", () => {
	it("排除项被单独强调（争议都在边界上）", () => {
		const text = compileDefinitions([STUDENT_COUNT]);
		expect(text).toContain("不包含");
		expect(text).toContain("休学学生");
	});

	it("含计算公式与统计时点", () => {
		const text = compileDefinitions([STUDENT_COUNT, PASS_RATE]);
		expect(text).toContain("首检合格数 / 投入数");
		expect(text).toContain("每年 9 月 30 日");
	});

	it("标出口径负责部门（出现分歧时找谁）", () => {
		expect(compileDefinitions([STUDENT_COUNT])).toContain("教务处");
	});

	it("只注入本次任务涉及的字段", () => {
		// 全部注入会让上下文塞满几十条无关口径，相关的反被淹没
		const text = compileDefinitions([STUDENT_COUNT, PASS_RATE], "请统计各学院在校生数");
		expect(text).toContain("在校生数");
		expect(text).not.toContain("一次合格率");
	});

	it("无相关字段时返回空串", () => {
		expect(compileDefinitions([STUDENT_COUNT], "生成一份会议纪要")).toBe("");
		expect(compileDefinitions([])).toBe("");
	});

	it("口径按租户隔离", async () => {
		const store = new MemoryAssetStore();
		await store.upsertDefinition({ ...STUDENT_COUNT, tenantId: "other-univ" });
		expect(await store.listDefinitions(TENANT)).toEqual([]);
	});
});

describe("资产合成 · 优先级", () => {
	it("模板、口径、经验按顺序拼接", async () => {
		const lessonStore = new MemoryLessonStore();
		await learnFromRevisions(
			lessonStore,
			[
				{
					kind: RevisionKind.Wording,
					target: "表头第3列",
					before: "负责人",
					after: "责任部门",
				},
			],
			{ tenantId: TENANT, scenarioId: "univ.rectification-ledger", now: clock },
		);
		const lessons = compileLessons(
			await lessonStore.list(TENANT, "univ.rectification-ledger"),
		);

		const text = composeAssetContext({
			template: compileTemplate(LEDGER_TEMPLATE),
			definitions: compileDefinitions([STUDENT_COUNT], "在校生数统计"),
			lessons,
		});

		// 顺序即优先级
		expect(text.indexOf("整改台账模板")).toBeLessThan(text.indexOf("在校生数"));
		expect(text.indexOf("在校生数")).toBeLessThan(text.indexOf("历史修改记录"));
	});

	it("显式声明冲突时的优先级", () => {
		// 模型面对矛盾指令时行为不可预测，所以必须写明谁优先
		const text = composeAssetContext({
			template: compileTemplate(LEDGER_TEMPLATE),
			lessons: "以下是本单位在同类任务中的历史修改记录：\n· 某条经验",
		});
		expect(text).toContain("模板与口径定义 > 历史修改记录");
	});

	it("只有模板时不赘述优先级", () => {
		// 没有冲突可能时多说一句只是噪声
		const text = composeAssetContext({ template: compileTemplate(LEDGER_TEMPLATE) });
		expect(text).not.toContain("优先级为");
	});

	it("只有经验时不赘述优先级", () => {
		const text = composeAssetContext({ lessons: "历史修改记录：\n· 某条" });
		expect(text).not.toContain("优先级为");
	});

	it("全空时返回空串", () => {
		expect(composeAssetContext({})).toBe("");
		expect(composeAssetContext({ template: "", definitions: "  ", lessons: "" })).toBe("");
	});

	it("部分为空时不留空悬分隔", () => {
		const text = composeAssetContext({
			template: compileTemplate(LEDGER_TEMPLATE),
			definitions: "",
			lessons: "",
		});
		expect(text).not.toMatch(/\n\n\n/);
		expect(text.trim()).toBe(text);
	});
});
