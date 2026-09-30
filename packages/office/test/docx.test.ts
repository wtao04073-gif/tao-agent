/**
 * 文档读写测试
 *
 * 断言重点是**产出内容的业务正确性**，不是「文件存在」。
 * M1 做 xlsx 时的经验：「能打开」与「内容对」是两件事，
 * 只验前者会漏掉公式退化这类致命问题。
 *
 * 所以每个写入测试都把文件**读回来**验证内容 —— 这也顺带验证了
 * 读写两端的一致性（round-trip）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BlockType,
	describeDocModel,
	validateDocModel,
	type DocModel,
} from "../src/doc-model.ts";
import { readDocx, readDocxOutline } from "../src/docx-reader.ts";
import { writeDocx } from "../src/docx-writer.ts";
import { validateDocx } from "../src/validate-docx.ts";

const dirs: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "docx-test-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一份结构接近真实整改台账的文档。 */
const LEDGER_DOC: DocModel = {
	title: "本科教学工作合格评估整改台账",
	blocks: [
		{ type: BlockType.Heading, level: 1, text: "一、整改总体情况" },
		{
			type: BlockType.Paragraph,
			text: "根据上级检查反馈意见，现将整改事项梳理如下。",
		},
		{
			type: BlockType.Table,
			header: ["序号", "问题描述", "责任部门", "完成期限"],
			rows: [
				["1", "部分课程大纲未及时更新", "教务处", "2026-12-31"],
				["2", "实验室安全管理制度需完善", "待分工", "2026-11-30"],
			],
		},
		{ type: BlockType.Heading, level: 1, text: "二、需补充说明的事项" },
		{
			type: BlockType.Paragraph,
			runs: [
				{ text: "第 2 项的责任部门" },
				{ text: "待分工", placeholder: true },
				{ text: "，需由校办明确后填写。" },
			],
		},
	],
};

describe("文档模型 · 校验", () => {
	it("合法文档通过校验", () => {
		expect(validateDocModel(LEDGER_DOC).ok).toBe(true);
	});

	it("标题为空被检出", () => {
		const result = validateDocModel({ title: "  ", blocks: LEDGER_DOC.blocks });
		expect(result.ok).toBe(false);
		expect(result.issues.map((i) => i.message).join("|")).toContain("标题不能为空");
	});

	it("没有内容块被检出", () => {
		const result = validateDocModel({ title: "空文档", blocks: [] });
		expect(result.ok).toBe(false);
		expect(result.issues.map((i) => i.message).join("|")).toContain("没有任何内容块");
	});

	it("表格列数不齐被检出，且指出是第几行", () => {
		// 这是最常见的畸形输入，且会让 Word 打开时提示文件损坏
		const result = validateDocModel({
			title: "台账",
			blocks: [
				{
					type: BlockType.Table,
					header: ["序号", "问题", "部门"],
					rows: [
						["1", "问题一", "教务处"],
						["2", "问题二"], // 少一列
					],
				},
			],
		});
		expect(result.ok).toBe(false);
		const message = result.issues.map((i) => i.message).join("|");
		expect(message).toContain("第 2 行");
		expect(message).toContain("2 列");
		expect(message).toContain("3 列");
	});

	it("报错带块序号，便于定位", () => {
		const result = validateDocModel({
			title: "文档",
			blocks: [
				{ type: BlockType.Paragraph, text: "正常段落" },
				{ type: BlockType.Heading, level: 1, text: "" }, // 第 2 块出问题
			],
		});
		expect(result.issues[0]?.blockIndex).toBe(1);
	});

	it("段落同时给 text 与 runs 被拒绝", () => {
		// 两者都给会产生「哪个生效」的歧义，宁可报错
		const result = validateDocModel({
			title: "文档",
			blocks: [{ type: BlockType.Paragraph, text: "甲", runs: [{ text: "乙" }] }],
		});
		expect(result.ok).toBe(false);
		expect(result.issues.map((i) => i.message).join("|")).toContain("不能同时给");
	});

	it("段落既无 text 也无 runs 被检出", () => {
		const result = validateDocModel({
			title: "文档",
			blocks: [{ type: BlockType.Paragraph }],
		});
		expect(result.ok).toBe(false);
	});

	it("空列表被检出", () => {
		const result = validateDocModel({
			title: "文档",
			blocks: [{ type: BlockType.BulletList, items: [] }],
		});
		expect(result.ok).toBe(false);
	});

	it("字号超出合理范围被检出", () => {
		expect(validateDocModel({ ...LEDGER_DOC, bodySizePt: 200 }).ok).toBe(false);
		expect(validateDocModel({ ...LEDGER_DOC, bodySizePt: 2 }).ok).toBe(false);
		expect(validateDocModel({ ...LEDGER_DOC, bodySizePt: 12 }).ok).toBe(true);
	});

	it("统计能数出待补充项", () => {
		const stats = describeDocModel(LEDGER_DOC);
		expect(stats.headings).toBe(2);
		expect(stats.tables).toBe(1);
		expect(stats.placeholders).toBe(1);
	});
});

