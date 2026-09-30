/**
 * 产物修改提取
 *
 * 用户不会填「请总结你的偏好」表单 —— 他们只会**直接改产出**。
 * 所以要从「原产出」与「用户改后的版本」之间自动提取修改。
 *
 * ── 为什么不用通用 diff 算法 ──
 *
 * 通用 diff 给出的是行级增删，而我们需要的是**语义级修改**：
 * 「『负责人』这一列改成了『责任部门』」而不是「第 3 行删除、新增第 3 行」。
 *
 * 所以按产物结构对齐后再比较：
 *  - 文档按段落序号与标题层级对齐
 *  - 表格按表头与行键对齐
 *
 * 结构对齐的另一个好处是能识别**移动**（同一内容换了位置）而不误判成
 * 删除 + 新增 —— 后者会沉淀出两条毫无意义的经验。
 *
 * ── 已知局限（不掩饰）──
 *
 * 用户大幅重写时，结构对齐会失效，退化成「整段被删 + 整段新增」。
 * 这时提取出的经验质量很差，所以改动比例过高时**放弃提取**并如实告知 ——
 * 沉淀一堆噪声比不沉淀更糟。
 *
 * 但这条启发式本身有个陷阱：**比例在小样本上不可靠**。写测试时发现
 * 3 段改 2 段（0.67）会被判为重写，而那正是最典型的正常修订 ——
 * 等于让整条回写链路在最常见的场景下失效。故加了最小样本量门槛
 * （`MIN_ITEMS_FOR_RATIO`）。
 */

import { RevisionKind, type Revision } from "@tao/core";

/** 参与比较的文档段落。 */
export interface ComparableParagraph {
	readonly index: number;
	readonly text: string;
	readonly isHeading: boolean;
}

/** 改动比例超过这个值就放弃提取 —— 用户是重写而非修订。 */
export const REWRITE_THRESHOLD = 0.6;

/**
 * 应用改动比例判据所需的最小样本量。
 *
 * 比例在小样本上是**不可靠信号**：一份 3 段的公文改掉 2 段（0.67）
 * 明显是正常修订，但比例已超阈值。这是写测试时发现的真实缺陷 ——
 * 原本会让最典型的小改动场景全部被判为「重写」而放弃学习，
 * 也就是让整条回写链路在最常见的情况下失效。
 *
 * 所以样本量不足时**一律提取**：小文档即使对齐失效，产出的经验条数也有限，
 * 噪声可控；而放弃学习的代价是用户改了十次还是第十一次犯同样的错。
 */
export const MIN_ITEMS_FOR_RATIO = 6;

export interface ExtractResult {
	readonly revisions: readonly Revision[];
	/**
	 * 是否因改动过大而放弃提取。
	 *
	 * 为真时 `revisions` 为空，调用方应提示用户「本次改动较大，
	 * 如需沉淀口径请手动标注」而不是假装学到了东西。
	 */
	readonly abandoned: boolean;
	/** 改动比例，用于向用户解释为何放弃。 */
	readonly changeRatio: number;
}

/** 规范化，用于判断两段文本是否「实质相同」。 */
function norm(text: string): string {
	return text.trim().replace(/\s+/g, "");
}

/**
 * 对比两版文档段落，提取修改。
 *
 * 对齐策略：先按内容找出未变动的段落作为锚点，锚点之间的区段再按位置配对。
 * 这样中间插入一段不会让后续所有段落都被判为「改过」。
 */
