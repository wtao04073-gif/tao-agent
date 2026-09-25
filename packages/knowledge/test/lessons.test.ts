/**
 * 修改意见回写测试
 *
 * **这组测试就是 M3 的验收门禁。**
 *
 * 验收标准（需求 §6）：同类任务第二次产出不再犯上次被改的错。
 *
 * 断言分三层：
 *  1. 提取：从「原产出」与「用户改后版本」自动识别修改
 *  2. 沉淀：过滤噪声、按重复次数提升权重、按场景隔离
 *  3. 应用：注入后能检出重复犯错 —— 这是验收标准的自动化判据
 *
 * 最容易写成自欺的地方是第 3 层：若只断言「注入的文本里含某关键词」，
 * 那测的是字符串拼接，不是「经验起作用了」。所以这里用
 * `findRepeatedMistakes` 对**两次产出内容**做判定。
 */

import { describe, expect, it } from "vitest";
import {
	compileLessons,
	describeRule,
	findRepeatedMistakes,
	isWorthLearning,
	learnFromRevisions,
	lessonKey,
	MAX_INJECTED_LESSONS,
	RevisionKind,
	Scope,
	type Revision,
} from "@tao/core";
import { MemoryLessonStore } from "../src/memory-lesson-store.ts";
import {
	extractDocumentRevisions,
	extractTableRevisions,
	MIN_ITEMS_FOR_RATIO,
	REWRITE_THRESHOLD,
	type ComparableParagraph,
} from "../src/revision-extract.ts";

const TENANT = "univ-001";
const SCENARIO = "univ.rectification-ledger";
const clock = () => 1_700_000_000_000;

function para(index: number, text: string, isHeading = false): ComparableParagraph {
	return { index, text, isHeading };
}

