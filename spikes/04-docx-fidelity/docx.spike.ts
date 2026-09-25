/**
 * Spike 4 · docx 读写保真度验证
 *
 * 为什么必须先做探针而不是直接写工具：目标客户的付费动机是「通过审核与客户验厂」，
 * 产出要能直接提交客户或专家组。如果 docx 的标题层级、表格、样式在生成后
 * 打不开或退化成纯文本，整条文档链路就是废的 —— 而这件事**只有真跑一遍才知道**。
 *
 * M1 做 xlsx 时用同样方式发现了「公式必须用 {formula} 对象否则退化为文本」，
 * 那次探针省掉了后面一堆返工。
 *
 * 验证四件事：
 *  1. `docx` 写出的文件能被 `mammoth` 读回，且标题层级不丢
 *  2. 表格结构与单元格文本不丢
 *  3. 中文与中文字体设置不乱码
 *  4. 读回的内容能定位到原文位置（溯源需要「哪一段」）
 *
 * 结论写进 [spikes/README.md](../README.md)。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AlignmentType,
	Document,
	HeadingLevel,
	Packer,
	Paragraph,
	Table,
	TableCell,
	TableRow,
	TextRun,
	WidthType,
} from "docx";
import mammoth from "mammoth";
import { afterAll, describe, expect, it } from "vitest";

const dirs: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "spike4-docx-"));
	dirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一份结构接近真实 8D 报告的文档。 */
async function writeSample(path: string): Promise<void> {
	const doc = new Document({
		styles: {
			default: {
				document: {
					run: { font: "宋体", size: 24 }, // size 单位是半磅，24 = 12pt
				},
			},
		},
		sections: [
			{
				children: [
					new Paragraph({
						text: "8D 问题解决报告",
						heading: HeadingLevel.HEADING_1,
						alignment: AlignmentType.CENTER,
					}),
					new Paragraph({
						text: "D1 成立跨职能小组",
						heading: HeadingLevel.HEADING_2,
					}),
					new Paragraph({
						children: [
							new TextRun("组长由质量部张工担任，成员涵盖"),
							new TextRun({ text: "工艺、生产、采购", bold: true }),
							new TextRun("三个部门。"),
						],
					}),
					new Paragraph({
						text: "D2 问题描述",
						heading: HeadingLevel.HEADING_2,
					}),
					new Paragraph("客户反馈刹车盘端面跳动超差，批次 20260801。"),
					new Table({
						width: { size: 100, type: WidthType.PERCENTAGE },
						rows: [
							new TableRow({
								children: [
									new TableCell({ children: [new Paragraph("检验项")] }),
									new TableCell({ children: [new Paragraph("标准值")] }),
									new TableCell({ children: [new Paragraph("实测值")] }),
								],
							}),
							new TableRow({
								children: [
									new TableCell({ children: [new Paragraph("端面跳动")] }),
									new TableCell({ children: [new Paragraph("≤0.05mm")] }),
									new TableCell({ children: [new Paragraph("0.12mm")] }),
								],
							}),
						],
					}),
					new Paragraph({
						text: "D4 根本原因",
						heading: HeadingLevel.HEADING_2,
					}),
					new Paragraph("待补充：需提供 SPC 数据与设备点检记录。"),
				],
			},
		],
	});

	writeFileSync(path, await Packer.toBuffer(doc));
}

describe("Spike 4 · docx 生成后能被读回", () => {
	it("文件真实写出且非空", async () => {
		const path = join(workspace(), "8D报告.docx");
		await writeSample(path);
		const bytes = readFileSync(path);
		// docx 是 zip 容器，魔数 PK
		expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
		expect(bytes.length).toBeGreaterThan(1000);
	});

	it("标题层级不丢（HTML 里体现为 h1/h2）", async () => {
		const path = join(workspace(), "a.docx");
		await writeSample(path);

		const { value: html } = await mammoth.convertToHtml({ path });

		// 标题层级是审核材料的骨架 —— 退化成普通段落就没法按指标逐条对照
		expect(html).toMatch(/<h1[^>]*>8D 问题解决报告<\/h1>/);
		expect(html).toContain("D1 成立跨职能小组");
		expect(html).toMatch(/<h2/);
	});

	it("表格结构与单元格文本不丢", async () => {
		const path = join(workspace(), "b.docx");
		await writeSample(path);

		const { value: html } = await mammoth.convertToHtml({ path });

		expect(html).toContain("<table>");
		expect(html).toContain("端面跳动");
		expect(html).toContain("≤0.05mm");
		expect(html).toContain("0.12mm");
	});

	it("中文不乱码，加粗等行内格式保留", async () => {
		const path = join(workspace(), "c.docx");
		await writeSample(path);

		const { value: html } = await mammoth.convertToHtml({ path });

		expect(html).toContain("客户反馈刹车盘端面跳动超差");
		// 行内加粗用于强调关键结论，不能丢
		expect(html).toMatch(/<strong>工艺、生产、采购<\/strong>/);
	});

	it("纯文本提取可用，且保留段落切分", async () => {
		// 溯源需要「哪一段」，所以必须能按段落切
		const path = join(workspace(), "d.docx");
		await writeSample(path);

		const { value: text } = await mammoth.extractRawText({ path });
		const paragraphs = text.split("\n").filter((l) => l.trim() !== "");

		expect(paragraphs.length).toBeGreaterThan(5);
		expect(paragraphs[0]).toContain("8D 问题解决报告");
		expect(text).toContain("待补充");
	});

	it("反向验证：不存在的内容确实读不到", async () => {
		// 若断言在任何情况下都通过，它就只是装饰（spike 纪律）
		const path = join(workspace(), "e.docx");
		await writeSample(path);

		const { value: html } = await mammoth.convertToHtml({ path });
		expect(html).not.toContain("这段话从未写入文档");
		expect(html).not.toMatch(/<h3/); // 样例里没有三级标题
	});

	it("空文档不报错，产出仍是合法 docx", async () => {
		// 边界：模型可能生成一份没有内容的文档，此时不该崩
		const path = join(workspace(), "empty.docx");
		const doc = new Document({ sections: [{ children: [] }] });
		writeFileSync(path, await Packer.toBuffer(doc));

		const { value: text } = await mammoth.extractRawText({ path });
		expect(text.trim()).toBe("");
	});

	it("读取损坏文件时抛错而非静默返回空", async () => {
		// 静默返回空会让「文件坏了」被当成「文档是空的」
		const path = join(workspace(), "broken.docx");
		writeFileSync(path, "this is not a docx");

		await expect(mammoth.extractRawText({ path })).rejects.toThrow();
	});
});
