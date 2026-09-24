/**
 * 对账逻辑测试
 *
 * 这是产品价值的核心 —— 客户拿它去跟供应商对账、去过验厂审核。
 * 报错一次假差异，用户就会失去信任；漏报一次真差异，可能造成实际损失。
 * 所以按真实业务数据的脏形态穷举。
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_TOLERANCE,
	displayKey,
	normalizeKey,
	parseNumber,
	reconcile,
	type Row,
} from "../src/reconcile.ts";

const opts = { keyColumns: ["物料编码"], compareColumns: ["数量"] };

describe("parseNumber · 真实表格里的数字形态", () => {
	it("原生数字", () => {
		expect(parseNumber(100)).toBe(100);
		expect(parseNumber(-3.5)).toBe(-3.5);
		expect(parseNumber(0)).toBe(0);
	});

	it("字符串数字（从系统导出时常见）", () => {
		expect(parseNumber("100")).toBe(100);
		expect(parseNumber(" 100.5 ")).toBe(100.5);
		expect(parseNumber("-42")).toBe(-42);
		expect(parseNumber(".5")).toBe(0.5);
	});

	it("千分位与货币符号", () => {
		expect(parseNumber("1,234.56")).toBe(1234.56);
		expect(parseNumber("¥1,234")).toBe(1234);
		expect(parseNumber("$99.99")).toBe(99.99);
	});

	it("会计格式的负数：括号表示负", () => {
		// 财务导出的数据大量使用这种格式，当成正数会让差异符号完全反掉
		expect(parseNumber("(1,234.00)")).toBe(-1234);
		expect(parseNumber("(50)")).toBe(-50);
	});

	it("百分比", () => {
		expect(parseNumber("15%")).toBeCloseTo(0.15);
		expect(parseNumber("100%")).toBe(1);
	});

	it("非数值返回 null 而非 0", () => {
		// 关键：不能悄悄当成 0，否则「缺失」会被误报成「差异」
		expect(parseNumber("")).toBeNull();
		expect(parseNumber("  ")).toBeNull();
		expect(parseNumber("—")).toBeNull();
		expect(parseNumber("N/A")).toBeNull();
		expect(parseNumber("待确认")).toBeNull();
		expect(parseNumber(null)).toBeNull();
		expect(parseNumber(undefined)).toBeNull();
		expect(parseNumber(true)).toBeNull();
		expect(parseNumber(Number.NaN)).toBeNull();
		expect(parseNumber(Number.POSITIVE_INFINITY)).toBeNull();
	});

	it("不把含数字的文本误判为数值", () => {
		expect(parseNumber("100 件")).toBeNull();
		expect(parseNumber("约 100")).toBeNull();
		expect(parseNumber("1-2")).toBeNull();
	});
});

describe("normalizeKey · 键的脏形态", () => {
	it("大小写与空白归一", () => {
		expect(normalizeKey("m-001")).toBe("M-001");
		expect(normalizeKey(" M-001 ")).toBe("M-001");
	});

	it("全角字符归一（中文系统导出常见）", () => {
		expect(normalizeKey("Ｍ－００１")).toBe("M-001");
		expect(normalizeKey("M　001")).toBe("M 001");
	});

	it("数字键与字符串键等价", () => {
		expect(normalizeKey(1001)).toBe(normalizeKey("1001"));
	});

	it("空值归一为空字符串", () => {
		expect(normalizeKey(null)).toBe("");
		expect(normalizeKey(undefined)).toBe("");
	});
});

describe("reconcile · 基本核对", () => {
	it("完全一致时无差异", () => {
		const rows: Row[] = [
			{ 物料编码: "M-001", 数量: 100 },
			{ 物料编码: "M-002", 数量: 50 },
		];
		const result = reconcile(rows, rows, opts);
		expect(result.differences).toEqual([]);
		expect(result.matched).toBe(2);
		expect(result.onlyLeft).toEqual([]);
		expect(result.onlyRight).toEqual([]);
	});

	it("数值不一致时报出差异与方向", () => {
		const result = reconcile(
			[{ 物料编码: "M-001", 数量: 100 }],
			[{ 物料编码: "M-001", 数量: 98 }],
			opts,
		);
		expect(result.differences).toHaveLength(1);
		expect(result.differences[0]).toMatchObject({
			column: "数量",
			left: 100,
			right: 98,
			delta: 2, // left - right，我方多 2
			kind: "value_mismatch",
		});
		expect(result.matched).toBe(0);
	});

	it("仅一方有的键被正确归类", () => {
		const result = reconcile(
			[
				{ 物料编码: "M-001", 数量: 10 },
				{ 物料编码: "ONLY-L", 数量: 5 },
			],
			[
				{ 物料编码: "M-001", 数量: 10 },
				{ 物料编码: "ONLY-R", 数量: 7 },
			],
			opts,
		);
		expect(result.onlyLeft).toEqual(["ONLY-L"]);
		expect(result.onlyRight).toEqual(["ONLY-R"]);
		expect(result.matched).toBe(1);
		// 两边各产生一条差异
		expect(result.differences.filter((d) => d.kind === "missing_right")).toHaveLength(1);
		expect(result.differences.filter((d) => d.kind === "missing_left")).toHaveLength(1);
	});
});

describe("reconcile · 浮点容差（不做就会满屏假差异）", () => {
	it("浮点误差不算差异", () => {
		// 0.1 + 0.2 = 0.30000000000000004，没有容差就会报差异
		const result = reconcile(
			[{ 物料编码: "M-001", 数量: 0.1 + 0.2 }],
			[{ 物料编码: "M-001", 数量: 0.3 }],
			opts,
		);
		expect(result.differences).toEqual([]);
		expect(result.matched).toBe(1);
	});

	it("默认容差是一分钱", () => {
		expect(DEFAULT_TOLERANCE).toBe(0.01);
		// 刚好在容差内
		expect(
			reconcile([{ 物料编码: "A", 数量: 100 }], [{ 物料编码: "A", 数量: 100.01 }], opts).differences,
		).toEqual([]);
		// 超出容差
		expect(
			reconcile([{ 物料编码: "A", 数量: 100 }], [{ 物料编码: "A", 数量: 100.02 }], opts).differences,
		).toHaveLength(1);
	});

	it("容差可按业务调整", () => {
		// 按件数核对时可能要求完全一致
		const strict = reconcile(
			[{ 物料编码: "A", 数量: 100 }],
			[{ 物料编码: "A", 数量: 100.005 }],
			{ ...opts, tolerance: 0 },
		);
		expect(strict.differences).toHaveLength(1);
	});

	it("容差判断本身不受浮点误差影响（曾是真实缺陷）", () => {
		// 100 - 100.01 得出 -0.010000000000005116，绝对值略大于 0.01。
		// 朴素的 `Math.abs(delta) > tolerance` 会把「差额恰为一分钱、
		// 容差一分钱」判成差异 —— 用户设了容差却仍被报出边界差异。
		// 修复要点：误差量级取决于**相减的操作数**（100），不是结果（0.01）。
		const cases: Array<[number, number, number, boolean, string]> = [
			[100, 100.01, 0.01, false, "差额恰为容差"],
			[100, 100.02, 0.01, true, "差额两倍容差"],
			[100, 100.011, 0.01, true, "差额略超容差"],
			[1e9, 1e9 + 0.005, 0.01, false, "大数量级下容差内"],
			[1e9, 1e9 + 0.02, 0.01, true, "大数量级下真实差异"],
			[100, 100.005, 0, true, "零容差下任何差异都报"],
			[100, 100, 0, false, "零容差下完全相等"],
		];

		for (const [left, right, tolerance, shouldDiffer, desc] of cases) {
			const result = reconcile(
				[{ 物料编码: "A", 数量: left }],
				[{ 物料编码: "A", 数量: right }],
				{ ...opts, tolerance },
			);
			expect(result.differences.length > 0, desc).toBe(shouldDiffer);
		}
	});
});

describe("reconcile · 键的匹配", () => {
	it("脏键仍能匹配上", () => {
		const result = reconcile(
			[{ 物料编码: " m-001 ", 数量: 100 }],
			[{ 物料编码: "Ｍ-００１", 数量: 100 }],
			opts,
		);
		// 规范化后是同一个键，不该报成两边各缺一个
		expect(result.matched).toBe(1);
		expect(result.onlyLeft).toEqual([]);
		expect(result.onlyRight).toEqual([]);
	});

	it("多列组合键", () => {
		const result = reconcile(
			[
				{ 物料编码: "M-001", 批次: "B1", 数量: 10 },
				{ 物料编码: "M-001", 批次: "B2", 数量: 20 },
			],
			[
				{ 物料编码: "M-001", 批次: "B1", 数量: 10 },
				{ 物料编码: "M-001", 批次: "B2", 数量: 25 },
			],
			{ keyColumns: ["物料编码", "批次"], compareColumns: ["数量"] },
		);
		// 同物料不同批次是不同行，不能混为一谈
		expect(result.matched).toBe(1);
		expect(result.differences).toHaveLength(1);
		expect(result.differences[0]?.delta).toBe(-5);
	});

	it("组合键不因分隔符歧义而错位", () => {
		// 若用 "-" 或 "|" 拼接，「A-1 + 2」与「A + 1-2」会撞成同一个键。
		// 这类错位在真实物料编码里极易发生，且症状是「莫名其妙的差异」。
		const result = reconcile(
			[{ a: "A-1", b: "2", 数量: 10 }],
			[{ a: "A", b: "1-2", 数量: 99 }],
			{ keyColumns: ["a", "b"], compareColumns: ["数量"] },
		);
		expect(result.matched).toBe(0);
		expect(result.onlyLeft).toHaveLength(1);
		expect(result.onlyRight).toHaveLength(1);
	});

	it("空行被跳过", () => {
		const result = reconcile(
			[{ 物料编码: "M-001", 数量: 10 }, { 物料编码: "", 数量: 0 }, { 物料编码: null, 数量: null }],
			[{ 物料编码: "M-001", 数量: 10 }],
			opts,
		);
		expect(result.matched).toBe(1);
		expect(result.onlyLeft).toEqual([]);
	});

	it("重复键被提示（数据质量问题）", () => {
		const result = reconcile(
			[
				{ 物料编码: "M-001", 数量: 10 },
				{ 物料编码: "M-001", 数量: 20 },
			],
			[{ 物料编码: "M-001", 数量: 10 }],
			opts,
		);
		// 不能静默丢弃 —— 用户必须知道源数据有重复，否则会以为核对通过
		expect(result.duplicateKeys).toEqual(["M-001"]);
	});
});

describe("reconcile · 缺失值的处理", () => {
	it("一侧有值一侧为空 → 报差异而非当成 0", () => {
		const result = reconcile(
			[{ 物料编码: "A", 数量: 100 }],
			[{ 物料编码: "A", 数量: "" }],
			opts,
		);
		expect(result.differences).toHaveLength(1);
		expect(result.differences[0]).toMatchObject({
			left: 100,
			right: null,
			delta: null, // 无法计算差额，不能给出 100 这种误导性数字
			kind: "missing_right",
		});
	});

	it("两侧都为空 → 视为一致", () => {
		const result = reconcile(
			[{ 物料编码: "A", 数量: "—" }],
			[{ 物料编码: "A", 数量: "" }],
			opts,
		);
		expect(result.differences).toEqual([]);
		expect(result.matched).toBe(1);
	});
});

describe("reconcile · 契约与汇总", () => {
	it("无键列时报错而非静默返回空", () => {
		expect(() => reconcile([], [], { keyColumns: [], compareColumns: ["数量"] })).toThrow(/键列/);
	});

	it("汇总数字与实际一致", () => {
		const left: Row[] = [
			{ 物料编码: "A", 数量: 1 },
			{ 物料编码: "B", 数量: 2 },
			{ 物料编码: "C", 数量: 3 },
		];
		const right: Row[] = [
			{ 物料编码: "A", 数量: 1 },
			{ 物料编码: "B", 数量: 99 },
		];
		const result = reconcile(left, right, opts);
		expect(result.summary.leftRows).toBe(3);
		expect(result.summary.rightRows).toBe(2);
		expect(result.summary.differenceCount).toBe(result.differences.length);
		expect(result.matched).toBe(1); // 只有 A 完全一致
	});

	it("displayKey 把组合键还原成可读形式", () => {
		const result = reconcile(
			[{ a: "X", b: "1", 数量: 1 }],
			[{ a: "X", b: "1", 数量: 2 }],
			{ keyColumns: ["a", "b"], compareColumns: ["数量"] },
		);
		const key = result.differences[0]?.key ?? "";
		expect(displayKey(key)).toBe("X / 1");
		// 原始键里不该出现给人看的分隔符
		expect(key).not.toContain(" / ");
	});

	it("多比较列各自独立报差异", () => {
		const result = reconcile(
			[{ 物料编码: "A", 数量: 10, 金额: 100 }],
			[{ 物料编码: "A", 数量: 10, 金额: 90 }],
			{ keyColumns: ["物料编码"], compareColumns: ["数量", "金额"] },
		);
		expect(result.differences).toHaveLength(1);
		expect(result.differences[0]?.column).toBe("金额");
	});
});