describe("回写 · 从产物改动中提取修改", () => {
	it("识别措辞替换", () => {
		const before = [para(1, "整改台账"), para(2, "负责人：张三")];
		const after = [para(1, "整改台账"), para(2, "责任部门：教务处")];

		const result = extractDocumentRevisions(before, after);
		expect(result.abandoned).toBe(false);
		expect(result.revisions).toHaveLength(1);
		expect(result.revisions[0]?.kind).toBe(RevisionKind.Wording);
		expect(result.revisions[0]?.before).toContain("负责人");
		expect(result.revisions[0]?.after).toContain("责任部门");
	});

	it("识别删除", () => {
		const before = [para(1, "标题"), para(2, "这段是多余的说明文字"), para(3, "正文")];
		const after = [para(1, "标题"), para(2, "正文")];

		const result = extractDocumentRevisions(before, after);
		const removal = result.revisions.find((r) => r.kind === RevisionKind.Removal);
		expect(removal?.before).toContain("多余的说明文字");
	});

	it("识别补充", () => {
		const before = [para(1, "标题"), para(2, "正文")];
		const after = [para(1, "标题"), para(2, "正文"), para(3, "补充：依据XX文件第3条")];

		const result = extractDocumentRevisions(before, after);
		const addition = result.revisions.find((r) => r.kind === RevisionKind.Addition);
		expect(addition?.after).toContain("依据XX文件");
	});

	it("中间插入一段不会让后续全部判为改过", () => {
		// 通用 diff 若按位置对齐，插入一段会让后面每段都错位 →
		// 沉淀出一堆假经验
		const before = [para(1, "第一段"), para(2, "第二段"), para(3, "第三段")];
		const after = [para(1, "第一段"), para(2, "插入的新段"), para(3, "第二段"), para(4, "第三段")];

		const result = extractDocumentRevisions(before, after);
		// 只该识别出「新增一段」，不该报告第二段、第三段被改
		const wording = result.revisions.filter((r) => r.kind === RevisionKind.Wording);
		expect(wording).toHaveLength(0);
	});

	it("标题层级改动归为结构调整", () => {
		const before = [para(1, "一、总体情况", true), para(2, "正文")];
		const after = [para(1, "第一章 总体情况", true), para(2, "正文")];

		const result = extractDocumentRevisions(before, after);
		expect(result.revisions[0]?.kind).toBe(RevisionKind.Structure);
	});

	it("空白差异不算修改", () => {
		const before = [para(1, "整改台账  "), para(2, " 正文内容")];
		const after = [para(1, "整改台账"), para(2, "正文内容")];
		expect(extractDocumentRevisions(before, after).revisions).toEqual([]);
	});

	it("小文档的高比例改动不判为重写（回归）", () => {
		// 这是一个真实缺陷的回归测试。原实现只看比例，导致 3 段改 2 段
		// （0.67 > 0.6）被判为「重写」而放弃学习 —— 而那正是最典型的
		// 正常修订场景。等于让整条回写链路在最常见的情况下失效。
		const before = [para(1, "整改台账"), para(2, "负责人：张三"), para(3, "期限：2026/12/31")];
		const after = [
			para(1, "整改台账"),
			para(2, "责任部门：教务处"),
			para(3, "期限：2026-12-31"),
		];

		const result = extractDocumentRevisions(before, after);
		expect(result.changeRatio).toBeGreaterThan(REWRITE_THRESHOLD);
		// 比例超阈值，但样本量不足，所以仍然提取
		expect(result.abandoned).toBe(false);
		expect(result.revisions).toHaveLength(2);
	});

	it("样本量足够时比例判据才生效", () => {
		// 对照上一条：同样的高比例，但样本量够了 → 判为重写
		const before = Array.from({ length: MIN_ITEMS_FOR_RATIO }, (_, i) =>
			para(i + 1, `原始第${i + 1}段`),
		);
		const after = Array.from({ length: MIN_ITEMS_FOR_RATIO }, (_, i) =>
			para(i + 1, `重写第${i + 1}段`),
		);

		const result = extractDocumentRevisions(before, after);
		expect(result.abandoned).toBe(true);
	});

	it("改动过大时放弃提取，并如实告知", () => {
		// 用户大幅重写时结构对齐失效，提取出的经验全是噪声。
		// 沉淀噪声比不沉淀更糟 —— 它会污染后续所有同类任务。
		const before = Array.from({ length: 10 }, (_, i) => para(i + 1, `原始第${i + 1}段内容`));
		const after = Array.from({ length: 10 }, (_, i) => para(i + 1, `完全重写的第${i + 1}段`));

		const result = extractDocumentRevisions(before, after);
		expect(result.abandoned).toBe(true);
		expect(result.revisions).toEqual([]);
		expect(result.changeRatio).toBeGreaterThan(REWRITE_THRESHOLD);
	});

	it("小幅修订不会被误判为重写", () => {
		const before = Array.from({ length: 10 }, (_, i) => para(i + 1, `第${i + 1}段内容`));
		const after = [...before.slice(0, 9), para(10, "第10段内容（已修订）")];

		const result = extractDocumentRevisions(before, after);
		expect(result.abandoned).toBe(false);
		expect(result.revisions).toHaveLength(1);
	});
});

describe("回写 · 表格改动", () => {
	it("列名修正被单独识别（最有价值的口径经验）", () => {
		const before = {
			header: ["序号", "问题", "负责人"],
			rows: [["1", "课程大纲未更新", "张三"]],
		};
		const after = {
			header: ["序号", "问题", "责任部门"],
			rows: [["1", "课程大纲未更新", "教务处"]],
		};

		const result = extractTableRevisions(before, after);
		const headerChange = result.revisions.find((r) => r.target.includes("表头"));
		expect(headerChange?.before).toBe("负责人");
		expect(headerChange?.after).toBe("责任部门");
	});

	it("单元格格式改动归为格式规范", () => {
		const before = { header: ["序号", "金额"], rows: [["1", "1000"]] };
		const after = { header: ["序号", "金额"], rows: [["1", "1,000.00"]] };

		const result = extractTableRevisions(before, after);
		const cell = result.revisions.find((r) => r.kind === RevisionKind.Format);
		expect(cell?.after).toBe("1,000.00");
		// 用列名而非列号定位 —— 列顺序变了经验还能用
		expect(cell?.target).toContain("金额");
	});

	it("新增列被识别为结构调整", () => {
		const before = { header: ["序号", "问题"], rows: [["1", "问题一"]] };
		const after = { header: ["序号", "问题", "完成期限"], rows: [["1", "问题一", "2026-12-31"]] };

		const result = extractTableRevisions(before, after);
		const added = result.revisions.find(
			(r) => r.kind === RevisionKind.Structure && r.after === "完成期限",
		);
		expect(added).toBeDefined();
	});

	it("行按主键对齐，行序变化不误判", () => {
		const before = {
			header: ["序号", "问题"],
			rows: [
				["1", "问题一"],
				["2", "问题二"],
			],
		};
		const after = {
			header: ["序号", "问题"],
			rows: [
				["2", "问题二"],
				["1", "问题一"],
			],
		};
		// 只是顺序换了，内容没变
		expect(extractTableRevisions(before, after).revisions).toEqual([]);
	});
});

