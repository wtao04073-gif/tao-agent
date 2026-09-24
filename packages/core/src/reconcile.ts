/**
 * 表格核对 —— 纯逻辑，不碰文件
 *
 * 独立成模块的原因：对账的正确性是产品价值的核心（客户拿它去跟供应商对账、
 * 去过验厂审核），必须能被穷举测试。混在文件 IO 里就只能靠端到端测试，
 * 边界情况覆盖不到。
 *
 * 真实业务里的坑都在这里处理：数字的字符串形态、全角空格、尾随空白、
 * 浮点误差、一方有多行同键。
 */

/** 一行数据：列名 → 单元格值。 */
export type Row = Readonly<Record<string, unknown>>;

export interface ReconcileOptions {
	/** 用于匹配两表行的键列（可多列组合，如「物料编码 + 批次」）。 */
	readonly keyColumns: readonly string[];
	/** 需要比较数值的列。 */
	readonly compareColumns: readonly string[];
	/**
	 * 数值比较的容差。
	 *
	 * 默认 0.01（一分钱）。**必须有容差** —— 浮点运算会让
	 * 100.1 - 100.1 得出 1.4e-14，没有容差就会报出一堆假差异，
	 * 用户第一次用就会失去信任。
	 */
	readonly tolerance?: number;
}

export const DEFAULT_TOLERANCE = 0.01;

/** 一处差异。 */
export interface Difference {
	readonly key: string;
	readonly column: string;
	readonly left: number | null;
	readonly right: number | null;
	readonly delta: number | null;
	readonly kind: "value_mismatch" | "missing_left" | "missing_right";
}

export interface ReconcileResult {
	readonly differences: readonly Difference[];
	/** 仅左表有的键。 */
	readonly onlyLeft: readonly string[];
	/** 仅右表有的键。 */
	readonly onlyRight: readonly string[];
	/** 两表都有且全部比较列一致的键数量。 */
	readonly matched: number;
	/** 同一键在单表内出现多次 —— 需要提示用户，通常是数据质量问题。 */
	readonly duplicateKeys: readonly string[];
	readonly summary: {
		readonly leftRows: number;
		readonly rightRows: number;
		readonly differenceCount: number;
	};
}

/**
 * 规范化键值。
 *
 * 真实表格里「M-001」「m-001 」「Ｍ-001」可能指同一个物料 ——
 * 不做规范化会把它们当成不同键，产出满屏假差异。
 */
export function normalizeKey(value: unknown): string {
	if (value === null || value === undefined) return "";
	return (
		String(value)
			// 全角转半角（中文环境下从系统导出的数据常含全角字符）
			.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
			.replace(/　/g, " ")
			.trim()
			.toUpperCase()
	);
}

/**
 * 解析数值。
 *
 * 表格里的数字常以字符串形态出现，还可能带千分位、货币符号、
 * 百分号，或用括号表示负数（会计格式）。解析不了返回 null，
 * 由调用方决定如何呈现 —— 不能悄悄当成 0，那会把「缺失」
 * 误报成「差异为负」。
 */
export function parseNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean") return null;

	let text = String(value).trim();
	if (text === "") return null;

	// 会计格式的负数：(1,234.00) 表示 -1234.00
	let negative = false;
	if (/^\((.*)\)$/.test(text)) {
		negative = true;
		text = text.slice(1, -1);
	}

	// 去掉千分位、常见货币符号与空白
	text = text.replace(/[,\s ¥$€£]/g, "");

	let percent = false;
	if (text.endsWith("%")) {
		percent = true;
		text = text.slice(0, -1);
	}

	if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
	let result = Number.parseFloat(text);
	if (!Number.isFinite(result)) return null;
	if (percent) result /= 100;
	if (negative) result = -result;
	return result;
}

/**
 * 判断差额是否超出容差。
 *
 * 不能直接写 `Math.abs(delta) > tolerance` —— 减法本身带浮点误差：
 * `100 - 100.01` 得出 `-0.010000000000005116`，绝对值略大于 0.01，
 * 于是「差额恰为一分钱、容差一分钱」会被判成差异。用户设了容差却仍被
 * 报出边界差异，会直接怀疑工具不准。
 *
 * 关键：**误差量级取决于相减的操作数，而非相减的结果。**
 * 上例中误差是 5.1e-15，按结果量级（0.01）算出的 epsilon 只有 1.8e-15，
 * 远不够；必须按操作数量级（100）算，得 1.8e-13。
 */
