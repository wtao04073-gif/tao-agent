import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { open, link, unlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { PlatformTool } from "@tao/core";
import { validateXlsx } from "./validate.ts";
export function createWriteTableTool(workspace: string): PlatformTool {
 return {
  name:"write_table", label:"生成 Excel 表格", replay:"never",
  description:"生成可下载的 XLSX 工作簿。传入列名与数据行，保留数字/布尔值；不执行公式，不覆盖已有文件。每次最多10000行、100列。",
  parameters:{type:"object",properties:{outputName:{type:"string"},sheetName:{type:"string"},columns:{type:"array",items:{type:"string"},minItems:1,maxItems:100},rows:{type:"array",maxItems:10000,items:{type:"array",items:{type:["string","number","boolean","null"]}}}},required:["outputName","columns","rows"]},
  async execute({args,report}) {
   const a=args as {outputName:string;sheetName?:string;columns:string[];rows:unknown[][]};
   if(!a || typeof a.outputName!=="string" || !/^[^/\\\x00-\x1f]{1,160}\.xlsx$/i.test(a.outputName))throw new Error("请提供不含路径的 .xlsx 文件名");
   if(!Array.isArray(a.columns)||!a.columns.length||a.columns.length>100||a.columns.some(c=>typeof c!=="string"||!c.trim()||c.length>200))throw new Error("列名无效，最多100列");
   if(!Array.isArray(a.rows)||a.rows.length>10000||a.rows.some(row=>!Array.isArray(row)||row.length!==a.columns.length||row.some(v=>v!==null&&typeof v!=="boolean"&&!(typeof v==="number"&&Number.isFinite(v))&&!(typeof v==="string"&&v.length<=32767))))throw new Error("每行须与列数一致，单元格仅支持文本、有限数字、布尔值和空值");
   if(JSON.stringify(a).length>2_000_000)throw new Error("表格内容超过2MB，请拆分生成");
   const sheetName=a.sheetName??"数据";
   if(typeof sheetName!=="string"||!sheetName.trim()||sheetName.length>31||/[\\/\[\]:*?\x00-\x1f]/.test(sheetName))throw new Error("工作表名无效");
   const root=await realpath(workspace),target=join(root,a.outputName),temporary=join(root,"."+randomUUID()+".xlsx");
   const book=new ExcelJS.Workbook(),sheet=book.addWorksheet(sheetName);
   sheet.addRow(a.columns);sheet.getRow(1).font={bold:true};sheet.views=[{state:"frozen",ySplit:1}];
   a.rows.forEach(row=>sheet.addRow(row));sheet.columns.forEach(col=>{col.width=22;});
   report("正在生成并校验 Excel 文件");
   try {
    const handle=await open(temporary,"wx",0o600);
    try{await handle.writeFile(Buffer.from(await book.xlsx.writeBuffer()));await handle.sync();}finally{await handle.close();}
    const check=await validateXlsx(temporary,{expectSheets:[sheetName]});if(!check.ok)throw new Error("Excel 文件校验失败");
    // link 为原子不覆盖发布；已有文件/符号链接一律失败。
    await link(temporary,target);
    return {text:"Excel 已生成："+a.outputName,details:{outputPath:target,rowCount:a.rows.length,columnCount:a.columns.length}};
   }catch(e){if((e as NodeJS.ErrnoException).code==="EEXIST")throw new Error("同名文件已经存在，请使用新的文件名");throw e;}
   finally{await unlink(temporary).catch(()=>{});}
  }
 };
}