export function extractDocumentRevisions(
	before: readonly ComparableParagraph[],
	after: readonly ComparableParagraph[],
): ExtractResult {
	const beforeTexts = before.map((p) => norm(p.text));
	const afterTexts = after.map((p) => norm(p.text));

	// 找锚点：内容完全相同且在两边都唯一出现的段落
	const countIn = (list: readonly string[], text: string): number =>
		list.filter((t) => t === text).length;

	const anchors: Array<{ b: number; a: number }> = [];
	for (let i = 0; i < beforeTexts.length; i++) {
		const text = beforeTexts[i] as string;
		if (text === "") continue;
		if (countIn(beforeTexts, text) !== 1) continue;
		if (countIn(afterTexts, text) !== 1) continue;
		const j = afterTexts.indexOf(text);
		if (j >= 0) anchors.push({ b: i, a: j });
	}
	// 锚点必须递增，否则是移动而非对齐点
	const ordered: Array<{ b: number; a: number }> = [];
	for (const anchor of anchors) {
		const last = ordered.at(-1);
		if (last === undefined || anchor.a > last.a) ordered.push(anchor);
	}

	const revisions: Revision[] = [];
	let changed = 0;

	/** 比较锚点之间的一个区段。 */
	const compareRange = (b0: number, b1: number, a0: number, a1: number): void => {
		const bs = before.slice(b0, b1);
		const as = after.slice(a0, a1);
		const pairs = Math.min(bs.length, as.length);

		// 位置配对的部分算「改写」
		for (let k = 0; k < pairs; k++) {
			const bp = bs[k] as ComparableParagraph;
			const ap = as[k] as ComparableParagraph;
			if (norm(bp.text) === norm(ap.text)) continue;

			changed += 1;
			revisions.push({
				// 标题层级变化算结构调整，正文变化算措辞
				kind: bp.isHeading || ap.isHeading ? RevisionKind.Structure : RevisionKind.Wording,
				target: `第${bp.index}段`,
				before: bp.text,
				after: ap.text,
			});
		}

		// 多出来的旧段落 = 被删除
		for (let k = pairs; k < bs.length; k++) {
			const bp = bs[k] as ComparableParagraph;
			changed += 1;
			revisions.push({
				kind: RevisionKind.Removal,
				target: `第${bp.index}段`,
				before: bp.text,
				after: "",
			});
		}

		// 多出来的新段落 = 被补充
		for (let k = pairs; k < as.length; k++) {
			const ap = as[k] as ComparableParagraph;
			changed += 1;
			revisions.push({
				kind: RevisionKind.Addition,
				// 新增内容没有原段落序号，用它在新版里的位置
				target: `第${ap.index}段附近`,
				before: "",
				after: ap.text,
			});
		}
	};

	let bPrev = 0;
	let aPrev = 0;
	for (const anchor of ordered) {
		compareRange(bPrev, anchor.b, aPrev, anchor.a);
		bPrev = anchor.b + 1;
		aPrev = anchor.a + 1;
	}
	compareRange(bPrev, before.length, aPrev, after.length);

	const total = Math.max(before.length, after.length, 1);
	const changeRatio = changed / total;

	// 改动过大 → 用户是重写而非修订，提取出的经验全是噪声。
	// 但比例只在样本足够大时可靠，小文档一律提取（见 MIN_ITEMS_FOR_RATIO）
	if (total >= MIN_ITEMS_FOR_RATIO && changeRatio > REWRITE_THRESHOLD) {
		return { revisions: [], abandoned: true, changeRatio };
	}

	return { revisions, abandoned: false, changeRatio };
}

/** 参与比较的表格。 */
export interface ComparableTable {
	readonly header: readonly string[];
	readonly rows: readonly (readonly string[])[];
}

/**
 * 对比两版表格，提取修改。
 *
 * 表头变化单独识别 —— 「负责人」改成「责任部门」这类列名修正
 * 是最典型也最有价值的口径经验，不该混在单元格改动里。
 */
export function extractTableRevisions(
	before: ComparableTable,
	after: ComparableTable,
): ExtractResult {
	const revisions: Revision[] = [];
	let changed = 0;

	// ── 表头 ──
	const headerPairs = Math.min(before.header.length, after.header.length);
	for (let i = 0; i < headerPairs; i++) {
		const b = before.header[i] as string;
		const a = after.header[i] as string;
		if (norm(b) === norm(a)) continue;
		changed += 1;
		revisions.push({
			kind: RevisionKind.Wording,
			target: `表头第${i + 1}列`,
			before: b,
			after: a,
		});
	}
	for (let i = headerPairs; i < before.header.length; i++) {
		changed += 1;
		revisions.push({
			kind: RevisionKind.Structure,
			target: `表头第${i + 1}列`,
			before: before.header[i] as string,
			after: "",
		});
	}
	for (let i = headerPairs; i < after.header.length; i++) {
		changed += 1;
		revisions.push({
			kind: RevisionKind.Structure,
			target: `表头第${i + 1}列`,
			before: "",
			after: after.header[i] as string,
		});
	}

	// ── 数据行按第一列（通常是序号或主键）对齐 ──
	const keyOf = (row: readonly string[]): string => norm(row[0] ?? "");
	const afterByKey = new Map(after.rows.map((r) => [keyOf(r), r]));

	for (const beforeRow of before.rows) {
		const afterRow = afterByKey.get(keyOf(beforeRow));
		if (afterRow === undefined) continue; // 整行删除不沉淀为口径，噪声太大

		const cells = Math.min(beforeRow.length, afterRow.length);
		for (let c = 0; c < cells; c++) {
			const b = beforeRow[c] as string;
			const a = afterRow[c] as string;
			if (norm(b) === norm(a)) continue;
			changed += 1;
			const column = after.header[c] ?? before.header[c] ?? `第${c + 1}列`;
			revisions.push({
				// 单元格内容改动多为格式规范（日期、金额精度）
				kind: RevisionKind.Format,
				target: `${column}列`,
				before: b,
				after: a,
			});
		}
	}

	const cellCount = Math.max(
		before.rows.length * Math.max(before.header.length, 1),
		after.rows.length * Math.max(after.header.length, 1),
		1,
	);
	const changeRatio = changed / cellCount;

	// 同上：小表格不套用比例判据
	if (cellCount >= MIN_ITEMS_FOR_RATIO && changeRatio > REWRITE_THRESHOLD) {
		return { revisions: [], abandoned: true, changeRatio };
	}

	return { revisions, abandoned: false, changeRatio };
}