describe("回写 · 噪声过滤", () => {
	it("无实质变化不学", () => {
		expect(
			isWorthLearning({ kind: RevisionKind.Wording, target: "x", before: "同样", after: "同样" }),
		).toBe(false);
	});

	it("单字改动不学（多半是笔误）", () => {
		// 把每个字符改动都变成经验，会让注入的上下文塞满无意义规则，
		// 真正的口径反被淹没
		expect(
			isWorthLearning({ kind: RevisionKind.Wording, target: "x", before: "的", after: "地" }),
		).toBe(false);
	});

	it("用户给了原因时，再小的改动也学", () => {
		// 用户主动解释说明这对他很重要
		expect(
			isWorthLearning({
				kind: RevisionKind.Wording,
				target: "x",
				before: "的",
				after: "地",
				reason: "公文里这里必须用「地」",
			}),
		).toBe(true);
	});

	it("有实质长度的措辞替换要学", () => {
		expect(
			isWorthLearning({
				kind: RevisionKind.Wording,
				target: "x",
				before: "负责人",
				after: "责任部门",
			}),
		).toBe(true);
	});

	it("过短的删除不学", () => {
		expect(
			isWorthLearning({ kind: RevisionKind.Removal, target: "x", before: "。", after: "" }),
		).toBe(false);
	});
});

