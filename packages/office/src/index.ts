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

// ── 文档（M3）──
export {
	BlockType,
	describeDocModel,
	validateDocModel,
	type DocBlock,
	type DocModel,
	type DocValidationIssue,
	type HeadingBlock,
	type InlineRun,
	type ListBlock,
	type PageBreakBlock,
	type ParagraphBlock,
	type TableBlock,
} from "./doc-model.ts";
export { writeDocx, type WriteDocxResult } from "./docx-writer.ts";
export {
	readDocx,
	readDocxOutline,
	type DocParagraph,
	type ReadDocxOptions,
	type ReadDocxResult,
} from "./docx-reader.ts";
export { validateDocx, type DocxValidationResult } from "./validate-docx.ts";
export { createDocToolset, DOC_TOOL_POLICIES, type DocToolsetOptions } from "./doc-toolset.ts";

export { reviseDocument, createDocumentEditTool } from "./edit-document.ts";

export { createExtendedOfficeToolset, EXTENDED_OFFICE_TOOL_POLICIES } from "./extended-toolset.ts";
export { writeWorkbook, editSpreadsheet, type SheetSpec, type TableValue, type CellStyle, type SpreadsheetEdit } from "./spreadsheet.ts";
export { writePresentation, type PresentationSpec } from "./presentation.ts";
export { readExtendedFile, readRtfText, mergePdf, EXTENDED_READ_FORMATS, type ExtendedReadResult } from "./extended-readers.ts";
export { fillDocumentTemplate } from "./document-template.ts";

export type { SpreadsheetChart } from "./spreadsheet-charts.ts";
