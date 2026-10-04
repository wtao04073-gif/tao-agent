/** 按文件内容识别表格；只读取数据与公式缓存，不执行公式、宏或外部链接。 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import * as XLSX from "xlsx";
import { unzipSync } from "fflate";
import type { Row } from "@tao/core";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_CELLS = 1_000_000;
export interface SheetData {
 readonly name: string;
 readonly columns: readonly string[];
 readonly rows: readonly Row[];
 readonly rowNumbers: readonly number[];
 readonly headerRow: number;
 readonly format: string;
 readonly warnings: readonly string[];
}
export interface SheetOptions { readonly headerRow?: number }

function decodeText(bytes: Buffer): string {
 if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
 if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
 try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
 catch { return new TextDecoder("gb18030").decode(bytes); }
}
function checkXml(text: string): void {
 if (/<!ENTITY\b|<!DOCTYPE[^>]*(?:\[|SYSTEM|PUBLIC)/i.test(text)) throw new Error("表格含不允许的 DTD 或实体声明");
}
async function openWorkbook(path: string): Promise<{ book: XLSX.WorkBook; format: string }> {
 if ((await stat(path)).size > MAX_BYTES) throw new Error("表格超过 20MB 读取上限，请拆分后处理");
 const bytes = await readFile(path);
 if (bytes.length > MAX_BYTES) throw new Error("表格超过 20MB 读取上限");
 if (!bytes.length) throw new Error("表格文件为空，请重新上传原文件");
 let format: string;
 let input: Buffer | string = bytes;
 let type: "buffer" | "string" = "buffer";
 if (bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) format = "xls";
 else if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
  format = "xlsx";
  let expanded = 0;
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(bytes, { filter: entry => {
   expanded += entry.originalSize;
   if (expanded > 100 * 1024 * 1024) throw new Error("表格解压后超过 100MB 上限");
   return /\.xml$/i.test(entry.name);
  }}); } catch { throw new Error("XLSX 压缩包损坏或解压后超过100MB，请重新上传完整文件或拆分工作簿"); }
  if (!entries["xl/workbook.xml"]) throw new Error("文件是 ZIP 包，但不是 XLSX 工作簿；Word 文件请使用 read_document");
  for (const data of Object.values(entries)) checkXml(new TextDecoder().decode(data));
 } else {
  const text = decodeText(bytes).replace(/^\uFEFF/, "");
  checkXml(text);
  if (/<table\b/i.test(text)) format = "html-table";
  else if (/<(?:\w+:)?Workbook\b/i.test(text) && /urn:schemas-microsoft-com:office:spreadsheet/.test(text)) format = "spreadsheet-xml";
  else if ([".csv", ".tsv"].includes(extname(path).toLowerCase()) || (!text.includes("\0") && /[,\t;]/.test(text) && /\r?\n/.test(text))) format = "delimited-text";
  else throw new Error("无法识别表格内容：支持 XLS、XLSX、CSV、TSV、HTML 表格及 Excel XML；文件可能损坏、加密或并非表格");
  input = text; type = "string";
 }
 try {
  const book = XLSX.read(input, { type, cellDates: true, cellFormula: true, cellHTML: false, bookVBA: false, raw: format === "delimited-text", sheetRows: 100002 });
  if (book.SheetNames.length > 100) throw new Error("工作表超过100张上限，请拆分工作簿");
  if (!book.SheetNames.length) throw new Error("没有工作表");
  return { book, format };
 } catch (error) {
  if (/password|encrypt/i.test(String(error))) throw new Error("表格已加密，请提供解除密码保护的副本");
  throw new Error(`表格解析失败（识别格式 ${format}），请确认文件完整且未加密`);
 }
}

export async function listSheets(path: string): Promise<string[]> {
 return (await openWorkbook(path)).book.SheetNames;
}
export async function readSheet(path: string, sheet?: string, options: SheetOptions = {}): Promise<SheetData> {
 const { book, format } = await openWorkbook(path);
 const name = sheet ?? book.SheetNames[0]!;
 const ws = book.Sheets[name];
 if (!ws) throw new Error(`找不到工作表「${name}」。可用的表：${book.SheetNames.join("、")}`);
 if (!ws["!ref"]) throw new Error(`工作表「${name}」没有表头或数据`);
 const range = XLSX.utils.decode_range(ws["!fullref"] ?? ws["!ref"]!);
 const width = range.e.c + 1;
 if (range.e.r >= 100000 || width > 512 || (range.e.r + 1) * width > MAX_CELLS) throw new Error("表格范围超过读取上限（10万行、512列或100万单元格），请拆分后处理");
 const warnings: string[] = [];
 let missingFormula = false;
 const value = (r: number, c: number): unknown => {
  const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
  if (!cell) return null;
  if (cell.f && cell.v === undefined) { missingFormula = true; return null; }
  if (cell.t === "e") return null;
  return cell.v ?? null;
 };
 if (!Object.keys(ws).some(key => !key.startsWith("!") && (ws[key]?.v != null || ws[key]?.f))) throw new Error(`工作表「${name}」没有表头或数据`);
 let firstRow = range.s.r;
 while (firstRow <= range.e.r && Array.from({ length: width }, (_, c) => value(firstRow, c)).every(v => v === null || v === "")) firstRow++;
 const headerRow = options.headerRow ?? firstRow + 1;
 if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > range.e.r + 1) throw new Error("headerRow 必须是工作表内的有效行号（从1开始）");
 const columns: string[] = [];
 const seen = new Set<string>();
 for (let c = 0; c < width; c++) {
  const original = String(value(headerRow - 1, c) ?? "").trim();
  const base = original || `列${XLSX.utils.encode_col(c)}`;
  let key = base, suffix = 2;
  while (seen.has(key)) key = `${base}_${suffix++}`;
  seen.add(key); columns.push(key);
  if (!original || key !== original) warnings.push(`第${c + 1}列表头为空或重名，使用「${key}」`);
 }
 const rows: Row[] = [], rowNumbers: number[] = [];
 for (let r = headerRow; r <= range.e.r; r++) {
  const cells = columns.map((_, c) => value(r, c));
  if (cells.every(v => v === null || v === "")) continue;
  rows.push(Object.fromEntries(columns.map((key, c) => [key, cells[c]]))); rowNumbers.push(r + 1);
 }
 if (missingFormula) warnings.push("部分公式没有缓存结果，返回空值；本工具不计算公式，请用 Excel/WPS 重算并保存");
 if (ws["!merges"]?.length) warnings.push("含合并单元格，仅保留左上角原值；如首行是标题，请指定 headerRow 读取实际表头");
 return { name, columns, rows, rowNumbers, headerRow, format, warnings };
}