describe("回写 · 沉淀与权重", () => {
	const REV: Revision = {
		kind: RevisionKind.Wording,
		target: "表头第3列",
		before: "负责人",
		after: "责任部门",
	};

	it("首次修改沉淀为一条经验", async () => {
		const store = new MemoryLessonStore();
		const result = await learnFromRevisions(store, [REV], {
			tenantId: TENANT,
			scenarioId: SCENARIO,
			now: clock,
		});

		expect(result.learned).toHaveLength(1);
		expect(result.learned[0]?.timesObserved).toBe(1);
		expect(result.learned[0]?.rule).toContain("负责人");
		expect(result.learned[0]?.rule).toContain("责任部门");
	});

	it("同一条被再次印证时提升权重而非新建", async () => {
		// 改一次是偶然，改三次就是口径 —— 这是泛化的唯一驱动力
		const store = new MemoryLessonStore();
		for (let i = 0; i < 3; i++) {
			await learnFromRevisions(store, [REV], {
				tenantId: TENANT,
				scenarioId: SCENARIO,
				now: clock,
			});
		}

		const lessons = await store.list(TENANT, SCENARIO);
		expect(lessons).toHaveLength(1);
		expect(lessons[0]?.timesObserved).toBe(3);
		expect(lessons[0]?.evidence).toHaveLength(3);
	});

	it("用户第二次才解释原因时，原因被补进证据", async () => {
		const store = new MemoryLessonStore();
		await learnFromRevisions(store, [REV], { tenantId: TENANT, scenarioId: SCENARIO, now: clock });
		await learnFromRevisions(store, [{ ...REV, reason: "我们一律用责任部门" }], {
			tenantId: TENANT,
			scenarioId: SCENARIO,
			now: clock,
		});

		const lessons = await store.list(TENANT, SCENARIO);
		const reasons = lessons[0]?.evidence.map((e) => e.reason).filter(Boolean);
		expect(reasons).toContain("我们一律用责任部门");
	});

	it("经验按场景隔离", async () => {
		// 台账的口径不该影响 8D 报告
		const store = new MemoryLessonStore();
		await learnFromRevisions(store, [REV], { tenantId: TENANT, scenarioId: SCENARIO, now: clock });

		expect(await store.list(TENANT, "mfg.8d-report")).toEqual([]);
		expect(await store.list(TENANT, SCENARIO)).toHaveLength(1);
	});

	it("经验按租户隔离", async () => {
		const store = new MemoryLessonStore();
		await learnFromRevisions(store, [REV], { tenantId: TENANT, scenarioId: SCENARIO, now: clock });

		// 别家学到的口径绝不能影响我方产出
		expect(await store.list("other-univ", SCENARIO)).toEqual([]);
	});

	it("不同位置的相同改动是两条经验", async () => {
		const store = new MemoryLessonStore();
		await learnFromRevisions(
			store,
			[REV, { ...REV, target: "表头第5列" }],
			{ tenantId: TENANT, scenarioId: SCENARIO, now: clock },
		);
		expect(await store.list(TENANT, SCENARIO)).toHaveLength(2);
	});

	it("去重键不因字段拼接产生歧义", () => {
		// 「A」+「BC」与「AB」+「C」必须是不同的键
		const a = lessonKey({ kind: RevisionKind.Wording, target: "A", before: "BC", after: "x" });
		const b = lessonKey({ kind: RevisionKind.Wording, target: "AB", before: "C", after: "x" });
		expect(a).not.toBe(b);
	});

	it("噪声被跳过并计数", async () => {
		const store = new MemoryLessonStore();
		const result = await learnFromRevisions(
			store,
			[REV, { kind: RevisionKind.Wording, target: "x", before: "的", after: "地" }],
			{ tenantId: TENANT, scenarioId: SCENARIO, now: clock },
		);

		expect(result.learned).toHaveLength(1);
		expect(result.skipped).toBe(1);
	});

	it("用户可否决被错误沉淀的经验", async () => {
		const store = new MemoryLessonStore();
		const { learned } = await learnFromRevisions(store, [REV], {
			tenantId: TENANT,
			scenarioId: SCENARIO,
			now: clock,
		});
		const id = learned[0]!.id;

		expect(await store.remove(TENANT, id)).toBe(true);
		expect(await store.list(TENANT, SCENARIO)).toEqual([]);
	});

	it("跨租户不能删除他人的经验", async () => {
		const store = new MemoryLessonStore();
		const { learned } = await learnFromRevisions(store, [REV], {
			tenantId: TENANT,
			scenarioId: SCENARIO,
			now: clock,
		});

		expect(await store.remove("other-univ", learned[0]!.id)).toBe(false);
		expect(await store.list(TENANT, SCENARIO)).toHaveLength(1);
	});
});

