import { addWorkbookCharts, type SpreadsheetChart } from "./spreadsheet-charts.ts";
import ExcelJS from "exceljs";
import type { PlatformTool } from "@tao/core";
import { boundedJson, parseSafeXml, publishFile, readBoundedZip, readWorkspaceFile } from "./file-safety.ts";
export type TableValue = string | number | boolean | null | { formula: string; result?: number | string | boolean };
export interface CellStyle { bold?: boolean; color?: string; fill?: string; numberFormat?: string; align?: "left" | "center" | "right"; wrapText?: boolean }
export interface SheetSpec { name: string; columns: string[]; rows: TableValue[][]; widths?: number[]; charts?: SpreadsheetChart[]; merges?: string[]; styles?: { range: string; style: CellStyle }[] }
const FUNCTIONS = new Set("SUM AVERAGE MIN MAX COUNT COUNTA COUNTIF COUNTIFS SUMIF SUMIFS IF IFERROR AND OR NOT ROUND ROUNDUP ROUNDDOWN ABS INT MOD CONCAT CONCATENATE LEFT RIGHT MID LEN TRIM UPPER LOWER VLOOKUP HLOOKUP INDEX MATCH XLOOKUP TODAY DATE YEAR MONTH DAY TEXT VALUE SUBTOTAL SUMPRODUCT MEDIAN STDEV STDEV.S VAR VAR.S".split(" "));
function formula(input: string): string {
 if (typeof input !== "string" || !input || input.length > 4000) throw new Error("公式无效或过长");
 const f = input.replace(/^=/, ""), plain = f.replace(/"(?:[^"]|"")*"/g, '""');
 if (/[\[\]{}|\\\r\n]/.test(plain) || /(?:https?:|file:|ftp:|@)/i.test(plain)) throw new Error("公式不允许外部引用、动态执行或外部数据访问");
 for (const m of plain.matchAll(/([A-Z_][A-Z0-9_.]*)\s*\(/gi)) if (!FUNCTIONS.has(m[1]!.toUpperCase())) throw new Error(`公式函数不在安全列表：${m[1]}`);
 if (!/^[\w\s\u0080-\uffff.$'"!:+*/^%(),<>=?&-]+$/.test(f)) throw new Error("公式包含不支持字符");
 return f;
}
function value(v: TableValue): ExcelJS.CellValue {
 if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
 if (typeof v === "string" && v.length <= 32767) return v; // 文本永远是字符串，即使以 = + - @ 开头。
 if (v && typeof v === "object" && "formula" in v) {
  if (v.result !== undefined && !["number", "string", "boolean"].includes(typeof v.result)) throw new Error("公式缓存值无效");
  if (typeof v.result === "number" && !Number.isFinite(v.result)) throw new Error("公式缓存值必须有限");
  return { formula: formula(v.formula), ...(v.result === undefined ? {} : { result: v.result }) };
 }
 throw new Error("单元格仅支持文本、有限数字、布尔值、空值或显式formula对象");
}
function range(input: string) {
 const m = /^([A-Z]{1,3})([1-9]\d{0,4})(?::([A-Z]{1,3})([1-9]\d{0,4}))?$/.exec(input);
 if (!m) throw new Error("单元格区域须为A1或A1:C10");
 const col = (s: string) => [...s].reduce((v, c) => v * 26 + c.charCodeAt(0) - 64, 0);
 const r1 = +m[2]!, c1 = col(m[1]!), r2 = +(m[4] ?? m[2]!), c2 = col(m[3] ?? m[1]!);
 if (c2 > 100 || r2 > 10001 || r1 > r2 || c1 > c2 || (r2-r1+1)*(c2-c1+1) > 100000) throw new Error("区域超过100列、10001行或10万单元格上限");
 return { r1, c1, r2, c2 };
}
function styleCells(sheet: ExcelJS.Worksheet, input: string, s: CellStyle) {
 const {r1,c1,r2,c2} = range(input);
 if (!s || typeof s !== "object") throw new Error("样式无效");
 for (const c of [s.color, s.fill]) if (c !== undefined && !/^[0-9a-f]{6}$/i.test(c)) throw new Error("颜色须为6位十六进制");
 if (s.numberFormat !== undefined && (typeof s.numberFormat !== "string" || s.numberFormat.length > 100)) throw new Error("数字格式无效");
 if (s.align !== undefined && !["left","center","right"].includes(s.align)) throw new Error("对齐方式无效");
 for(let r=r1;r<=r2;r++) for(let c=c1;c<=c2;c++) {
  const cell = sheet.getCell(r,c);
  cell.font = {...cell.font, ...(s.bold === undefined ? {} : {bold:s.bold}), ...(s.color ? {color:{argb:"FF"+s.color}} : {})};
  if (s.fill) cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF"+s.fill}};
  if (s.numberFormat) cell.numFmt=s.numberFormat;
  cell.alignment={...cell.alignment,...(s.align ? {horizontal:s.align}:{}),...(s.wrapText === undefined ? {} : {wrapText:s.wrapText})};
 }
}
function addSheet(book: ExcelJS.Workbook, spec: SheetSpec) {
 if (!spec || typeof spec.name !== "string" || !spec.name.trim() || spec.name.length>31 || /[\\/\[\]:*?\x00-\x1f]/.test(spec.name)) throw new Error("工作表名无效");
 if (!Array.isArray(spec.columns)||!spec.columns.length||spec.columns.length>100||spec.columns.some(c=>typeof c!=="string"||!c.trim()||c.length>200)) throw new Error("列名无效，最多100列");
 if (!Array.isArray(spec.rows)||spec.rows.length>10000||spec.rows.some(r=>!Array.isArray(r)||r.length!==spec.columns.length)) throw new Error("每行列数须与表头一致，最多10000行");
 const s=book.addWorksheet(spec.name);s.addRow(spec.columns);s.getRow(1).font={bold:true};s.views=[{state:"frozen",ySplit:1}];
 for (const row of spec.rows) s.addRow(row.map(value));
 s.columns.forEach((c,i)=>{ const w=spec.widths?.[i]??22;if(!Number.isFinite(w)||w<4||w>100)throw new Error("列宽须为4至100");c.width=w; });
 if((spec.merges?.length??0)>100||(spec.styles?.length??0)>100)throw new Error("合并或样式操作超过100项");
 for(const m of spec.merges??[]) {range(m);s.mergeCells(m);}
 for(const entry of spec.styles??[])styleCells(s,entry.range,entry.style);
 return s;
}
export async function writeWorkbook(workspace: string, input: { outputName: string; sheets: SheetSpec[] }) {
 boundedJson(input);
 if(!Array.isArray(input.sheets)||!input.sheets.length||input.sheets.length>20)throw new Error("须提供1至20张工作表");
 const book=new ExcelJS.Workbook();book.calcProperties.fullCalcOnLoad=true;
 for(const s of input.sheets)addSheet(book,s);
 return publishFile(workspace,input.outputName,".xlsx",addWorkbookCharts(Buffer.from(await book.xlsx.writeBuffer()),book,input.sheets.map(s=>s.charts)));
}
export interface SpreadsheetEdit { sheet: string; cells?: { address: string; value: TableValue }[]; styles?: { range: string; style: CellStyle }[]; merges?: string[]; unmerges?: string[]; sort?: { range: string; column: number; descending?: boolean }; appendRows?: TableValue[][] }
export async function editSpreadsheet(workspace: string, input: { path: string; outputName: string; edits: SpreadsheetEdit[]; addSheets?: SheetSpec[] }) {
 boundedJson(input);
 if(!Array.isArray(input.edits)||input.edits.length>100||(!input.edits.length&&!input.addSheets?.length))throw new Error("须提供编辑操作，最多100组");
 const source=await readWorkspaceFile(workspace,input.path),files=readBoundedZip(source);
 if(!files["xl/workbook.xml"])throw new Error("编辑仅支持XLSX，请先转换旧格式");
 // ExcelJS不完整保留高级对象。拒绝而非静默删除图表、宏、透视表或外部链接。
 if(Object.keys(files).some(k=>/^xl\/(drawings|charts|pivot|externalLinks|vbaProject|slicer|activeX|ctrlProps)/i.test(k)))throw new Error("此工作簿包含图表、绘图、宏、透视表或外部链接，暂不能保真编辑；请提供纯数据副本");
 for(const [name,data] of Object.entries(files))if(name.endsWith(".xml"))parseSafeXml(data);
 const book=new ExcelJS.Workbook();await book.xlsx.load(source as never);
 if(book.worksheets.length>20)throw new Error("工作簿超过20张工作表");
 for(const s of book.worksheets)if(s.rowCount>10001||s.columnCount>100)throw new Error("工作表超过编辑范围上限");
 for(const e of input.edits) {
  const s=book.getWorksheet(e.sheet);if(!s)throw new Error(`找不到工作表：${e.sheet}`);
  if((e.cells?.length??0)>10000||(e.styles?.length??0)>100||(e.merges?.length??0)>100||(e.unmerges?.length??0)>100)throw new Error("编辑操作数量超限");
  for(const item of e.cells??[]) {const r=range(item.address);if(r.r1!==r.r2||r.c1!==r.c2)throw new Error("cells.address须为单个单元格");s.getCell(item.address).value=value(item.value);}
  for(const item of e.styles??[])styleCells(s,item.range,item.style);
  for(const m of e.unmerges??[]){range(m);s.unMergeCells(m);}
  for(const m of e.merges??[]){range(m);s.mergeCells(m);}
  if(e.appendRows) {if(e.appendRows.length+s.rowCount>10001)throw new Error("追加后行数超限");for(const row of e.appendRows){if(row.length>100)throw new Error("追加行列数超限");s.addRow(row.map(value));}}
  if(e.sort) {
   const r=range(e.sort.range),key=e.sort.column;
   if(!Number.isInteger(key)||key<r.c1||key>r.c2)throw new Error("排序列须是区域内的绝对列号");
   const rows: {value:ExcelJS.CellValue;style:Partial<ExcelJS.Style>}[][]=[];
   for(let i=r.r1;i<=r.r2;i++) {const row=[];for(let c=r.c1;c<=r.c2;c++){const cell=s.getCell(i,c);if(cell.isMerged||cell.type===ExcelJS.ValueType.Formula)throw new Error("排序区域含公式或合并单元格，请先移出区域以免引用错位");row.push({value:cell.value,style:structuredClone(cell.style)});}rows.push(row);}
   rows.sort((a,b)=>{const av=a[key-r.c1]!.value,bv=b[key-r.c1]!.value;const n=typeof av==="number"&&typeof bv==="number"?av-bv:String(av??"").localeCompare(String(bv??""),"zh-CN",{numeric:true});return e.sort!.descending?-n:n;});
   rows.forEach((row,i)=>row.forEach((v,c)=>{const cell=s.getCell(r.r1+i,r.c1+c);cell.value=v.value;cell.style=v.style;}));
  }
 }
 if((input.addSheets?.length??0)+book.worksheets.length>20)throw new Error("工作表总数超过20");
 for(const s of input.addSheets??[])addSheet(book,s);
 book.calcProperties.fullCalcOnLoad=true;
 return publishFile(workspace,input.outputName,".xlsx",addWorkbookCharts(Buffer.from(await book.xlsx.writeBuffer()),book,book.worksheets.map(s=>input.addSheets?.find(a=>a.name===s.name)?.charts)));
}
export const TABLE_VALUE_SCHEMA={anyOf:[{type:["string","number","boolean","null"]},{type:"object",properties:{formula:{type:"string"},result:{type:["string","number","boolean"]}},required:["formula"]}]} as const;
export const STYLE_SCHEMA={type:"object",properties:{bold:{type:"boolean"},color:{type:"string"},fill:{type:"string"},numberFormat:{type:"string"},align:{type:"string",enum:["left","center","right"]},wrapText:{type:"boolean"}}} as const;
const stylesSchema={type:"array",items:{type:"object",properties:{range:{type:"string"},style:STYLE_SCHEMA},required:["range","style"]}} as const;
export const CHART_SCHEMA={type:"object",properties:{type:{type:"string",enum:["bar","line","pie"]},title:{type:"string"},categoryRange:{type:"string"},series:{type:"array",items:{type:"object",properties:{name:{type:"string"},range:{type:"string"}},required:["name","range"]}}},required:["type","categoryRange","series"]} as const;
export const SHEET_SCHEMA={type:"object",properties:{name:{type:"string"},columns:{type:"array",items:{type:"string"}},rows:{type:"array",items:{type:"array",items:TABLE_VALUE_SCHEMA}},widths:{type:"array",items:{type:"number"}},charts:{type:"array",items:CHART_SCHEMA},merges:{type:"array",items:{type:"string"}},styles:stylesSchema},required:["name","columns","rows"]} as const;
export function createSpreadsheetEditTool(workspace: string): PlatformTool {return {name:"edit_spreadsheet",label:"编辑电子表格",replay:"never",description:"编辑XLSX单元格/安全公式/样式/合并/追加/排序/新增工作表，另存新文件。不覆盖原件。排序区域不可含公式或合并单元格。拒绝无法保真保存的图表/宏/透视表工作簿。column为从1开始的绝对列号。",parameters:{type:"object",properties:{path:{type:"string"},outputName:{type:"string"},edits:{type:"array",items:{type:"object",properties:{sheet:{type:"string"},cells:{type:"array",items:{type:"object",properties:{address:{type:"string"},value:TABLE_VALUE_SCHEMA},required:["address","value"]}},styles:stylesSchema,merges:{type:"array",items:{type:"string"}},unmerges:{type:"array",items:{type:"string"}},appendRows:{type:"array",items:{type:"array",items:TABLE_VALUE_SCHEMA}},sort:{type:"object",properties:{range:{type:"string"},column:{type:"integer"},descending:{type:"boolean"}},required:["range","column"]}},required:["sheet"]}},addSheets:{type:"array",items:SHEET_SCHEMA}},required:["path","outputName","edits"]},async execute({args,signal,report}){signal.throwIfAborted();report("正在编辑并另存电子表格");const outputPath=await editSpreadsheet(workspace,args as Parameters<typeof editSpreadsheet>[1]);return{text:"已生成修订版，原文件未修改；公式在Excel/WPS打开时重算",details:{outputPath}};}};}
