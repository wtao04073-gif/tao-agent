import { constants } from "node:fs";
import { open, realpath, link, unlink } from "node:fs/promises";
import { resolve, sep, join } from "node:path";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export async function readWorkspaceFile(workspace: string, path: string, max = MAX_FILE_BYTES): Promise<Buffer> {
 if (typeof path !== "string" || !path || path.includes("\0")) throw new Error("输入文件路径无效");
 const root = await realpath(workspace), target = await realpath(resolve(root, path));
 if (!target.startsWith(root + sep)) throw new Error("输入文件必须位于任务工作区内");
 return readAuthorizedFile(target, max);
}
/** 已经由PermissionGate授权的输入文件；输入授权由调用方负责，仍执行有界普通文件读取。 */
export async function readAuthorizedFile(path: string, max = MAX_FILE_BYTES): Promise<Buffer> {
 if (typeof path !== "string" || !path || path.includes("\0")) throw new Error("输入文件路径无效");
 const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const info = await handle.stat();
  if (!info.isFile() || info.nlink > 1 || info.size > max) throw new Error("只接受有界的普通文件（不接受硬链接），文件大小超限");
  // 固定缓冲区阻止检查后不断增长的文件突破上限。
  const data = Buffer.alloc(Math.min(info.size + 1, max + 1));
  let offset = 0;
  while (offset < data.length) { const r = await handle.read(data, offset, data.length - offset, null); if (!r.bytesRead) break; offset += r.bytesRead; }
  if (offset > max || offset > info.size) throw new Error("文件读取时发生变化或超过大小上限");
  return data.subarray(0, offset);
 } finally { await handle.close(); }
}
export async function publishFile(workspace: string, name: string, extension: string, bytes: Uint8Array): Promise<string> {
 if (typeof name !== "string" || !/^[^./\\\x00-\x1f][^/\\\x00-\x1f]{0,159}$/.test(name) || !name.toLowerCase().endsWith(extension)) throw new Error(`输出须为不含路径的 ${extension} 文件名`);
 if (bytes.length > MAX_FILE_BYTES) throw new Error("产物超过20 MiB上限，请拆分生成");
 const root = await realpath(workspace), target = join(root, name), temp = join(root, ".office-" + randomUUID());
 const h = await open(temp, "wx", 0o600);
 try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
 try { await link(temp, target); return target; }
 catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("同名文件已经存在，请使用新的文件名；原文件未修改"); throw e; }
 finally { await unlink(temp).catch(() => {}); }
}
export function readBoundedZip(bytes: Uint8Array): Record<string, Uint8Array> {
 let total = 0, count = 0;
 const files = unzipSync(bytes, { filter(entry) {
  count++; total += entry.originalSize;
  if (count > 3000 || total > 50 * 1024 * 1024 || entry.originalSize > MAX_FILE_BYTES || (entry.originalSize > 1024 * 1024 && entry.originalSize / Math.max(1, entry.size) > 200)) throw new Error("压缩包条目、解压大小或压缩比超过安全上限");
  if (entry.name.startsWith("/") || entry.name.includes("\\") || entry.name.split("/").includes("..")) throw new Error("压缩包包含不安全路径");
  return true;
 }});
 if (Object.values(files).reduce((n, b) => n + b.length, 0) > 50 * 1024 * 1024) throw new Error("压缩包解压大小超限");
 return files;
}
export function parseSafeXml(bytes: Uint8Array | string) {
 const xml = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
 if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("不允许 XML DTD 或实体声明");
 return new DOMParser({ onError: () => { throw new Error("XML结构损坏"); } }).parseFromString(xml, "application/xml");
}
export function boundedJson(value: unknown, max = 2_000_000): void { if (JSON.stringify(value).length > max) throw new Error("输入内容超过大小上限，请拆分处理"); }