describe("回写 · 注入上下文", () => {
	it("空经验返回空串，不注入无意义内容", () => {
		expect(compileLessons([])).toBe("");
	});

	it("按重复次数降序，高权重优先", async () => {
		const store = new MemoryLessonStore();
		const weak: Revision = {
			kind: RevisionKind.Wording,
			target: "A",
			before: "只改过一次",
			after: "新内容",
		};
		const strong: Revision = {
			kind: RevisionKind.Wording,
			target: "B",
			before: "改过三次的",
			after: "正确写法",
		};

		await learnFromRevisions(store, [weak], { tenantId: TENANT, scenarioId: SCENARIO, now: clock });
		for (let i = 0; i < 3; i++) {
			await learnFromRevisions(store, [strong], {
				tenantId: TENANT,
				scenarioId: SCENARIO,
				now: clock,
			});
		}

		const text = compileLessons(await store.list(TENANT, SCENARIO));
		expect(text.indexOf("改过三次的")).toBeLessThan(text.indexOf("只改过一次"));
		// 高权重的标出重复次数，让模型知道这条更可靠
		expect(text).toContain("已重复 3 次");
	});

	it("compileLessons 自己负责排序，不依赖 store 的顺序", async () => {
		// 这条是变异测试逼出来的。上一条断言曾假通过：MemoryLessonStore.list
		// 已按权重排好序，所以即使 compileLessons 完全不排序也能通过 ——
		// 双重排序掩盖了缺陷。换一个不排序的 store 实现就会暴露。
		//
		// 直接喂乱序输入，验证 compileLessons 自己会排。
		const store = new MemoryLessonStore();
		// after 必须 ≥2 字，否则会被噪声过滤当成笔误跳过（写第一版时踩了这个坑）
		const weak: Revision = {
			kind: RevisionKind.Wording,
			target: "A",
			before: "低权重条目",
			after: "低权重改后",
		};
		const strong: Revision = {
			kind: RevisionKind.Wording,
			target: "B",
			before: "高权重条目",
			after: "高权重改后",
		};

		await learnFromRevisions(store, [weak], { tenantId: TENANT, scenarioId: SCENARIO, now: clock });
		for (let i = 0; i < 4; i++) {
			await learnFromRevisions(store, [strong], {
				tenantId: TENANT,
				scenarioId: SCENARIO,
				now: clock,
			});
		}

		// 刻意按权重**升序**传入（最坏情况）
		const ascending = [...(await store.list(TENANT, SCENARIO))].sort(
			(a, b) => a.timesObserved - b.timesObserved,
		);
		expect(ascending[0]?.timesObserved).toBeLessThan(ascending.at(-1)!.timesObserved);

		const text = compileLessons(ascending);
		expect(text.indexOf("高权重条目")).toBeLessThan(text.indexOf("低权重条目"));
	});

	it("超出上限时截断，不挤爆上下文", async () => {
		const store = new MemoryLessonStore();
		const many = Array.from({ length: MAX_INJECTED_LESSONS + 8 }, (_, i) => ({
			kind: RevisionKind.Wording,
			target: `位置${i}`,
			before: `旧内容${i}`,
			after: `新内容${i}`,
		}));
		await learnFromRevisions(store, many, { tenantId: TENANT, scenarioId: SCENARIO, now: clock });

		const text = compileLessons(await store.list(TENANT, SCENARIO));
		const bullets = text.split("\n").filter((l) => l.startsWith("· "));
		expect(bullets).toHaveLength(MAX_INJECTED_LESSONS);
	});

	it("措辞是「历史偏好」而非「硬性规则」", async () => {
		// 断言式规则会让模型在不适用的场合硬套，产出反而变差
		const store = new MemoryLessonStore();
		await learnFromRevisions(
			store,
			[{ kind: RevisionKind.Wording, target: "x", before: "负责人", after: "责任部门" }],
			{ tenantId: TENANT, scenarioId: SCENARIO, now: clock },
		);

		const text = compileLessons(await store.list(TENANT, SCENARIO));
		expect(text).toContain("历史偏好而非硬性规则");
		expect(text).toContain("以本次要求为准");
	});

	it("用户给的原因被带进注入内容", () => {
		const rule = describeRule({
			kind: RevisionKind.Wording,
			target: "表头",
			before: "负责人",
			after: "责任部门",
			reason: "我们一律用责任部门，因为要落到科室不落到个人",
		});
		expect(rule).toContain("落到科室不落到个人");
	});
});

