/** 工作区知识持久化与安全预览。归属只接受服务端鉴权上下文。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, basename, extname, join, resolve, sep } from "node:path";
import { checkAccess, ingestDocument, KeywordRetriever, Role, Scope, type Chunk, type PlatformTool, type SourceParagraph, type TenantContext } from "@tao/core";
import { createKnowledgeToolset, MemoryKnowledgeStore, boundRagChunks, indexChunks, retrieveVectors, EmbeddingError, RagIndexError, type EmbeddingProvider, type VectorIndex } from "@tao/knowledge";
import {readExtendedFile, readDocx, readSheet, listSheets } from "@tao/office";
import { isSafeSegment, resolveWorkspaceDir } from "./accounts.ts";
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
export const MAX_KNOWLEDGE_CHARS = 500000;
const MAX_PREVIEW_CHARS = 100000;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".html", ".htm", ".xml", ".svg", ".log", ".yaml", ".yml", ".py", ".js", ".ts", ".sql", ".sh", ".css"]);
const BINARY_TYPES: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
export class WorkspaceError extends Error {
    readonly status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface KnowledgeDocument {
    readonly documentId: string;
    readonly name: string;
    readonly fileName?: string;
    readonly chunks: number;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly status: "ready";
    readonly version?: number;
    readonly sha256?: string;
    readonly vectorStatus?: "ready" | "needs_reindex" | "disabled";
}
interface StoredDocument {
    readonly document: KnowledgeDocument;
    readonly tenant: TenantContext;
    readonly chunks: readonly Chunk[];
    readonly sourceChunks?: readonly Chunk[];
    readonly index?: VectorIndex;
}
export type FilePreview = {kind:"slides";name:string;units:string[];truncated:boolean}| {
    kind: "text";
    name: string;
    text: string;
    truncated: boolean;
} | {
    kind: "sheet";
    name: string;
    columns: readonly string[];
    rows: readonly Record<string, unknown>[];
    truncated: boolean;
} | {
    kind: "binary";
    name: string;
    mime: string;
    bytes: Buffer;
};
export function isSafeFileName(name: string): boolean {
    return name.length > 0 && name.length <= 255 && name === basename(name) && !/[\\/\x00-\x1f\x7f]/.test(name) && !name.startsWith(".");
}
function within(path: string, root: string): boolean { return path.startsWith(root + sep); }
/** 全路径各级均拒绝符号链接，防止同租户其他工作区被链接进来。 */
export function workspaceDirectory(root: string, tenant: TenantContext): string {
    if (!isSafeSegment(tenant.tenantId) || !isSafeSegment(tenant.workspaceId))
        throw new WorkspaceError(404, "工作区不存在");
    const base = resolve(root);
    const dir = resolveWorkspaceDir(base, tenant.tenantId, tenant.workspaceId);
    for (const part of [join(base, tenant.tenantId), dir]) {
        if (existsSync(part) && lstatSync(part).isSymbolicLink())
            throw new WorkspaceError(404, "工作区不存在");
    }
    return dir;
}
export function checkedFile(root: string, filePath: string): string {
    try {
        const realRoot = realpathSync(root);
        const realFile = realpathSync(filePath);
        if (!within(realFile, realRoot) || !statSync(realFile).isFile())
            throw new Error();
        if (statSync(realFile).size > MAX_PREVIEW_BYTES)
            throw new WorkspaceError(413, "文件超过 20 MB 预览上限");
        return realFile;
    }
    catch (error) {
        if (error instanceof WorkspaceError)
            throw error;
        throw new WorkspaceError(404, "文件不存在或无权访问");
    }
}
export function workspaceFile(root: string, tenant: TenantContext, name: string): string {
    if (!isSafeFileName(name))
        throw new WorkspaceError(404, "文件不存在或无权访问");
    const dir = workspaceDirectory(root, tenant);
    const path = checkedFile(dir, join(dir, name));
    // 资料仅允许根下普通文件；不借符号链接读取隐藏知识数据或其他任务产物。
    if (dirname(path) !== realpathSync(dir) || lstatSync(join(dir, name)).isSymbolicLink())
        throw new WorkspaceError(404, "文件不存在或无权访问");
    return path;
}
function paragraphs(text: string): SourceParagraph[] {
    return text.split(/\r?\n/).flatMap((line) => {
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        // 超长单行继续切分，避免绕过原有按段落分块的目标长度。
        const pieces: string[] = [];
        for (let i = 0; i < line.length; i += 1200)
            pieces.push(line.slice(i, i + 1200));
        return pieces.map((text) => ({ text: heading?.[2] ?? text, isHeading: heading !== null, headingLevel: heading?.[1]?.length ?? null }));
    }).map((line, index) => ({ ...line, index: index + 1 }));
}
async function extractText(path: string, name: string, scan?:()=>Promise<string>): Promise<string> {
    const ext = extname(name).toLowerCase();
    if (ext === ".docx") {
        const doc = await readDocx(path);
        return doc.paragraphs.map((p) => `${p.isHeading ? "#".repeat(p.headingLevel ?? 1) + " " : ""}${p.text}`).join("\n");
    }
    if ([".xlsx", ".xls", ".csv", ".tsv"].includes(ext)) {
        const sections: string[] = [];
        for (const name of await listSheets(path)) {
            const sheet = await readSheet(path, name);
            sections.push(`# 工作表：${name}\n` + [sheet.columns.join("\t"), ...sheet.rows.map((row) => sheet.columns.map((col) => String(row[col] ?? "")).join("\t"))].join("\n"));
        }
        return sections.join("\n\n");
    }
    if(['.pdf','.pptx','.rtf'].includes(ext)){let offset=0,text='';for(let i=0;i<100;i++){const result=await readExtendedFile(dirname(path),{path,offset,limit:200});if(result.requiresOcr){if(scan)return scan();throw new WorkspaceError(415,'扫描PDF需要先用OCR生成文本后入库');}text+=result.text+'\n';if(text.length>2_000_000)throw new WorkspaceError(413,'解析文本过大');if(result.nextOffset==null)return text;offset=result.nextOffset;}throw new WorkspaceError(413,'文档分页过多');}
    if (!TEXT_EXTENSIONS.has(ext))
        throw new WorkspaceError(415, "知识入库支持文本、Markdown、CSV/TSV、DOCX、XLS 和 XLSX 文件");
    const text = readFileSync(path, "utf8");
    if (text.includes("\0"))
        throw new WorkspaceError(415, "文件不是可读取的文本");
    return text;
}
export async function previewFile(root: string, filePath: string, name: string): Promise<FilePreview> {
    const path = checkedFile(root, filePath);
    const ext = extname(name).toLowerCase();
    if(ext==='.pptx'){const result=await readExtendedFile(dirname(path),{path,limit:100});return {kind:'slides',name,units:result.units??[],truncated:result.nextOffset!=null};}
    const mime = BINARY_TYPES[ext];
    if (mime !== undefined)
        return { kind: "binary", name, mime, bytes: readFileSync(path) };
    if ([".xlsx", ".xls", ".csv", ".tsv"].includes(ext)) {
        const sheet = await readSheet(path);
        const columns = sheet.columns.slice(0, 50);
        return { kind: "sheet", name, columns, rows: sheet.rows.slice(0, 200).map((row) => Object.fromEntries(columns.map((col) => [col, String(row[col] ?? "").slice(0, 2000)]))), truncated: sheet.rows.length > 200 || sheet.columns.length > 50 };
    }
    const text = await extractText(path, name);
    return { kind: "text", name, text: text.slice(0, MAX_PREVIEW_CHARS), truncated: text.length > MAX_PREVIEW_CHARS };
}
export function createWorkspaceServices(options: {
    workspaceRoot: string;
    ocr?:(tenant:TenantContext,path:string)=>Promise<string>;
    embeddings?: EmbeddingProvider;
    retrievalMode?: "semantic" | "hybrid";
    minSimilarity?: number;
    chunkChars?: number;
    overlapChars?: number;
}) {
    if(options.embeddings){const provider=options.embeddings;options={...options,embeddings:{space:createHash('sha256').update(JSON.stringify([provider.space,options.chunkChars??800,options.overlapChars??100])).digest('hex'),embed:(...args)=>provider.embed(...args)}};}
    const epochs = new Map<string, number>();
    const keyOf = (tenant: TenantContext, id: string) => JSON.stringify([tenant.tenantId, tenant.workspaceId, id]);
    function storage(tenant: TenantContext): string {
        const dir = join(workspaceDirectory(options.workspaceRoot, tenant), ".knowledge");
        if (existsSync(dir) && lstatSync(dir).isSymbolicLink())
            throw new WorkspaceError(404, "知识库不可用");
        return dir;
    }
    function load(tenant: TenantContext): StoredDocument[] {
        const dir = storage(tenant);
        if (!existsSync(dir))
            return [];
        return readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).flatMap((name) => {
            const file = join(dir, name);
            if (lstatSync(file).isSymbolicLink())
                return [];
            const data = JSON.parse(readFileSync(file, "utf8")) as StoredDocument;
            if (data.tenant?.tenantId !== tenant.tenantId || data.tenant?.workspaceId !== tenant.workspaceId || !Array.isArray(data.chunks))
                return [];
            return [data];
        });
    }
    const listKnowledge = (tenant: TenantContext): KnowledgeDocument[] => load(tenant).map((d) => ({ ...d.document, vectorStatus: options.embeddings ? (d.index?.space === options.embeddings.space ? "ready" as const : "needs_reindex" as const) : "disabled" as const })).sort((a, b) => b.updatedAt - a.updatedAt);
    const searchKnowledge = async (tenant: TenantContext, query: string, search: {
        limit?: number;
        mode?: "semantic" | "hybrid";
        knowledgeBaseIds?: readonly string[];
        signal?: AbortSignal;
    } = {}) => {
        if (typeof query !== "string" || query.length > 1000)
            throw new WorkspaceError(400, "检索问题须不超过1000个字符");
        const documents = load(tenant), membership = { ...tenant, role: Role.Member };
        if (!options.embeddings) {
            if (search.mode)
                throw new WorkspaceError(503, "尚未配置嵌入服务，语义检索不可用");
            return new KeywordRetriever(documents.flatMap(d => d.chunks)).search(membership, { query, limit: search.limit ?? 20, ...(search.knowledgeBaseIds ? { knowledgeBaseIds: search.knowledgeBaseIds } : {}) });
        }
        try {
            const hits = await retrieveVectors({ provider: options.embeddings, documents, membership, query, limit: search.limit ?? 20, mode: search.mode ?? options.retrievalMode ?? "hybrid", minScore: options.minSimilarity ?? 0.35, ...(search.knowledgeBaseIds ? { knowledgeBaseIds: search.knowledgeBaseIds } : {}), ...(search.signal ? { signal: search.signal } : {}) });
            // 嵌入请求期间文档可能被更新或删除；禁止返回已失效的旧内容。
            const current = new Map(load(tenant).map(d => [d.document.documentId, d]));
            return hits.filter(h => current.get(h.chunk.documentId)?.chunks.some(c => c.id === h.chunk.id && c.text === h.chunk.text && checkAccess(membership, c, "read").allowed));
        }
        catch (error) {
            if (error instanceof EmbeddingError || error instanceof RagIndexError)
                throw new WorkspaceError(503, error.message);
            throw error;
        }
    };
    async function buildIndex(chunks: readonly Chunk[]) {
        try {
            return await indexChunks(options.embeddings!, chunks);
        }
        catch (error) {
            if (error instanceof EmbeddingError || error instanceof RagIndexError)
                throw new WorkspaceError(503, error.message);
            throw error;
        }
    }
    function persist(tenant: TenantContext, document: StoredDocument) {
        const dir = storage(tenant);
        mkdirSync(dir, { recursive: true });
        const temporary = join(dir, randomUUID() + ".tmp"), target = join(dir, document.document.documentId + ".json");
        const bytes = JSON.stringify(document);
        if (Buffer.byteLength(bytes) > MAX_PREVIEW_BYTES)
            throw new WorkspaceError(413, "文档向量索引超过20 MiB，请拆分文档");
        try {
            writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
            renameSync(temporary, target);
        }
        finally {
            if (existsSync(temporary))
                unlinkSync(temporary);
        }
        const key = keyOf(tenant, document.document.documentId);
        epochs.set(key, (epochs.get(key) ?? 0) + 1);
    }
    async function reindexKnowledge(tenant: TenantContext, documentId: string, role: Role = Role.Member) {
        if (!options.embeddings)
            throw new WorkspaceError(503, "请先配置嵌入服务");
        const previous = load(tenant).find(d => d.document.documentId === documentId);
        if (!previous)
            throw new WorkspaceError(404, "知识文档不存在");
        if (previous.tenant.userId !== tenant.userId && ![Role.PlatformAdmin,Role.TenantAdmin,Role.WorkspaceAdmin].includes(role as any))
            throw new WorkspaceError(403, "只有创建者或管理员可重建索引");
        const key = keyOf(tenant, documentId), epoch = epochs.get(key) ?? 0;
        const chunks=boundRagChunks(previous.sourceChunks??previous.chunks,options.chunkChars??800,options.overlapChars??100);
        const index = await buildIndex(chunks);
        if ((epochs.get(key) ?? 0) !== epoch)
            throw new WorkspaceError(409, "文档已变化，请重新重建索引");
        persist(tenant, { ...previous, chunks, document:{...previous.document,chunks:chunks.length}, index });
        return { ...previous.document, chunks:chunks.length, vectorStatus: "ready" as const };
    }
    async function ingestKnowledge(tenant: TenantContext, input: {
        name?: string;
        fileName?: string;
        text?: string;
    }): Promise<KnowledgeDocument> {
        const name = input.name?.trim() || input.fileName?.trim() || "";
        if (!isSafeFileName(name))
            throw new WorkspaceError(400, "请填写有效的文档名称");
        let text = input.text;
        if (input.fileName !== undefined)
            text = await extractText(workspaceFile(options.workspaceRoot, tenant, input.fileName), input.fileName,options.ocr?()=>options.ocr!(tenant,workspaceFile(options.workspaceRoot,tenant,input.fileName!)):undefined);
        if (typeof text !== "string" || text.trim() === "")
            throw new WorkspaceError(400, "文档内容不能为空");
        if (text.length > MAX_KNOWLEDGE_CHARS)
            throw new WorkspaceError(413, "文档超过 50 万字入库上限");
        const documentId = createHash("sha256").update(name).digest("hex");
        const previous = load(tenant).find((d) => d.document.documentId === documentId);
        if (previous !== undefined && previous.tenant.userId !== tenant.userId)
            throw new WorkspaceError(403, "只有创建者可更新同名知识文档");
        const version = (previous?.document.version ?? 0) + 1;
        const key = keyOf(tenant, documentId), epoch = epochs.get(key) ?? 0;
        let chunks: Chunk[] = ingestDocument(paragraphs(text), { tenantId: tenant.tenantId, workspaceId: tenant.workspaceId, ownerId: tenant.userId, scope: Scope.Workspace, knowledgeBaseId: "workspace", documentId, documentName: name }).map(chunk => ({ ...chunk, id: `${chunk.id}:v${version}`, documentVersion: version }));
        const sourceChunks=chunks;
        if (options.embeddings)
            chunks = boundRagChunks(chunks, options.chunkChars ?? 800, options.overlapChars ?? 100);
        if (chunks.length === 0)
            throw new WorkspaceError(400, "文档没有可检索的正文");
        const index = options.embeddings ? await buildIndex(chunks) : undefined;
        if ((epochs.get(key) ?? 0) !== epoch)
            throw new WorkspaceError(409, "同名文档已被修改，请重新入库");
        const now = Date.now();
        const document: KnowledgeDocument = { documentId, name, ...(input.fileName === undefined ? {} : { fileName: input.fileName }), chunks: chunks.length, createdAt: previous?.document.createdAt ?? now, updatedAt: now, status: "ready", version, sha256: createHash("sha256").update(text).digest("hex") };
        const dir = storage(tenant);
        mkdirSync(dir, { recursive: true });
        if (previous) {
            const history = join(dir, "history", documentId);
            mkdirSync(history, { recursive: true });
            const saved = join(history, String(previous.document.version ?? 0) + ".json");
            if (!existsSync(saved))
                writeFileSync(saved, JSON.stringify(previous), { mode: 0o600, flag: "wx" });
        }
        persist(tenant, { document, tenant, chunks, sourceChunks, ...(index ? { index } : {}) });
        return document;
    }
    function deleteKnowledge(tenant: TenantContext, documentId: string, role: Role = Role.Member): boolean {
        if (!/^[a-f0-9]{64}$/.test(documentId))
            return false;
        const document = load(tenant).find((d) => d.document.documentId === documentId);
        if (document === undefined)
            return false;
        if (!checkAccess({ ...tenant, role }, { ...tenant, ownerId: document.tenant.userId, scope: Scope.Workspace }, "delete").allowed)
            throw new WorkspaceError(403, "只有创建者或工作区管理员可删除");
        unlinkSync(join(storage(tenant), documentId + ".json"));
        const key = keyOf(tenant, documentId);
        epochs.set(key, (epochs.get(key) ?? 0) + 1);
        return true;
    }
    function knowledgeVersion(tenant: TenantContext, documentId: string, version: number) {
        if (!/^[a-f0-9]{64}$/.test(documentId) || !Number.isSafeInteger(version) || version < 1)
            throw new WorkspaceError(400, "文档版本参数无效");
        const current = load(tenant).find(d => d.document.documentId === documentId);
        if (!current)
            throw new WorkspaceError(404, "引用文档已删除或无权访问");
        let stored = current;
        if (current.document.version !== version) {
            const path = checkedFile(storage(tenant), join(storage(tenant), "history", documentId, String(version) + ".json"));
            try {
                stored = JSON.parse(readFileSync(path, "utf8")) as StoredDocument;
            }
            catch {
                throw new WorkspaceError(404, "引用版本不可用");
            }
        }
        if (stored.tenant.tenantId !== tenant.tenantId || stored.tenant.workspaceId !== tenant.workspaceId || stored.document.version !== version)
            throw new WorkspaceError(404, "引用版本不可用");
        return { document: stored.document, chunks: stored.chunks };
    }
    function createKnowledgeTool(tenant: TenantContext): PlatformTool {
        const store = new MemoryKnowledgeStore();
        const tool = createKnowledgeToolset({ store: { add: chunks => store.add(chunks), removeDocument: (t, id) => store.removeDocument(t, id), stats: m => store.stats(m), search: (_membership, query) => searchKnowledge(tenant, query.query, query) }, membership: { ...tenant, role: Role.Member } })[0]!;
        return { ...tool, description: options.embeddings ? "在本单位知识库中按自然语言问题进行语义与关键词混合检索，返回文档版本和来源。" : tool.description };
    }
    function ragStatus(tenant: TenantContext) {
        const documents = listKnowledge(tenant);
        return { enabled: !!options.embeddings, configured: !!options.embeddings, mode: options.embeddings ? options.retrievalMode ?? "hybrid" : "keyword", index: "local_exact", documents: documents.length, indexedDocuments: documents.filter(d => d.vectorStatus === "ready").length, pendingDocuments: documents.filter(d => d.vectorStatus === "needs_reindex").length, ready: !!options.embeddings && documents.every(d => d.vectorStatus === "ready") };
    }
    return { ragStatus, reindexKnowledge, knowledgeVersion, listKnowledge, ingestKnowledge, searchKnowledge, deleteKnowledge, createKnowledgeTool };
}
export type WorkspaceServices = ReturnType<typeof createWorkspaceServices>;
