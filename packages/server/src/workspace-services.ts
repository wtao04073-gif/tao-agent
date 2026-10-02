/** 工作区知识持久化与安全预览。归属只接受服务端鉴权上下文。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { checkAccess, ingestDocument, KeywordRetriever, Role, Scope, type Chunk, type PlatformTool, type SourceParagraph, type TenantContext } from "@tao/core";
import { createKnowledgeToolset, MemoryKnowledgeStore } from "@tao/knowledge";
import { readDocx, readSheet } from "@tao/office";
import { isSafeSegment, resolveWorkspaceDir } from "./accounts.ts";

export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
export const MAX_KNOWLEDGE_CHARS = 500_000;
const MAX_PREVIEW_CHARS = 100_000;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".html", ".htm", ".xml", ".svg", ".log", ".yaml", ".yml"]);
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
}
interface StoredDocument {
	readonly document: KnowledgeDocument;
	readonly tenant: TenantContext;
	readonly chunks: readonly Chunk[];
}
export type FilePreview =
	| { kind: "text"; name: string; text: string; truncated: boolean }
	| { kind: "sheet"; name: string; columns: readonly string[]; rows: readonly Record<string, unknown>[]; truncated: boolean }
	| { kind: "binary"; name: string; mime: string; bytes: Buffer };

export function isSafeFileName(name: string): boolean {
	return name.length > 0 && name.length <= 255 && name === basename(name) && !/[\\/\x00-\x1f\x7f]/.test(name) && !name.startsWith(".");
}
function within(path: string, root: string): boolean { return path.startsWith(root + sep); }

/** 全路径各级均拒绝符号链接，防止同租户其他工作区被链接进来。 */
export function workspaceDirectory(root: string, tenant: TenantContext): string {
	if (!isSafeSegment(tenant.tenantId) || !isSafeSegment(tenant.workspaceId)) throw new WorkspaceError(404, "工作区不存在");
	const base = resolve(root);
	const dir = resolveWorkspaceDir(base, tenant.tenantId, tenant.workspaceId);
	for (const part of [join(base, tenant.tenantId), dir]) {
		if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new WorkspaceError(404, "工作区不存在");
	}
	return dir;
}

export function checkedFile(root: string, filePath: string): string {
	try {
		const realRoot = realpathSync(root);
		const realFile = realpathSync(filePath);
		if (!within(realFile, realRoot) || !statSync(realFile).isFile()) throw new Error();
		if (statSync(realFile).size > MAX_PREVIEW_BYTES) throw new WorkspaceError(413, "文件超过 20 MB 预览上限");
		return realFile;
	} catch (error) {
		if (error instanceof WorkspaceError) throw error;
		throw new WorkspaceError(404, "文件不存在或无权访问");
	}
}
export function workspaceFile(root: string, tenant: TenantContext, name: string): string {
	if (!isSafeFileName(name)) throw new WorkspaceError(404, "文件不存在或无权访问");
	const dir = workspaceDirectory(root, tenant);
	const path = checkedFile(dir, join(dir, name));
	// 资料仅允许根下普通文件；不借符号链接读取隐藏知识数据或其他任务产物。
	if (dirname(path) !== realpathSync(dir) || lstatSync(join(dir, name)).isSymbolicLink()) throw new WorkspaceError(404, "文件不存在或无权访问");
	return path;
}

function paragraphs(text: string): SourceParagraph[] {
	return text.split(/\r?\n/).flatMap((line) => {
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		// 超长单行继续切分，避免绕过原有按段落分块的目标长度。
		const pieces: string[] = [];
		for (let i = 0; i < line.length; i += 1200) pieces.push(line.slice(i, i + 1200));
		return pieces.map((text) => ({ text: heading?.[2] ?? text, isHeading: heading !== null, headingLevel: heading?.[1]?.length ?? null }));
	}).map((line, index) => ({ ...line, index: index + 1 }));
}
async function extractText(path: string, name: string): Promise<string> {
	const ext = extname(name).toLowerCase();
	if (ext === ".docx") {
		const doc = await readDocx(path);
		return doc.paragraphs.map((p) => `${p.isHeading ? "#".repeat(p.headingLevel ?? 1) + " " : ""}${p.text}`).join("\n");
	}
	if (ext === ".xlsx") {
		const sheet = await readSheet(path);
		return [sheet.columns.join("\t"), ...sheet.rows.map((row) => sheet.columns.map((col) => String(row[col] ?? "")).join("\t"))].join("\n");
	}
	if (!TEXT_EXTENSIONS.has(ext)) throw new WorkspaceError(415, "知识入库支持文本、Markdown、CSV、DOCX 和 XLSX 文件");
	const text = readFileSync(path, "utf8");
	if (text.includes("\0")) throw new WorkspaceError(415, "文件不是可读取的文本");
	return text;
}
export async function previewFile(root: string, filePath: string, name: string): Promise<FilePreview> {
	const path = checkedFile(root, filePath);
	const ext = extname(name).toLowerCase();
	const mime = BINARY_TYPES[ext];
	if (mime !== undefined) return { kind: "binary", name, mime, bytes: readFileSync(path) };
	if (ext === ".xlsx") {
		const sheet = await readSheet(path);
		const columns = sheet.columns.slice(0, 50);
		return { kind: "sheet", name, columns, rows: sheet.rows.slice(0, 200).map((row) => Object.fromEntries(columns.map((col) => [col, String(row[col] ?? "").slice(0, 2000)]))), truncated: sheet.rows.length > 200 || sheet.columns.length > 50 };
	}
	const text = await extractText(path, name);
	return { kind: "text", name, text: text.slice(0, MAX_PREVIEW_CHARS), truncated: text.length > MAX_PREVIEW_CHARS };
}