describe("回写 · 验收门禁：第二次不再犯上次被改的错", () => {
	/** 用户第一次拿到的产出（含会被改掉的问题）。 */
	const FIRST_OUTPUT = [
		para(1, "整改台账"),
		para(2, "序号 | 问题 | 负责人 | 期限"),
		para(3, "1 | 课程大纲未更新 | 张三 | 2026/12/31"),
	];

	/** 用户改后的版本。 */
	const USER_REVISED = [
		para(1, "整改台账"),
		para(2, "序号 | 问题 | 责任部门 | 期限"),
		para(3, "1 | 课程大纲未更新 | 教务处 | 2026-12-31"),
	];

	it("完整闭环：提取 → 沉淀 → 注入 → 第二次产出被判定为不再犯错", async () => {
		const store = new MemoryLessonStore();

		// ① 用户改了产出，系统自动提取
		const extracted = extractDocumentRevisions(FIRST_OUTPUT, USER_REVISED);
		expect(extracted.abandoned).toBe(false);
		expect(extracted.revisions.length).toBeGreaterThan(0);

		// ② 沉淀为经验
		const { learned } = await learnFromRevisions(store, extracted.revisions, {
			tenantId: TENANT,
			scenarioId: SCENARIO,
			scope: Scope.Tenant,
			now: clock,
		});
		expect(learned.length).toBeGreaterThan(0);

		// ③ 第二次执行同类任务，注入经验
		const lessons = await store.list(TENANT, SCENARIO);
		const injected = compileLessons(lessons);
		expect(injected).toContain("负责人");
		expect(injected).toContain("责任部门");

		// ④ 假设模型照做了 —— 第二次产出用了「责任部门」
		const goodSecondOutput = "整改台账\n序号 | 问题 | 责任部门 | 期限\n1 | 实验室制度待完善 | 后勤处 | 2026-11-30";
		expect(findRepeatedMistakes(goodSecondOutput, lessons)).toEqual([]);

		// ⑤ 反向验证：若模型又用了「负责人」，必须被检出
		// 这一步是整条链路的意义所在 —— 没有它，前四步只是「记录了修改」
		const badSecondOutput = "整改台账\n序号 | 问题 | 负责人 | 期限\n1 | 实验室制度待完善 | 李四 | 2026-11-30";
		const repeated = findRepeatedMistakes(badSecondOutput, lessons);
		expect(repeated.length).toBeGreaterThan(0);
		expect(repeated.some((r) => r.found.includes("负责人"))).toBe(true);
	});

	it("别家租户的经验不会影响我方判定", async () => {
		const store = new MemoryLessonStore();
		const extracted = extractDocumentRevisions(FIRST_OUTPUT, USER_REVISED);
		await learnFromRevisions(store, extracted.revisions, {
			tenantId: "other-univ",
			scenarioId: SCENARIO,
			now: clock,
		});

		// 我方没有任何经验，所以用「负责人」不算犯错
		const myLessons = await store.list(TENANT, SCENARIO);
		expect(myLessons).toEqual([]);
		expect(findRepeatedMistakes("序号 | 问题 | 负责人", myLessons)).toEqual([]);
	});

	it("补充类经验不参与重复犯错判定", async () => {
		// 「上次补充了某内容」无法用「是否出现」判断 ——
		// 本次任务可能根本不需要那段内容
		const store = new MemoryLessonStore();
		await learnFromRevisions(
			store,
			[
				{
					kind: RevisionKind.Addition,
					target: "第3段附近",
					before: "",
					after: "补充：依据XX文件第3条",
				},
			],
			{ tenantId: TENANT, scenarioId: SCENARIO, now: clock },
		);

		const lessons = await store.list(TENANT, SCENARIO);
		expect(findRepeatedMistakes("一份完全不同的产出", lessons)).toEqual([]);
	});

	it("已改正的内容出现时不算犯错", async () => {
		// 若产出里同时含旧写法与新写法（例如引用了历史文件原文），
		// 只要新写法在，就不该判为犯错
		const store = new MemoryLessonStore();
		await learnFromRevisions(
			store,
			[{ kind: RevisionKind.Wording, target: "x", before: "负责人", after: "责任部门" }],
			{ tenantId: TENANT, scenarioId: SCENARIO, now: clock },
		);

		const lessons = await store.list(TENANT, SCENARIO);
		const output = "本表原列名为「负责人」，现统一为「责任部门」。";
		expect(findRepeatedMistakes(output, lessons)).toEqual([]);
	});
});
