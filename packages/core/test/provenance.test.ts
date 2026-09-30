/**
 * 产物溯源测试
 *
 * 场景取自真实审核现场：审核员指着报告里某个数字问「这个数从哪来的」。
 * 答不上来就是不符合项，所以溯源必须能定位到「哪份文件的哪一行」，
 * 而不只是「哪份文件」。
 */

import { describe, expect, it } from "vitest";
import {
	describeProvenance,
	findImpacted,
	ProvenanceBuilder,
	SourceKind,
	traceTarget,
	validateProvenance,
} from "../src/provenance.ts";
import type { TenantContext } from "../src/tenant.ts";

const TENANT: TenantContext = { tenantId: "t1", workspaceId: "w1", userId: "u1" };

function builder() {
	return new ProvenanceBuilder({
		artifactId: "a1",
		artifactName: "对账差异报告.xlsx",
		tenant: TENANT,
		taskId: "task-1",
		scenarioId: "reconcile",
		now: () => 1_700_000_000_000,
	});
}

describe("溯源 · 基本记录", () => {
	it("记录产物与任务、场景的关联", () => {
		const p = builder().build();
		expect(p.artifactId).toBe("a1");
		expect(p.taskId).toBe("task-1");
		expect(p.scenarioId).toBe("reconcile");
		expect(p.tenant).toEqual(TENANT);
	});

	it("自由对话产生的产物 scenarioId 为 null", () => {
		const p = new ProvenanceBuilder({
			artifactId: "a2",
			artifactName: "x.xlsx",
			tenant: TENANT,
			taskId: "t",
		}).build();
		expect(p.scenarioId).toBeNull();
	});

	it("登记模型用于问题追责与成本归因", () => {
		const p = builder().setModel("deepseek-chat").build();
		expect(p.model).toBe("deepseek-chat");
	});

	it("重复登记同一来源会去重", () => {
		const ref = { kind: SourceKind.InputFile, id: "/ws/台账.xlsx", name: "台账.xlsx" };
		const p = builder().addInput(ref).addInput(ref).addInput(ref).build();
		expect(p.inputs).toHaveLength(1);
	});

	it("同文件不同定位视为不同来源", () => {
		// 「台账.xlsx 的 B2」与「台账.xlsx 的 B3」是两个不同的数据来源
		const p = builder()
			.addInput({ kind: SourceKind.InputFile, id: "/ws/a.xlsx", name: "a.xlsx", locator: "表1!B2" })
			.addInput({ kind: SourceKind.InputFile, id: "/ws/a.xlsx", name: "a.xlsx", locator: "表1!B3" })
			.build();
		expect(p.inputs).toHaveLength(2);
	});
});

describe("溯源 · 数据项级追溯（审核现场的主场景）", () => {
	const ours = {
		kind: SourceKind.InputFile,
		id: "/ws/台账.xlsx",
		name: "我方台账.xlsx",
		locator: "台账!C5",
	};
	const theirs = {
		kind: SourceKind.InputFile,
		id: "/ws/对账单.xlsx",
		name: "供应商对账单.xlsx",
		locator: "对账单!C5",
	};

	it("能追溯到具体单元格与计算方式", () => {
		const p = builder()
			.addLineage({
				target: "差异明细!E2",
				sources: [ours, theirs],
				derivation: "我方数量 - 对方数量",
			})
			.build();

		const traced = traceTarget(p, "差异明细!E2");
		expect(traced).toBeDefined();
		// 审核员要的答案：来自哪两个单元格、怎么算的
		expect(traced?.sources.map((s) => s.locator)).toEqual(["台账!C5", "对账单!C5"]);
		expect(traced?.derivation).toBe("我方数量 - 对方数量");
	});

	it("追溯不存在的位置返回 undefined 而非抛错", () => {
		const p = builder().build();
		expect(traceTarget(p, "不存在!A1")).toBeUndefined();
	});

	it("数据项的来源自动计入输入清单", () => {
		// 两处各记一份容易对不上，所以 addLineage 自动同步
		const p = builder()
			.addLineage({ target: "E2", sources: [ours, theirs] })
			.build();
		expect(p.inputs).toHaveLength(2);
	});

	it("反向查询：某文件影响了产物里哪些位置", () => {
		// 场景：发现某份输入文件有错，要评估影响范围
		const p = builder()
			.addLineage({ target: "E2", sources: [ours, theirs] })
			.addLineage({ target: "E3", sources: [ours] })
			.addLineage({ target: "E4", sources: [theirs] })
			.build();

		const impacted = findImpacted(p, "/ws/台账.xlsx");
		expect(impacted.map((l) => l.target)).toEqual(["E2", "E3"]);
	});

	it("知识库片段也能作为来源", () => {
		const p = builder()
			.addLineage({
				target: "自评报告!第三章",
				sources: [
					{
						kind: SourceKind.KnowledgeChunk,
						id: "chunk-99",
						name: "本科教学工作合格评估指标体系.docx",
						locator: "位置 1520",
					},
				],
			})
			.build();
		const traced = traceTarget(p, "自评报告!第三章");
		expect(traced?.sources[0]?.kind).toBe(SourceKind.KnowledgeChunk);
	});
});

