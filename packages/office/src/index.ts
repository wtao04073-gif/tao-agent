/**
 * @tao/office —— Office 产物生成与校验
 *
 * 走原生文件生成路线（非 HTML 转换），产物真可编辑、可盖章流转。
 * 不接触 vendor/pi —— 工具经 @tao/core 的 PlatformTool 接口暴露。
 */

export { readSheet, listSheets, type SheetData } from "./xlsx-reader.ts";
export { writeReconcileReport, type ReportOptions } from "./xlsx-report.ts";
export { validateXlsx, type ValidationResult, type ValidationIssue } from "./validate.ts";
export { createOfficeToolset, OFFICE_TOOL_POLICIES, type ToolsetOptions } from "./toolset.ts";
