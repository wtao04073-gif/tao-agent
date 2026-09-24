/**
 * 产物溯源
 *
 * 验收要求：**产出文件保留与源数据、执行任务的关联关系，可追溯每个数据项的来源。**
 *
 * 为什么这是刚需而非锦上添花：目标客户的付费动机是「通过审核与客户验厂」。
 * 审核员会指着报告里某个数字问「这个数从哪来的」，答不上来就是不符合项。
 * 溯源能力直接决定产物能不能进审核材料。
 *
 * 设计取舍：溯源记录**与产物同生命周期**，不做单独的过期清理。
 * 一份 2026 年的报告在 2029 年被审核时仍要能回答来源问题。
 */

import type { TenantContext } from "./tenant.ts";

/** 溯源来源的类型。 */
export const SourceKind = {
	/** 用户上传的输入文件。 */
	InputFile: "input_file",
	/** 知识库片段。 */
	KnowledgeChunk: "knowledge_chunk",
	/** 机构模板。 */
	Template: "template",
	/** 字段口径定义。 */
	FieldDefinition: "field_definition",
	/** 工具计算产生的中间结果。 */
	Computation: "computation",
} as const;

export type SourceKind = (typeof SourceKind)[keyof typeof SourceKind];

/** 一条来源引用。 */
export interface SourceRef {
	readonly kind: SourceKind;
	/** 来源标识：文件路径、chunk id、模板 id 等。 */
	readonly id: string;
	/** 面向用户的名称，如「供应商对账单.xlsx」。 */
	readonly name: string;
	/**
	 * 在来源中的定位。
	 *
	 * 文件类用「工作表!单元格」或行号，知识库片段用位置偏移。
	 * 没有它就只能追溯到「哪份文件」，答不了「哪一行」。
	 */
	readonly locator?: string;
}

/** 产物中某个数据项的溯源。 */
export interface DataLineage {
	/**
	 * 产物内的定位，如「差异明细!E2」。
	 *
	 * 这是审核员指着问的那个位置。
	 */
	readonly target: string;
	/** 该数据项的来源。可以有多个（如差额来自两个单元格相减）。 */
	readonly sources: readonly SourceRef[];
	/** 计算说明，如「我方数量 - 对方数量」。 */
	readonly derivation?: string;
}

/** 一份产物的完整溯源记录。 */
export interface ArtifactProvenance {
	readonly artifactId: string;
	readonly artifactName: string;
	readonly tenant: TenantContext;
	/** 产生它的任务。 */
	readonly taskId: string;
	/** 使用的场景卡。自由对话产生的产物为 null。 */
	readonly scenarioId: string | null;
	readonly createdAt: number;
	/** 全部输入来源（文件、知识片段、模板）。 */
	readonly inputs: readonly SourceRef[];
	/** 数据项级溯源。 */
	readonly lineage: readonly DataLineage[];
	/** 生成该产物时使用的模型，用于问题追责与成本归因。 */
	readonly model?: string;
}

/** 溯源记录的构建器。边生成产物边记录，比事后重建可靠。 */
export class ProvenanceBuilder {
	private readonly inputs: SourceRef[] = [];
	private readonly lineage: DataLineage[] = [];
	private readonly artifactId: string;
	private readonly artifactName: string;
	private readonly tenant: TenantContext;
	private readonly taskId: string;
	private readonly scenarioId: string | null;
	private readonly now: () => number;
	private model: string | undefined;

	constructor(options: {
		artifactId: string;
		artifactName: string;
		tenant: TenantContext;
		taskId: string;
		scenarioId?: string | null;
		now?: () => number;
	}) {
		this.artifactId = options.artifactId;
		this.artifactName = options.artifactName;
		this.tenant = options.tenant;
		this.taskId = options.taskId;
		this.scenarioId = options.scenarioId ?? null;
		this.now = options.now ?? (() => Date.now());
	}

	/** 登记一个输入来源。重复登记同一来源会被去重。 */
	addInput(ref: SourceRef): this {
		const exists = this.inputs.some((i) => i.kind === ref.kind && i.id === ref.id && i.locator === ref.locator);
		if (!exists) this.inputs.push(ref);
		return this;
	}