describe("文档生成 · 写入后读回验证内容", () => {
	it("标题层级与正文都正确落地", async () => {
		const ws = workspace();
		const { path } = await writeDocx(LEDGER_DOC, { workspace: ws, outputName: "台账.docx" });

		const result = await readDocx(path);
		const texts = result.paragraphs.map((p) => p.text);

		expect(texts).toContain("一、整改总体情况");
		expect(texts).toContain("二、需补充说明的事项");
		expect(texts.join("\n")).toContain("根据上级检查反馈意见");

		// 标题必须被识别为标题，否则审核时没法按指标逐条对照
		const headings = result.paragraphs.filter((p) => p.isHeading).map((p) => p.text);
		expect(headings).toContain("一、整改总体情况");
	});

	it("表格内容完整落地", async () => {
		const ws = workspace();
		const { path } = await writeDocx(LEDGER_DOC, { workspace: ws, outputName: "台账.docx" });

		const result = await readDocx(path);
		expect(result.tableCount).toBe(1);

		const all = result.paragraphs.map((p) => p.text).join("\n");
		expect(all).toContain("部分课程大纲未及时更新");
		expect(all).toContain("教务处");
		expect(all).toContain("2026-12-31");
		// 表头也要在
		expect(all).toContain("责任部门");
	});

	it("中文不乱码", async () => {
		const ws = workspace();
		const { path } = await writeDocx(LEDGER_DOC, { workspace: ws, outputName: "台账.docx" });
		const result = await readDocx(path);
		expect(result.paragraphs.map((p) => p.text).join("")).toContain("实验室安全管理制度需完善");
	});

	it("表格单元格之间有分隔符（否则模型会串列）", async () => {
		// 曾经的真实缺陷：直接去 HTML 标签会把一行拼成
		// 「1部分课程大纲未及时更新教务处2026-12-31」，
		// 模型读到这种文本无法还原列边界，处理台账时必然串列。
		const ws = workspace();
		const { path } = await writeDocx(LEDGER_DOC, { workspace: ws, outputName: "台账.docx" });

		const result = await readDocx(path);
		const tableText = result.paragraphs.find((p) => p.text.includes("责任部门"))?.text ?? "";

		expect(tableText).toContain("|");
		// 表头一行能被切回四列
		const headerCells = tableText.split("\n")[0]?.split("|").map((s) => s.trim());
		expect(headerCells).toEqual(["序号", "问题描述", "责任部门", "完成期限"]);

		// 相邻单元格内容不能粘连
		expect(tableText).not.toContain("教务处2026");
	});

	it("列表落地为独立段落", async () => {
		const ws = workspace();
		const { path } = await writeDocx(
			{
				title: "检查要点",
				blocks: [
					{ type: BlockType.BulletList, items: ["消防通道畅通", "灭火器在有效期内"] },
					{ type: BlockType.NumberedList, items: ["第一步核查", "第二步整改"] },
				],
			},
			{ workspace: ws, outputName: "要点.docx" },
		);

		const all = (await readDocx(path)).paragraphs.map((p) => p.text);
		// 每条独立成段 —— 整改措施、检查要点都是逐条引用的，
		// 粘成一段就没法标注「第几条」
		expect(all).toContain("消防通道畅通");
		expect(all).toContain("灭火器在有效期内");
		expect(all).toContain("第一步核查");
	});

	it("自定义字体与字号不报错且文件合法", async () => {
		// 体系文件与公文常有明确字体规定，写死会让产出被审核退回
		const ws = workspace();
		const { path } = await writeDocx(
			{ ...LEDGER_DOC, bodyFont: "仿宋_GB2312", bodySizePt: 16 },
			{ workspace: ws, outputName: "公文.docx" },
		);
		expect((await validateDocx(path)).ok).toBe(true);
	});

	it("结构非法时抛错且不产出文件", async () => {
		const ws = workspace();
		await expect(
			writeDocx(
				{
					title: "坏文档",
					blocks: [{ type: BlockType.Table, header: ["A", "B"], rows: [["1"]] }],
				},
				{ workspace: ws, outputName: "坏.docx" },
			),
		).rejects.toThrow(/表格第 1 行/);

		// 不能留下一个半成品文件
		await expect(readDocx(join(ws, "坏.docx"))).rejects.toThrow();
	});

	it("输出名含路径时被拒绝（安全边界）", async () => {
		// 允许模型指定任意输出路径等于绕过路径策略
		const ws = workspace();
		for (const name of ["../逃逸.docx", "sub/dir.docx", "/etc/x.docx"]) {
			await expect(
				writeDocx(LEDGER_DOC, { workspace: ws, outputName: name }),
			).rejects.toThrow(/不能包含路径/);
		}
	});
});