export function createWorkspaceServices(options: { workspaceRoot: string }) {
	function storage(tenant: TenantContext): string {
		const dir = join(workspaceDirectory(options.workspaceRoot, tenant), ".knowledge");
		if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new WorkspaceError(404, "知识库不可用");
		return dir;
	}
	function load(tenant: TenantContext): StoredDocument[] {
		const dir = storage(tenant);
		if (!existsSync(dir)) return [];
		return readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).flatMap((name) => {
			const file = join(dir, name);
			if (lstatSync(file).isSymbolicLink()) return [];
			const data = JSON.parse(readFileSync(file, "utf8")) as StoredDocument;
			if (data.tenant?.tenantId !== tenant.tenantId || data.tenant?.workspaceId !== tenant.workspaceId || !Array.isArray(data.chunks)) return [];
			return [data];
		});
	}
	const listKnowledge = (tenant: TenantContext): KnowledgeDocument[] => load(tenant).map((d) => d.document).sort((a, b) => b.updatedAt - a.updatedAt);
	const searchKnowledge = async (tenant: TenantContext, query: string) => {
		if (typeof query !== "string" || query.length > 1000) throw new WorkspaceError(400, "检索关键词过长");
		return new KeywordRetriever(load(tenant).flatMap((d) => d.chunks)).search({ ...tenant, role: Role.Member }, { query, limit: 20 });
	};
	async function ingestKnowledge(tenant: TenantContext, input: { name?: string; fileName?: string; text?: string }): Promise<KnowledgeDocument> {
		const name = input.name?.trim() || input.fileName?.trim() || "";
		if (!isSafeFileName(name)) throw new WorkspaceError(400, "请填写有效的文档名称");
		let text = input.text;
		if (input.fileName !== undefined) text = await extractText(workspaceFile(options.workspaceRoot, tenant, input.fileName), input.fileName);
		if (typeof text !== "string" || text.trim() === "") throw new WorkspaceError(400, "文档内容不能为空");
		if (text.length > MAX_KNOWLEDGE_CHARS) throw new WorkspaceError(413, "文档超过 50 万字入库上限");
		const documentId = createHash("sha256").update(name).digest("hex");
		const previous = load(tenant).find((d) => d.document.documentId === documentId);
		if (previous !== undefined && previous.tenant.userId !== tenant.userId) throw new WorkspaceError(403, "只有创建者可更新同名知识文档");
		const chunks = ingestDocument(paragraphs(text), { tenantId: tenant.tenantId, workspaceId: tenant.workspaceId, ownerId: tenant.userId, scope: Scope.Workspace, knowledgeBaseId: "workspace", documentId, documentName: name });
		if (chunks.length === 0) throw new WorkspaceError(400, "文档没有可检索的正文");
		const now = Date.now();
		const document: KnowledgeDocument = { documentId, name, ...(input.fileName === undefined ? {} : { fileName: input.fileName }), chunks: chunks.length, createdAt: previous?.document.createdAt ?? now, updatedAt: now, status: "ready" };
		const dir = storage(tenant);
		mkdirSync(dir, { recursive: true });
		const target = join(dir, documentId + ".json");
		const temporary = join(dir, randomUUID() + ".tmp");
		try {
			writeFileSync(temporary, JSON.stringify({ document, tenant, chunks } satisfies StoredDocument), { mode: 0o600, flag: "wx" });
			renameSync(temporary, target);
		} finally { if (existsSync(temporary)) unlinkSync(temporary); }
		return document;
	}
	function deleteKnowledge(tenant: TenantContext, documentId: string, role: Role = Role.Member): boolean {
		if (!/^[a-f0-9]{64}$/.test(documentId)) return false;
		const document = load(tenant).find((d) => d.document.documentId === documentId);
		if (document === undefined) return false;
		if (!checkAccess({ ...tenant, role }, { ...tenant, ownerId: document.tenant.userId, scope: Scope.Workspace }, "delete").allowed) throw new WorkspaceError(403, "只有创建者或工作区管理员可删除");
		unlinkSync(join(storage(tenant), documentId + ".json"));
		return true;
	}
	function createKnowledgeTool(tenant: TenantContext): PlatformTool {
		const empty = new MemoryKnowledgeStore();
		const template = createKnowledgeToolset({ store: empty, membership: { ...tenant, role: Role.Member } })[0];
		if (template === undefined) throw new Error("知识检索工具未装配");
		return { ...template, async execute(call) {
			const store = new MemoryKnowledgeStore();
			await store.add(load(tenant).flatMap((d) => d.chunks));
			const tool = createKnowledgeToolset({ store, membership: { ...tenant, role: Role.Member } })[0];
			if (tool === undefined) throw new Error("知识检索工具未装配");
			return tool.execute(call);
		} };
	}
	return { listKnowledge, ingestKnowledge, searchKnowledge, deleteKnowledge, createKnowledgeTool };
}
export type WorkspaceServices = ReturnType<typeof createWorkspaceServices>;