describe("溯源 · 完整性校验（交付前门禁）", () => {
	it("没有任何输入来源时判为不完整", () => {
		const result = validateProvenance(builder().build());
		expect(result.complete).toBe(false);
		expect(result.missing.join("|")).toContain("输入来源");
	});

	it("数据项无来源时判为不完整", () => {
		const p = builder()
			.addInput({ kind: SourceKind.InputFile, id: "a", name: "a.xlsx" })
			.addLineage({ target: "E2", sources: [] })
			.build();
		const result = validateProvenance(p);
		expect(result.complete).toBe(false);
		expect(result.missing.join("|")).toContain("E2");
	});

	it("溯源链断裂时被检出", () => {
		// 手工构造一个引用了未登记来源的记录（模拟代码 bug 或数据迁移丢失）
		const broken = {
			...builder().addInput({ kind: SourceKind.InputFile, id: "known", name: "known.xlsx" }).build(),
			lineage: [
				{
					target: "E2",
					sources: [{ kind: SourceKind.InputFile, id: "ghost", name: "幽灵文件.xlsx" }],
				},
			],
		};
		const result = validateProvenance(broken);
		expect(result.complete).toBe(false);
		expect(result.missing.join("|")).toContain("幽灵文件");
	});

	it("完整的记录通过校验", () => {
		const source = { kind: SourceKind.InputFile, id: "/ws/a.xlsx", name: "a.xlsx" };
		const p = builder().addLineage({ target: "E2", sources: [source] }).build();
		expect(validateProvenance(p).complete).toBe(true);
	});
});

describe("溯源 · 人类可读说明", () => {
	it("包含产物、任务、场景、输入与数据项", () => {
		const p = builder()
			.setModel("qwen-plus")
			.addLineage({
				target: "差异明细!E2",
				sources: [
					{
						kind: SourceKind.InputFile,
						id: "/ws/a.xlsx",
						name: "我方台账.xlsx",
						locator: "台账!C5",
					},
				],
				derivation: "我方数量 - 对方数量",
			})
			.build();

		const text = describeProvenance(p);
		expect(text).toContain("对账差异报告.xlsx");
		expect(text).toContain("task-1");
		expect(text).toContain("reconcile");
		expect(text).toContain("qwen-plus");
		expect(text).toContain("我方台账.xlsx");
		expect(text).toContain("台账!C5");
		expect(text).toContain("我方数量 - 对方数量");
	});

	it("自由对话产物标明来源", () => {
		const p = new ProvenanceBuilder({
			artifactId: "a",
			artifactName: "x.xlsx",
			tenant: TENANT,
			taskId: "t",
		}).build();
		expect(describeProvenance(p)).toContain("自由对话");
	});

	it("无输入无数据项时不产生空悬标题", () => {
		const text = describeProvenance(builder().build());
		expect(text).not.toContain("输入来源：");
		expect(text).not.toContain("数据项溯源：");
	});
});
