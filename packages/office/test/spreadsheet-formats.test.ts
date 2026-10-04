import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { afterEach, expect, it } from "vitest";
import { readSheet, listSheets } from "../src/xlsx-reader.ts";
import { createOfficeToolset } from "../src/toolset.ts";
const dirs: string[] = [];
function file(name: string) { const dir = mkdtempSync(join(tmpdir(), "tao-formats-")); dirs.push(dir); return join(dir, name); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it.each(["xls", "xlsx"] as const)("真实%s文件支持列出工作表与数据核对", async (type) => {
 const path = file(`评估.${type}`), book = XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["评估项", "分数"], ["审计", 95], ["权限", 80]]), "评估");
 XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["说明"], ["内部资料"]]), "说明");
 writeFileSync(path, XLSX.write(book, { type: "buffer", bookType: type === "xls" ? "biff8" : "xlsx" }));
 expect(await listSheets(path)).toEqual(["评估", "说明"]);
 expect((await readSheet(path)).rows).toEqual([{ 评估项: "审计", 分数: 95 }, { 评估项: "权限", 分数: 80 }]);
});
it("HTML导出即使名为xlsx也按内容读取，不执行脚本", async () => {
 const path = file("导出.xlsx");
 writeFileSync(path, '<html><table><tr><th>项目</th><th>结果</th></tr><tr><td>权限</td><td>通过</td></tr></table></html>');
 const data = await readSheet(path);
 expect(data.format).toBe("html-table"); expect(data.rows[0]).toEqual({ 项目: "权限", 结果: "通过" });
});
it("Excel XML和UTF16 TSV可以读取", async () => {
 const path = file("导出.xls"), book = XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["项目", "分数"], ["审计", 90]]), "说明");
 writeFileSync(path, XLSX.write(book, { type: "buffer", bookType: "xlml" }));
 expect((await readSheet(path)).rows[0]).toEqual({ 项目: "审计", 分数: 90 });
 const tsv = file("中文.tsv");writeFileSync(tsv, Buffer.from('\ufeff项目\t编号\n审计\t001\n', "utf16le"));
 expect((await readSheet(tsv)).rows[0]).toEqual({ 项目: "审计", 编号: "001" });
});
it("空列、重复列和合并标题不丢列，可指定实际表头", async () => {
 const path = file("合并.xlsx"), book = XLSX.utils.book_new();
 const ws = XLSX.utils.aoa_to_sheet([["评估表"], ["项目", null, "结果", "结果"], ["审计", "备注", "通过", "不通过"]]);
 ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
 XLSX.utils.book_append_sheet(book, ws, "评估");writeFileSync(path, XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
 const data = await readSheet(path, undefined, { headerRow: 2 });
 expect(data.columns).toEqual(["项目", "列B", "结果", "结果_2"]);
 expect(data.rows[0]).toEqual({ 项目: "审计", 列B: "备注", 结果: "通过", 结果_2: "不通过" });
 expect(data.rowNumbers).toEqual([3]);
});
it("分页能读取第五行以后的内容，保留真实行号和续读位置", async () => {
 const path = file("长表.csv"); writeFileSync(path, '项目,分数\n'+Array.from({length:120},(_,i)=>`项目${i},${i}`).join('\n'));
 const tool = createOfficeToolset({ workspace: tmpdir() }).find(t => t.name === "read_table")!;
 const result = await tool.execute({ args: { path, offset: 50, limit: 50 }, taskId:"t", tenant:{tenantId:"t",workspaceId:"w",userId:"u"}, signal:new AbortController().signal, report:()=>{} });
 expect(result.text).toContain("[第52行]");expect(result.text).toContain("项目99");expect(result.text).not.toContain("项目100");
 expect(result.details).toMatchObject({ nextOffset:100, returned:50, rowCount:120 });
});
it("损坏、非表格及实体声明不会被默认为成功", async () => {
 for (const content of ['这不是Excel文件', '', '<!DOCTYPE Workbook [<!ENTITY x SYSTEM "file:///etc/passwd">]><Workbook/>']) {
  const path = file("坏文件.xls");writeFileSync(path,content);await expect(readSheet(path)).rejects.toThrow();
 }
});
it("旧xls与xlsx可以直接对账并生成可读取的xlsx报告", async () => {
 const path=file("左表.xls"), other=join(dirs.at(-1)!,"右表.xlsx");
 for (const [p,n,type] of [[path,10,"biff8"],[other,8,"xlsx"]] as const) {
  const b=XLSX.utils.book_new();XLSX.utils.book_append_sheet(b,XLSX.utils.aoa_to_sheet([["项目","数量"],["甲",n]]),"表");writeFileSync(p,XLSX.write(b,{type:"buffer",bookType:type}));
 }
 const tool=createOfficeToolset({workspace:dirs.at(-1)!}).find(t=>t.name==="reconcile_tables")!;
 const r=await tool.execute({args:{leftPath:path,rightPath:other,keyColumns:["项目"],compareColumns:["数量"]},taskId:"t",tenant:{tenantId:"t",workspaceId:"w",userId:"u"},signal:new AbortController().signal,report:()=>{}});
 expect(r.isError).toBeUndefined();expect(await listSheets(join(dirs.at(-1)!,"对账差异报告.xlsx"))).toEqual(["核对汇总","差异明细"]);
});
it("未缓存公式给出说明，日期与零值不丢失", async () => {
 const path=file("缓存.xlsx"),book=XLSX.utils.book_new();
 const ws=XLSX.utils.aoa_to_sheet([["日期","数量","公式"],[new Date("2026-10-01T00:00:00Z"),0,null]]);
 ws.C2={t:"n",f:"B2+1"};ws['!ref']='A1:C2';
 XLSX.utils.book_append_sheet(book,ws,"表");writeFileSync(path,XLSX.write(book,{type:"buffer",bookType:"xlsx"}));
 const data=await readSheet(path);expect(data.rows[0]?.["数量"]).toBe(0);expect(data.rows[0]?.["日期"]).toBeInstanceOf(Date);
 expect(data.warnings.join()).toContain("公式没有缓存");
});
