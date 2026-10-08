import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, strFromU8, zipSync, unzipSync } from "fflate";
import { afterEach, expect, it } from "vitest";
import { reviseDocument } from "../src/edit-document.ts";

const dirs: string[] = [];
function setup(ext = ".docx") {
 const workspace = mkdtempSync(join(tmpdir(), "tao-revision-")); dirs.push(workspace);
 return { workspace, path: join(workspace, "原件" + ext), outputName: "修订" + ext, signal: new AbortController().signal };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("跨文字片段修订 DOCX，保留原件及无关部件", async () => {
 const input = setup();
 const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>原合同</w:t></w:r><w:r><w:t>金额100元，附件不变</w:t></w:r></w:p><w:p><w:r><w:t>其他段落</w:t></w:r></w:p></w:body></w:document>';
 const bytes = zipSync({ "word/document.xml": strToU8(xml), "word/styles.xml": strToU8("样式原文"), "word/media/image.png": new Uint8Array([1,2,3]) });
 writeFileSync(input.path, bytes);
 const path = await reviseDocument({ ...input, edits: [{ find: "合同金额100元", replace: "合同金额120元" }] });
 expect(readFileSync(input.path)).toEqual(Buffer.from(bytes));
 const result = unzipSync(readFileSync(path));
 expect(strFromU8(result["word/document.xml"]!)).toContain("原合同金额120元");
 expect(strFromU8(result["word/document.xml"]!)).toContain("，附件不变");
 expect(strFromU8(result["word/document.xml"]!)).toContain("其他段落");
 expect(result["word/styles.xml"]).toEqual(strToU8("样式原文"));
 expect(result["word/media/image.png"]).toEqual(new Uint8Array([1,2,3]));
});
it("替换不唯一、越界、覆盖原件及已取消操作均拒绝", async () => {
 const input = setup(".txt"); writeFileSync(input.path, "重复 重复");
 const edits = [{ find: "重复", replace: "新值" }];
 await expect(reviseDocument({ ...input, edits })).rejects.toThrow("不唯一");
 await expect(reviseDocument({ ...input, edits, outputName: "../越界.txt" })).rejects.toThrow("普通文件名");
 await expect(reviseDocument({ ...input, edits, outputName: "原件.txt" })).rejects.toThrow("覆盖");
 await expect(reviseDocument({ ...input, edits, signal: AbortSignal.abort() })).rejects.toThrow();
 expect(readFileSync(input.path,"utf8")).toBe("重复 重复");
});
it("拒绝包含外部实体的 DOCX", async () => {
 const input = setup(); writeFileSync(input.path, zipSync({ "word/document.xml": strToU8('<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///test">]><doc>&x;</doc>') }));
 await expect(reviseDocument({ ...input, edits: [{ find:"x", replace:"y" }] })).rejects.toThrow("外部实体");
});
it("直接修订函数仍拒绝工作区外输入，工具层由权限门独立授权", async () => {
 const input = setup(".txt"), external = setup(".txt");
 writeFileSync(external.path, "金额100元");
 await expect(reviseDocument({ ...input, path: external.path, edits: [{ find: "100元", replace: "120元" }] })).rejects.toThrow("工作区");
 expect(readFileSync(external.path, "utf8")).toBe("金额100元");
});
