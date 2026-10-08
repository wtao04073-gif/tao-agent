/** 上传与知识入库共用的格式边界；文件内容仍由对应解析器验证。 */
import { extname } from "node:path";
export const KNOWLEDGE_FORMATS = ["txt", "md", "csv", "tsv", "docx", "xls", "xlsx", "pdf", "pptx", "rtf"];
export const UPLOAD_FORMATS = [...KNOWLEDGE_FORMATS, "pdf", "html", "xml", "json", "png", "jpg", "jpeg", "webp", "pptx", "rtf", "zip", "py", "js", "ts", "sql", "sh", "mp3", "wav", "m4a", "ogg", "webm"];
export function supportsFile(name: string, formats = UPLOAD_FORMATS): boolean {
 return formats.includes(extname(name).slice(1).toLowerCase());
}