	/** 批量登记输入来源。 */
	addInputs(refs: readonly SourceRef[]): this {
		for (const ref of refs) this.addInput(ref);
		return this;
	}

	/** 登记一个数据项的溯源。 */
	addLineage(entry: DataLineage): this {
		this.lineage.push(entry);
		// 数据项的来源自动计入输入清单，避免两处各记一份而对不上
		this.addInputs(entry.sources);
		return this;
	}

	setModel(model: string): this {
		this.model = model;
		return this;
	}

	build(): ArtifactProvenance {
		return {
			artifactId: this.artifactId,
			artifactName: this.artifactName,
			tenant: this.tenant,
			taskId: this.taskId,
			scenarioId: this.scenarioId,
			createdAt: this.now(),
			inputs: [...this.inputs],
			lineage: [...this.lineage],
			...(this.model === undefined ? {} : { model: this.model }),
		};
	}
}

/**
 * 查询某个数据项的来源。
 *
 * 这是审核场景的主入口：审核员指着「差异明细!E2」问来源，
 * 系统要能立刻答出「来自 台账.xlsx 的 B2 与 对账单.xlsx 的 B2 相减」。
 */
export function traceTarget(
	provenance: ArtifactProvenance,
	target: string,
): DataLineage | undefined {
	return provenance.lineage.find((l) => l.target === target);
}

/** 反向查询：某个来源影响了产物里的哪些位置。 */
export function findImpacted(
	provenance: ArtifactProvenance,
	sourceId: string,
): readonly DataLineage[] {
	return provenance.lineage.filter((l) => l.sources.some((s) => s.id === sourceId));
}

/**
 * 把溯源记录渲染成人类可读的说明。
 *
 * 用于「产物详情」页与导出的溯源附录 —— 有些审核要求提供纸质溯源说明。
 */
export function describeProvenance(provenance: ArtifactProvenance): string {
	const lines: string[] = [
		`产物：${provenance.artifactName}`,
		`任务标识：${provenance.taskId}`,
		provenance.scenarioId === null ? "来源：自由对话" : `场景：${provenance.scenarioId}`,
	];

	if (provenance.model !== undefined) lines.push(`使用模型：${provenance.model}`);

	if (provenance.inputs.length > 0) {
		lines.push("", "输入来源：");
		for (const input of provenance.inputs) {
			const locator = input.locator === undefined ? "" : `（${input.locator}）`;
			lines.push(`  · ${input.name}${locator}`);
		}
	}

	if (provenance.lineage.length > 0) {
		lines.push("", "数据项溯源：");
		for (const entry of provenance.lineage) {
			const from = entry.sources
				.map((s) => (s.locator === undefined ? s.name : `${s.name} ${s.locator}`))
				.join(" + ");
			const derivation = entry.derivation === undefined ? "" : `，计算方式：${entry.derivation}`;
			lines.push(`  · ${entry.target} ← ${from}${derivation}`);
		}
	}

	return lines.join("\n");
}

/**
 * 校验溯源记录的完整性。
 *
 * 用在产物交付前：溯源不完整的产物进了审核材料，等于把风险留到现场。
 */
export function validateProvenance(provenance: ArtifactProvenance): {
	readonly complete: boolean;
	readonly missing: readonly string[];
} {
	const missing: string[] = [];

	if (provenance.inputs.length === 0) {
		missing.push("没有登记任何输入来源");
	}

	// 数据项引用的来源必须在输入清单里 —— 否则溯源链断裂
	for (const entry of provenance.lineage) {
		if (entry.sources.length === 0) {
			missing.push(`数据项 ${entry.target} 没有来源`);
			continue;
		}
		for (const source of entry.sources) {
			const known = provenance.inputs.some((i) => i.id === source.id && i.kind === source.kind);
			if (!known) missing.push(`数据项 ${entry.target} 的来源 ${source.name} 未登记在输入清单`);
		}
	}

	return { complete: missing.length === 0, missing };
}
