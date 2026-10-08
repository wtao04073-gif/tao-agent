import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { zipSync, strToU8 } from "fflate";
import { editSpreadsheet, writeWorkbook } from "../src/spreadsheet.ts";
import { writePresentation } from "../src/presentation.ts";
import { readExtendedFile, readRtfText, mergePdf } from "../src/extended-readers.ts";
import { fillDocumentTemplate } from "../src/document-template.ts";
import { writeDocx } from "../src/docx-writer.ts";
import { readDocx } from "../src/docx-reader.ts";
import { readBoundedZip, readWorkspaceFile } from "../src/file-safety.ts";
const dirs:string[]=[];
async function workspace(){const d=await mkdtemp(join(tmpdir(),"tao-office-"));dirs.push(d);return d;}
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
it("多工作表、公式、样式和原生图表真实写入XLSX",async()=>{
 const root=await workspace(),path=await writeWorkbook(root,{outputName:"报告.xlsx",sheets:[{name:"数据",columns:["产品","数量","合计"],rows:[["甲",10,{formula:"SUM(B2:B3)"}],["=HYPERLINK(\"https://example.com\")",20,null]],styles:[{range:"B2:B3",style:{numberFormat:"0.00",fill:"DCFCE7"}}],charts:[{type:"bar",title:"销售",categoryRange:"A2:A3",series:[{name:"数量",range:"B2:B3"}]}]},{name:"说明",columns:["事项"],rows:[["数据来源"]]}]});
 const files=readBoundedZip(await readFile(path));expect(new TextDecoder().decode(files["xl/charts/chart1.xml"])).toContain("barChart");expect(new TextDecoder().decode(files["xl/charts/chart1.xml"])).toContain("$B$2:$B$3");
 const book=new ExcelJS.Workbook();await book.xlsx.readFile(path);expect(book.worksheets).toHaveLength(2);expect(book.getWorksheet("数据")!.getCell("C2").formula).toBe("SUM(B2:B3)");expect(book.getWorksheet("数据")!.getCell("A3").type).toBe(ExcelJS.ValueType.String);expect(book.getWorksheet("数据")!.getCell("B2").numFmt).toBe("0.00");
 await expect(editSpreadsheet(root,{path,outputName:"修订.xlsx",edits:[{sheet:"数据",cells:[{address:"B2",value:40}]}]})).rejects.toThrow("保真");
});
it("排序携带样式，合并与公式编辑另存且原件字节不变",async()=>{
 const root=await workspace(),path=await writeWorkbook(root,{outputName:"原始.xlsx",sheets:[{name:"数据",columns:["产品","数量"],rows:[["乙",20],["甲",10]],styles:[{range:"A2",style:{bold:true}}]}]}),before=await readFile(path);
 const revised=await editSpreadsheet(root,{path,outputName:"修订.xlsx",edits:[{sheet:"数据",sort:{range:"A2:B3",column:2},cells:[{address:"C5",value:{formula:"SUM(B2:B3)"}}],merges:["A6:B6"]}]});
 const book=new ExcelJS.Workbook();await book.xlsx.readFile(revised);const sheet=book.getWorksheet("数据")!;expect(sheet.getCell("A2").value).toBe("甲");expect(sheet.getCell("A3").font.bold).toBe(true);expect(sheet.getCell("C5").formula).toBe("SUM(B2:B3)");expect(sheet.getCell("A6").isMerged).toBe(true);expect(await readFile(path)).toEqual(before);
 await expect(editSpreadsheet(root,{path,outputName:"原始.xlsx",edits:[{sheet:"数据",cells:[{address:"B2",value:0}]}]})).rejects.toThrow("同名");expect(await readFile(path)).toEqual(before);
});
it.each(["WEBSERVICE(\"https://example.com\")","HYPERLINK(\"https://example.com\")","'[evil.xlsx]Data'!A1","cmd|' /C calc'!A0"])("拒绝外部访问或执行公式%s",async f=>{const root=await workspace();await expect(writeWorkbook(root,{outputName:"拒绝.xlsx",sheets:[{name:"表",columns:["值"],rows:[[{formula:f}]]}]})).rejects.toThrow();});
it("可编辑PPT含主题、原生图表、图片和备注，读取遵循幻灯片顺序",async()=>{
 const root=await workspace();await writeFile(join(root,"图.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV0AAAAASUVORK5CYII=","base64"));
 const path=await writePresentation(root,{outputName:"汇报.pptx",title:"季度汇报",theme:{accent:"123456"},slides:[{title:"情况",body:["订单增加"],imagePath:"图.png",notes:"内部备注",chart:{type:"bar",categories:["甲","乙"],series:[{name:"销量",values:[10,20]}]}},{title:"计划",body:["扩产"]}]});
 const files=readBoundedZip(await readFile(path));expect(Object.keys(files).some(p=>p.startsWith("ppt/charts/chart"))).toBe(true);expect(Object.keys(files).some(p=>p.startsWith("ppt/media/"))).toBe(true);expect(new TextDecoder().decode(files["ppt/notesSlides/notesSlide1.xml"])).toContain("内部备注");
 const first=await readExtendedFile(root,{path,limit:1});expect(first.text).toContain("情况");expect(first.nextOffset).toBe(1);expect((await readExtendedFile(root,{path,offset:1})).text).toContain("计划");
});
it("PDF分页可读取真实文本、扫描页提示OCR、合并保留页数",async()=>{
 const root=await workspace(),doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);doc.addPage().drawText("Real PDF content",{font});doc.addPage();await writeFile(join(root,"第一.pdf"),await doc.save());
 const first=await readExtendedFile(root,{path:"第一.pdf",limit:1});expect(first.text).toContain("Real PDF content");expect(first.nextOffset).toBe(1);expect(first.requiresOcr).toBe(false);
 const scan=await readExtendedFile(root,{path:"第一.pdf",offset:1});expect(scan.requiresOcr).toBe(true);expect(scan.warnings.join()).toContain("OCR");
 const out=await mergePdf(root,{paths:["第一.pdf","第一.pdf"],outputName:"合并.pdf"});expect((await PDFDocument.load(await readFile(out))).getPageCount()).toBe(4);
});
it("DOCX模板支持跨run字段替换且保留格式，缺失值失败",async()=>{
 const root=await workspace();const template=await writeDocx({title:"合同",blocks:[{type:"paragraph",runs:[{text:"客户：{na",bold:true},{text:"me}"}]}]},{workspace:root,outputName:"模板.docx"});
 const out=await fillDocumentTemplate(root,{path:template.path,outputName:"成品.docx",data:{name:"甲公司"}});expect((await readDocx(out)).paragraphs.map(p=>p.text).join()).toContain("客户：甲公司");
 const files=readBoundedZip(await readFile(out));expect(new TextDecoder().decode(files["word/document.xml"])).toContain("w:b");await expect(fillDocumentTemplate(root,{path:template.path,outputName:"缺失.docx",data:{}})).rejects.toThrow();
 await expect(writeDocx({title:"新标题",blocks:[{type:"paragraph",text:"新正文"}]},{workspace:root,outputName:"模板.docx"})).rejects.toThrow("同名");
});
it("RTF Unicode、转义以及嵌入对象处理有界，ZIP仅安全读取文本",async()=>{
 expect(readRtfText(Buffer.from("{\\rtf1\\ansi\\ansicpg1252 Hello \\u20013?\\u25991?\\par {\\pict hidden}World}"))).toBe("Hello 中文\nWorld");
 expect(readRtfText(Buffer.from("{\\rtf1\\ansi caf\\'e9}"))).toBe("café");
 const root=await workspace();await writeFile(join(root,"代码.zip"),zipSync({"src/main.ts":strToU8("const a = 1;\nconsole.log(a);")}));
 const list=await readExtendedFile(root,{path:"代码.zip"});expect(list.entries?.[0]?.name).toBe("src/main.ts");const code=await readExtendedFile(root,{path:"代码.zip",entry:"src/main.ts",limit:1});expect(code.text).toContain("const a = 1");expect(code.nextOffset).toBe(1);
 expect(()=>readBoundedZip(zipSync({"../escape.txt":strToU8("bad")}))).toThrow("不安全");
 expect(()=>readBoundedZip(zipSync({"bomb.txt":new Uint8Array(2*1024*1024)}))).toThrow("上限");
});
it("输入越界、符号链接逃逸、输出路径和已有链接均被拒绝",async()=>{
 const root=await workspace(),outside=await workspace();await writeFile(join(outside,"秘密.txt"),"外部");await symlink(join(outside,"秘密.txt"),join(root,"链接.txt"));
 await expect(readWorkspaceFile(root,join(outside,"秘密.txt"))).rejects.toThrow("工作区");await expect(readWorkspaceFile(root,"链接.txt")).rejects.toThrow("工作区");
 const spec={sheets:[{name:"表",columns:["数据"],rows:[["值"]]}]};await expect(writeWorkbook(root,{...spec,outputName:"../越界.xlsx"})).rejects.toThrow("文件名");
 await symlink(join(outside,"秘密.txt"),join(root,"链接.xlsx"));await expect(writeWorkbook(root,{...spec,outputName:"链接.xlsx"})).rejects.toThrow("同名");expect(await readFile(join(outside,"秘密.txt"),"utf8")).toBe("外部");
});
it("Word页眉页脚、页面方向、边距和行内字体样式保留为原生结构",async()=>{
 const root=await workspace(),out=await writeDocx({title:"方案",header:"评审资料",footer:"内部使用",orientation:"landscape",marginMm:15,blocks:[{type:"paragraph",runs:[{text:"重点",font:"Arial",color:"123456",sizePt:18,underline:true}]}]},{workspace:root,outputName:"样式.docx"});
 const files=readBoundedZip(await readFile(out.path)),xml=new TextDecoder().decode(files["word/document.xml"]);expect(xml).toContain('w:orient="landscape"');expect(xml).toContain('w:val="123456"');expect(Object.keys(files).some(p=>p.startsWith("word/header"))).toBe(true);expect(Object.keys(files).some(p=>p.startsWith("word/footer"))).toBe(true);
});
it("模板嵌套循环在渲染前阻止乘法展开",async()=>{
 const root=await workspace(),template=await writeDocx({title:"列表",blocks:[{type:"paragraph",text:"{#items}{#items}{name}{/items}{/items}"}]},{workspace:root,outputName:"嵌套.docx"});
 await expect(fillDocumentTemplate(root,{path:template.path,outputName:"拒绝.docx",data:{items:Array.from({length:101},()=>({name:"内容"}))}})).rejects.toThrow("展开");
});
it("旧式write_table参数、read_table分页和read_document旧元数据契约保持兼容",async()=>{
 const {createOfficeToolset}=await import("../src/toolset.ts"),{createDocToolset}=await import("../src/doc-toolset.ts");
 const root=await workspace(),context={taskId:"test",tenant:{tenantId:"t",workspaceId:"w",userId:"u"},signal:new AbortController().signal,report:()=>{}};
 const tableTools=createOfficeToolset({workspace:root});await tableTools.find(t=>t.name==="write_table")!.execute({...context,args:{outputName:"兼容.xlsx",columns:["项目","分数"],rows:[["甲",95],["乙",90]]}});
 const table=await tableTools.find(t=>t.name==="read_table")!.execute({...context,args:{path:join(root,"兼容.xlsx"),offset:1,limit:1}});expect(table.text).toContain("乙");expect(table.details).toMatchObject({rowCount:2,offset:1,returned:1,nextOffset:null});
 const doc=await writeDocx({title:"规范",blocks:[{type:"heading",level:1,text:"职责"},{type:"paragraph",text:"执行标准"}]},{workspace:root,outputName:"规范.docx"});
 const read=createDocToolset({workspace:root}).find(t=>t.name==="read_document")!;
 const word=await read.execute({...context,args:{path:doc.path,fromParagraph:2}});expect(word.details).toMatchObject({tableCount:0,returned:2,from:2,to:3,total:3});expect(word.text).toContain("执行标准");
 const outline=await read.execute({...context,args:{path:doc.path,outlineOnly:true}});expect(outline.text).toContain("职责");
 await writeFile(join(root,"说明.txt"),"首行\n末行");const text=await read.execute({...context,args:{path:join(root,"说明.txt"),fromParagraph:2}});expect(text.text).toContain("末行");expect(text.details).toMatchObject({format:"txt",total:2,from:2,to:2,returned:1,nextOffset:null});
 const misroute=await read.execute({...context,args:{path:join(root,"兼容.xlsx")}});expect(misroute.isError).toBe(true);expect(misroute.text).toContain("read_table");
});
