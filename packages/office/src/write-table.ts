import type { PlatformTool } from "@tao/core";
import { SHEET_SCHEMA, TABLE_VALUE_SCHEMA, writeWorkbook, type SheetSpec, type TableValue } from "./spreadsheet.ts";
export function createWriteTableTool(workspace:string):PlatformTool {return {
 name:"write_table",label:"生成Excel工作簿",replay:"never",
 description:"生成可编辑XLSX，支持多工作表、显式安全公式、列宽、合并、样式及原生图表。charts通过categoryRange和series[].range引用同列数据区域。兼容columns/rows单表参数，或传sheets数组。普通字符串永远不作公式执行；公式用{formula:'SUM(B2:B4)'}。不覆盖文件。公式由Excel/WPS打开时重算。",
 parameters:{type:"object",properties:{outputName:{type:"string"},sheetName:{type:"string"},columns:{type:"array",items:{type:"string"}},rows:{type:"array",items:{type:"array",items:TABLE_VALUE_SCHEMA}},sheets:{type:"array",items:SHEET_SCHEMA}},required:["outputName"]},
 async execute({args,report,signal}){const a=args as {outputName:string;sheetName?:string;columns:string[];rows:TableValue[][];sheets?:SheetSpec[]};signal?.throwIfAborted();report("正在生成多工作表Excel");const sheets=a.sheets??[{name:a.sheetName??"数据",columns:a.columns,rows:a.rows}];const outputPath=await writeWorkbook(workspace,{outputName:a.outputName,sheets});return{text:"Excel已生成；公式在Excel/WPS打开时重算",details:{outputPath,sheetCount:sheets.length,rowCount:sheets.reduce((n,s)=>n+s.rows.length,0),columnCount:sheets[0]?.columns.length}};}
};}