function exceedsTolerance(
	delta: number,
	tolerance: number,
	left: number,
	right: number,
): boolean {
	// 按参与运算的操作数取量级，这才是误差的实际来源
	const magnitude = Math.max(Math.abs(left), Math.abs(right), Math.abs(tolerance), 1);
	const epsilon = Number.EPSILON * magnitude * 8;
	return Math.abs(delta) > tolerance + epsilon;
}

/**
 * 键列之间的分隔符。
 *
 * 用 U+0001 而非常见的 "|" 或 "-"：物料编码、批次号里完全可能含这些字符，
 * 那会让「A-1 + 2」与「A + 1-2」产生同一个键，核对结果直接错位。
 * 控制字符不可能出现在真实单元格里。
 */
const KEY_SEP = "\u0001";

/** 按键列组合出行键。 */
function rowKey(row: Row, keyColumns: readonly string[]): string {
	return keyColumns.map((col) => normalizeKey(row[col])).join(KEY_SEP);
}

/** 把行按键分组，同时记录重复键。 */
function indexRows(
	rows: readonly Row[],
	keyColumns: readonly string[],
): { index: Map<string, Row>; duplicates: Set<string> } {
	const index = new Map<string, Row>();
	const duplicates = new Set<string>();
	for (const row of rows) {
		const key = rowKey(row, keyColumns);
		if (key === "" || key.split(KEY_SEP).every((p) => p === "")) continue; // 跳过空行
		if (index.has(key)) {
			duplicates.add(key);
			continue; // 保留首次出现的行，重复项单独提示
		}
		index.set(key, row);
	}
	return { index, duplicates };
}

/** 供展示用的键（把内部分隔符还原成可读形式）。 */
export function displayKey(key: string): string {
	return key.split(KEY_SEP).join(" / ");
}

/**
 * 核对两张表。
 *
 * 左表通常是「我方账」，右表是「对方账」。差异方向为 left - right。
 */
export function reconcile(
	left: readonly Row[],
	right: readonly Row[],
	options: ReconcileOptions,
): ReconcileResult {
	if (options.keyColumns.length === 0) {
		throw new Error("必须指定至少一个键列，否则无法匹配两表的行");
	}

	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
	const leftIndexed = indexRows(left, options.keyColumns);
	const rightIndexed = indexRows(right, options.keyColumns);

	const differences: Difference[] = [];
	const onlyLeft: string[] = [];
	const onlyRight: string[] = [];
	let matched = 0;

	for (const [key, leftRow] of leftIndexed.index) {
		const rightRow = rightIndexed.index.get(key);
		if (rightRow === undefined) {
			onlyLeft.push(key);
			for (const column of options.compareColumns) {
				const leftValue = parseNumber(leftRow[column]);
				differences.push({
					key,
					column,
					left: leftValue,
					right: null,
					delta: null,
					kind: "missing_right",
				});
			}
			continue;
		}

		let rowHasDifference = false;
		for (const column of options.compareColumns) {
			const leftValue = parseNumber(leftRow[column]);
			const rightValue = parseNumber(rightRow[column]);

			// 两侧都解析不出数值 → 视为一致（例如都是空、都是"—"）
			if (leftValue === null && rightValue === null) continue;

			if (leftValue === null || rightValue === null) {
				rowHasDifference = true;
				differences.push({
					key,
					column,
					left: leftValue,
					right: rightValue,
					delta: null,
					kind: leftValue === null ? "missing_left" : "missing_right",
				});
				continue;
			}

			const delta = leftValue - rightValue;
			if (exceedsTolerance(delta, tolerance, leftValue, rightValue)) {
				rowHasDifference = true;
				differences.push({ key, column, left: leftValue, right: rightValue, delta, kind: "value_mismatch" });
			}
		}
		if (!rowHasDifference) matched += 1;
	}

	for (const key of rightIndexed.index.keys()) {
		if (leftIndexed.index.has(key)) continue;
		onlyRight.push(key);
		const rightRow = rightIndexed.index.get(key) as Row;
		for (const column of options.compareColumns) {
			differences.push({
				key,
				column,
				left: null,
				right: parseNumber(rightRow[column]),
				delta: null,
				kind: "missing_left",
			});
		}
	}

	const duplicateKeys = [...new Set([...leftIndexed.duplicates, ...rightIndexed.duplicates])];

	return {
		differences,
		onlyLeft,
		onlyRight,
		matched,
		duplicateKeys,
		summary: {
			leftRows: left.length,
			rightRows: right.length,
			differenceCount: differences.length,
		},
	};
}
