import { readAuthorizedFile, readWorkspaceFile, publishFile, readBoundedZip } from "./file-safety.ts";
import { basename, extname, join, resolve } from "node:path";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { PlatformTool } from "@tao/core";
/** 精确文本替换保留未修改的 OOXML 部件；不重新生成整篇文档。 */
export async function reviseDocument(input: {
    path: string;
    outputName: string;
    workspace: string;
    edits: readonly {
        find: string;
        replace: string;
    }[];
    signal: AbortSignal;
}): Promise<string> {
    return reviseDocumentWithReader(input, path => readWorkspaceFile(input.workspace, path));
}
async function reviseDocumentWithReader(
    input: Parameters<typeof reviseDocument>[0],
    readInput: (path: string) => Promise<Buffer>,
): Promise<string> {
    const { outputName, signal } = input;
    if (basename(outputName) !== outputName || /[\\/\x00-\x1f]/.test(outputName) || outputName.startsWith("."))
        throw new Error("输出必须是普通文件名");
    const ext = extname(input.path).toLowerCase();
    if (![".docx", ".txt", ".md", ".csv"].includes(ext) || extname(outputName).toLowerCase() !== ext)
        throw new Error("仅支持同格式 DOCX、TXT、Markdown、CSV 修订");
    if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > 100 || input.edits.some(e => !e || typeof e.find !== "string" || !e.find || typeof e.replace !== "string" || e.replace.length > 100000))
        throw new Error("替换项无效");
    const output = join(input.workspace, outputName);
    if (resolve(output) === resolve(input.path))
        throw new Error("修订不得覆盖原文件");
    signal.throwIfAborted();
    // edit_document的path由PermissionGate校验；允许用户通过allowedFiles授权的父任务输入。
    // workspace约束输出位置，不能把它当成输入白名单而拒绝已经授权的文件。
    const source = await readInput(resolve(input.workspace, input.path));
    if (source.length > 20 * 1024 * 1024)
        throw new Error("文件超过20 MiB");
    let result: Uint8Array;
    if (ext === ".docx") {
        const files = readBoundedZip(source);
        const original = files["word/document.xml"];
        if (!original)
            throw new Error("缺少 DOCX 正文");
        const xml = strFromU8(original);
        if (/<!DOCTYPE|<!ENTITY/i.test(xml))
            throw new Error("不支持文档外部实体");
        const document = new DOMParser({ onError: () => { throw new Error("文档XML无效"); } }).parseFromString(xml, "application/xml");
        const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        for (const edit of input.edits) {
            signal.throwIfAborted();
            const paragraphs = Array.from(document.getElementsByTagNameNS(ns, "p"));
            const matches = paragraphs.flatMap(p => {
                const nodes = Array.from(p.getElementsByTagNameNS(ns, "t")), text = nodes.map(n => n.textContent ?? "").join("");
                const index = text.indexOf(edit.find);
                if (index < 0)
                    return [];
                if (text.indexOf(edit.find, index + 1) >= 0)
                    throw new Error("待替换文本出现多次，请提供更精确的原文");
                return [{ nodes, index }];
            });
            if (matches.length !== 1)
                throw new Error(matches.length ? "待替换文本出现多次，请提供更精确的原文" : "未找到待替换文本，未生成修订版");
            const { nodes, index } = matches[0]!;
            let offset = 0, inserted = false;
            for (const node of nodes) {
                const text = node.textContent ?? "", end = offset + text.length;
                if (end > index && offset < index + edit.find.length) {
                    node.textContent = text.slice(0, Math.max(0, index - offset)) + (inserted ? "" : edit.replace) + text.slice(Math.min(text.length, index + edit.find.length - offset));
                    node.setAttribute("xml:space", "preserve");
                    inserted = true;
                }
                offset = end;
            }
        }
        files["word/document.xml"] = strToU8(new XMLSerializer().serializeToString(document));
        result = zipSync(files, { level: 1 });
    }
    else {
        let text = source.toString("utf8");
        if (text.includes("\0"))
            throw new Error("文件不是文本");
        for (const edit of input.edits) {
            const index = text.indexOf(edit.find);
            if (index < 0 || text.indexOf(edit.find, index + 1) >= 0)
                throw new Error("待替换文本不存在或不唯一，请核对原文");
            text = text.slice(0, index) + edit.replace + text.slice(index + edit.find.length);
        }
        result = Buffer.from(text);
    }
    signal.throwIfAborted();
    if (result.length > 20 * 1024 * 1024)
        throw new Error("修订版超过20 MiB");
    return publishFile(input.workspace, outputName, ext, result);
}
export function createDocumentEditTool(workspace: string): PlatformTool {
    return {
        name: "edit_document", label: "修订文档", replay: "never",
        description: "按准确原文替换 DOCX/TXT/Markdown/CSV 中的指定内容，保留无关内容并另存新文件。find 必须唯一，不覆盖原件。",
        parameters: { type: "object", properties: { path: { type: "string" }, outputName: { type: "string" }, edits: { type: "array", minItems: 1, maxItems: 100, items: {
                        type: "object", properties: { find: { type: "string", minLength: 1 }, replace: { type: "string" } }, required: ["find", "replace"],
                    } } }, required: ["path", "outputName", "edits"] },
        async execute({ args, signal, report }) {
            const input = args as {
                path: string;
                outputName: string;
                edits: {
                    find: string;
                    replace: string;
                }[];
            };
            report("正在校验原文并生成修订版");
            const outputPath = await reviseDocumentWithReader({ ...input, workspace, signal }, readAuthorizedFile);
            return { text: "修订版已生成，原件保持不变", details: { outputPath, sourcePath: input.path, revisionSummary: `${input.edits.length}处精确替换` } };
        },
    };
}
