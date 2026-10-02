import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, statSync, lstatSync, chmodSync } from "node:fs";
import { basename, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { FileJsonStore } from "@tao/knowledge";
import { SourceKind, type SourceRef, type TenantContext } from "@tao/core";
import { digest } from "./execution-registry.ts";
import { checkedFile, workspaceDirectory, WorkspaceError } from "./workspace-services.ts";
import { readJsonBody, sendError, sendJson, type AppDeps, type Principal } from "./app.ts";
interface Version {
    versionId: string;
    name: string;
    path: string;
    sha256: string;
    sizeBytes: number;
    createdAt: number;
    taskId: string;
    inputs: SourceRef[];
    parentVersionId?: string;
    mimeType?: string;
    revisionSummary?: string;
}
interface Artifact {
    artifactId: string;
    tenant: TenantContext;
    versions: Version[];
}
interface InputFile {
    fileId: string;
    tenant: TenantContext;
    path: string;
    name: string;
    sha256: string;
    parentVersionId?: string;
}
export class ResourceCatalog {
    private readonly root: string;
    private readonly artifacts: FileJsonStore<Artifact>;
    private readonly sourceRecords: FileJsonStore<{
        id: string;
        tenant: TenantContext;
        sources: SourceRef[];
    }>;
    private readonly files: FileJsonStore<InputFile>;
    constructor(root: string) {
        this.root = root;
        this.sourceRecords = new FileJsonStore({ dir: join(root, ".resources"), collection: "sources", idOf: r => r.id });
        this.artifacts = new FileJsonStore({ dir: join(root, ".resources"), collection: "artifacts", idOf: a => a.artifactId });
        this.files = new FileJsonStore({ dir: join(root, ".resources"), collection: "files", idOf: f => f.fileId });
    }
    file(tenant: TenantContext, path: string): InputFile | undefined {
        const id = "file-" + digest([tenant.tenantId, tenant.workspaceId, path]);
        return this.files.get(id);
    }
    registerFile(tenant: TenantContext, path: string, source?: string, parentVersionId?: string): InputFile {
        checkedFile(workspaceDirectory(this.root, tenant), path);
        const prior = this.file(tenant, source ?? path);
        const file: InputFile = { fileId: "file-" + digest([tenant.tenantId, tenant.workspaceId, path]), tenant, path,
            name: prior?.name ?? basename(path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
            ...(parentVersionId ?? prior?.parentVersionId ? { parentVersionId: (parentVersionId ?? prior?.parentVersionId)! } : {}) };
        this.files.put(file);
        return file;
    }
    owned(tenant: TenantContext, id: string): Artifact | undefined {
        const item = this.artifacts.get(id);
        return item?.tenant.tenantId === tenant.tenantId && item.tenant.workspaceId === tenant.workspaceId ? item : undefined;
    }
    addSources(tenant: TenantContext, taskId: string, sources: SourceRef[]) {
        const id = digest([tenant.tenantId, tenant.workspaceId, taskId]);
        const old = this.sourceRecords.get(id)?.sources ?? [];
        this.sourceRecords.put({ id, tenant, sources: [...new Map([...old, ...sources].map(s => [s.id, s])).values()] });
    }
    record(tenant: TenantContext, taskId: string, path: string, sources: readonly string[], metadata: {
        mimeType?: string;
        revisionSummary?: string;
    } = {}): Artifact {
        checkedFile(workspaceDirectory(this.root, tenant), path);
        const artifactId = "art-" + digest([tenant.tenantId, tenant.workspaceId, taskId, basename(path)]);
        const old = this.owned(tenant, artifactId), sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
        if (old?.versions.at(-1)?.sha256 === sha256)
            return old;
        const versionId = randomUUID(), dir = join(workspaceDirectory(this.root, tenant), ".versions");
        if (existsSync(dir) && lstatSync(dir).isSymbolicLink())
            throw new WorkspaceError(409, "版本目录无效");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const target = join(dir, versionId);
        copyFileSync(path, target, constants.COPYFILE_EXCL);
        chmodSync(target, 0o600);
        const files = sources.map(source => this.file(tenant, source) ?? this.registerFile(tenant, source));
        const inputs: SourceRef[] = [...files.map(f => ({ kind: SourceKind.InputFile, id: f.fileId, name: f.name })), ...(this.sourceRecords.get(digest([tenant.tenantId, tenant.workspaceId, taskId]))?.sources ?? [])];
        const parents = [...new Set(files.flatMap(f => f.parentVersionId ? [f.parentVersionId] : []))];
        const version: Version = { versionId, name: basename(path), path: target, sha256, sizeBytes: statSync(target).size, createdAt: Date.now(), taskId, inputs, ...metadata,
            ...(parents.length === 1 ? { parentVersionId: parents[0]! } : {}) };
        const result = { artifactId, tenant, versions: [...(old?.versions ?? []), version] };
        this.artifacts.put(result);
        return result;
    }
    listForTask(tenant: TenantContext, taskId: string) {
        return this.artifacts.listByTenant(tenant.tenantId, tenant.workspaceId).filter(a => a.versions.some(v => v.taskId === taskId)).map(a => ({ artifactId: a.artifactId, versions: this.publicVersions(a) }));
    }
    readVersion(tenant: TenantContext, version: Version) {
        const bytes = readFileSync(checkedFile(workspaceDirectory(this.root, tenant), version.path));
        if (createHash("sha256").update(bytes).digest("hex") !== version.sha256)
            throw new WorkspaceError(409, "版本完整性校验失败");
        return bytes;
    }
    publicVersions(artifact: Artifact) { return artifact.versions.map(({ path: _path, ...v }) => v); }
    reference(tenant: TenantContext, id: string, versionId: string, key: string) {
        const version = this.owned(tenant, id)?.versions.find(v => v.versionId === versionId);
        if (!version)
            throw new WorkspaceError(404, "产物版本不存在");
        const root = workspaceDirectory(this.root, tenant), source = checkedFile(root, version.path);
        if (createHash("sha256").update(readFileSync(source)).digest("hex") !== version.sha256)
            throw new WorkspaceError(409, "原产物版本已变化");
        const name = digest([id, versionId, key]).slice(0, 24) + "-" + version.name, target = join(root, name);
        if (!existsSync(target))
            copyFileSync(source, target, constants.COPYFILE_EXCL);
        const file = this.registerFile(tenant, target, undefined, versionId);
        if (file.sha256 !== version.sha256)
            throw new WorkspaceError(409, "引用副本已变化");
        return { name, path: target, fileId: file.fileId };
    }
}
export function createResourceHandler(deps: {
    catalog: ResourceCatalog;
    authenticate: (req: IncomingMessage) => Promise<Principal | undefined>;
    submit: AppDeps["submitTask"];
    getTask: (tenant: TenantContext, id: string) => unknown;
}) {
    return async (req: IncomingMessage, res: ServerResponse) => {
        const parts = new URL(req.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean);
        const taskList = parts.length === 4 && parts[0] === "api" && parts[1] === "tasks" && parts[3] === "artifacts";
        if (!taskList && !(parts[0] === "api" && parts[1] === "artifacts"))
            return false;
        try {
            const principal = await deps.authenticate(req);
            if (!principal)
                throw new WorkspaceError(401, "请先登录");
            const tenant = principal.tenant, id = decodeURIComponent(parts[2] ?? "");
            res.setHeader("Cache-Control", "no-store");
            if (taskList && req.method === "GET") {
                if (!deps.getTask(tenant, id))
                    throw new WorkspaceError(404, "任务不存在");
                sendJson(res, 200, { artifacts: deps.catalog.listForTask(tenant, id) });
                return true;
            }
            const artifact = deps.catalog.owned(tenant, id);
            if (!artifact)
                throw new WorkspaceError(404, "产物不存在");
            if (req.method === "GET" && parts.length === 4 && parts[3] === "versions")
                sendJson(res, 200, { artifactId: id, versions: deps.catalog.publicVersions(artifact) });
            else if (req.method === "GET" && parts.length === 5 && parts[3] === "versions") {
                const version = artifact.versions.find(v => v.versionId === parts[4]);
                if (!version)
                    throw new WorkspaceError(404, "版本不存在");
                const bytes = deps.catalog.readVersion(tenant, version);
                if (createHash("sha256").update(bytes).digest("hex") !== version.sha256)
                    throw new WorkspaceError(409, "版本完整性校验失败");
                res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(version.name)}` });
                res.end(bytes);
            }
            else if (req.method === "POST" && parts.length === 4 && parts[3] === "revisions") {
                const body = await readJsonBody(req);
                if (!body.ok)
                    throw new WorkspaceError(400, body.reason);
                const value = body.value as {
                    versionId?: unknown;
                    instruction?: unknown;
                };
                if (typeof value.versionId !== "string" || typeof value.instruction !== "string" || !value.instruction.trim() || value.instruction.length > 20000)
                    throw new WorkspaceError(400, "请提供版本和修改要求");
                const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : randomUUID();
                const ref = deps.catalog.reference(tenant, id, value.versionId, key);
                const task = await deps.submit(tenant, { scenarioId: "general.free-task", fields: { query: value.instruction, attachments: [ref.path] }, idempotencyKey: key });
                sendJson(res, 202, { ...task, sourceArtifactId: id, sourceVersionId: value.versionId });
            }
            else
                throw new WorkspaceError(405, "不支持的产物操作");
        }
        catch (error) {
            sendError(res, error instanceof WorkspaceError ? error.status : 400, error instanceof WorkspaceError ? error.message : "产物处理失败");
        }
        return true;
    };
}