describe("文档读取 · 分批与骨架", () => {
	/** 造一份长文档。 */
	async function longDoc(ws: string): Promise<string> {
		const blocks = Array.from({ length: 60 }, (_, i) =>
			i % 10 === 0
				? ({ type: BlockType.Heading, level: 2, text: `第 ${i / 10 + 1} 章` } as const)
				: ({ type: BlockType.Paragraph, text: `这是第 ${i + 1} 个段落的内容。` } as const),
		);
		const { path } = await writeDocx(
			{ title: "评估指标体系", blocks },
			{ workspace: ws, outputName: "指标.docx" },
		);
		return path;
	}

	it("总段落数正确，与分批返回数分开报告", async () => {
		const path = await longDoc(workspace());
		const result = await readDocx(path, { limit: 10 });

		expect(result.paragraphs).toHaveLength(10);
		// total 是全文段落数，不是本次返回数 —— 混淆会让调用方以为读完了
		expect(result.total).toBeGreaterThan(10);
	});

	it("从指定段落继续读，衔接不重不漏", async () => {
		const path = await longDoc(workspace());
		const first = await readDocx(path, { limit: 10 });
		const second = await readDocx(path, { fromParagraph: 11, limit: 10 });

		expect(first.paragraphs.at(-1)?.index).toBe(10);
		expect(second.paragraphs[0]?.index).toBe(11);
		// 内容不重复
		expect(second.paragraphs[0]?.text).not.toBe(first.paragraphs.at(-1)?.text);
	});

	it("段落序号是稳定的溯源定位符", async () => {
		const path = await longDoc(workspace());
		// 同一段落无论怎么分批读，序号都一致
		const whole = await readDocx(path);
		const batch = await readDocx(path, { fromParagraph: 15, limit: 3 });

		expect(batch.paragraphs[0]?.index).toBe(15);
		expect(batch.paragraphs[0]?.text).toBe(whole.paragraphs[14]?.text);
	});

	it("骨架只含标题，长度远小于全文", async () => {
		const path = await longDoc(workspace());
		const outline = await readDocxOutline(path);
		const whole = await readDocx(path);

		expect(outline.length).toBe(6);
		expect(outline.every((p) => p.isHeading)).toBe(true);
		expect(outline.length).toBeLessThan(whole.total / 5);
	});

	it("超出范围的 fromParagraph 返回空而非报错", async () => {
		const path = await longDoc(workspace());
		const result = await readDocx(path, { fromParagraph: 9999 });
		expect(result.paragraphs).toEqual([]);
		// 但总数仍然如实报告
		expect(result.total).toBeGreaterThan(0);
	});

	it("损坏文件抛错而非返回空", async () => {
		// 静默返回空会让「文件坏了」被当成「文档是空的」
		const ws = workspace();
		const bad = join(ws, "坏.docx");
		writeFileSync(bad, "not a docx at all");
		await expect(readDocx(bad)).rejects.toThrow();
	});
});

describe("文档校验 · 产出后自检", () => {
	it("正常文档通过校验并报告统计", async () => {
		const ws = workspace();
		const { path } = await writeDocx(LEDGER_DOC, { workspace: ws, outputName: "台账.docx" });

		const result = await validateDocx(path, { expectHeadings: true, expectTables: 1 });
		expect(result.ok).toBe(true);
		expect(result.stats.headings).toBeGreaterThan(0);
		expect(result.stats.tables).toBe(1);
		expect(result.stats.bytes).toBeGreaterThan(0);
	});

	it("不存在的文件报错而非崩溃", async () => {
		const result = await validateDocx("/nonexistent/x.docx");
		expect(result.ok).toBe(false);
		expect(result.issues[0]?.message).toContain("无法读取");
	});

	it("非 docx 文件被识别出来", async () => {
		const ws = workspace();
		const fake = join(ws, "假的.docx");
		writeFileSync(fake, "这只是一个文本文件");

		const result = await validateDocx(fake);
		expect(result.ok).toBe(false);
		expect(result.issues.map((i) => i.message).join("|")).toContain("不是合法的 docx");
	});

	it("预期有标题但实际没有时报错（防结构退化）", async () => {
		const ws = workspace();
		const { path } = await writeDocx(
			{ title: "纯段落", blocks: [{ type: BlockType.Paragraph, text: "只有一段话" }] },
			{ workspace: ws, outputName: "纯段落.docx" },
		);

		// 注意：writeDocx 会把 title 渲染为 TITLE 样式，mammoth 不一定
		// 识别为 h1-h6，所以这里验的是「正文里没有标题层级」
		const result = await validateDocx(path, { expectHeadings: true });
		expect(result.ok).toBe(false);
		expect(result.issues.map((i) => i.message).join("|")).toContain("退化");
	});

	it("表格数量不足时报错", async () => {
		const ws = workspace();
		const { path } = await writeDocx(LEDGER_DOC, { workspace: ws, outputName: "台账.docx" });
		const result = await validateDocx(path, { expectTables: 3 });
		expect(result.ok).toBe(false);
		expect(result.issues.map((i) => i.message).join("|")).toContain("预期含 3 个表格");
	});
});
