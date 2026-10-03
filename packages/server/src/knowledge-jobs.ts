import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { FileJsonStore } from "@tao/knowledge";
import type { TenantContext } from "@tao/core";
import { readJsonBody, sendError, sendJson, type Principal } from "./app.ts";
import { digest } from "./execution-registry.ts";
import { WorkspaceError, type WorkspaceServices, type KnowledgeDocument } from "./workspace-services.ts";
type Input = {
    documentId?:string;
    name?: string;
    fileName?: string;
    text?: string;
};
interface Job {
    jobId: string;
    tenant: TenantContext;
    input: Input;
    fingerprint: string;
    status: "queued" | "processing" | "ready" | "failed";
    createdAt: number;
    updatedAt: number;
    attempt: number;
    error?: string;
    document?: KnowledgeDocument;
}
export class KnowledgeJobs {
    private readonly store: FileJsonStore<Job>;
    private readonly services: WorkspaceServices;
    private readonly queue: Job[] = [];
    private running = false;
    constructor(dir: string, services: WorkspaceServices) { this.store = new FileJsonStore({ dir, collection: "knowledge-jobs", idOf: j => j.jobId }); this.services = services; }
    recover(tenant: TenantContext) { for (const job of this.store.listByTenant(tenant.tenantId, tenant.workspaceId))
        if (job.status === "queued" || job.status === "processing")
            this.store.put({ ...job, status: "failed", error: "服务重启，入库未完成，请重试", updatedAt: Date.now() }); }
    public(job: Job) { const { input: _input, tenant: _tenant, fingerprint: _fingerprint, ...data } = job; return {...data,operation:job.input.documentId?"reindex":"ingest"}; }
    owned(tenant: TenantContext, id: string) { const job = this.store.get(id); return job?.tenant.tenantId === tenant.tenantId && job.tenant.workspaceId === tenant.workspaceId ? job : undefined; }
    create(tenant: TenantContext, input: Input, key?: string) {
        if (this.queue.length >= 100)
            throw new WorkspaceError(503, "知识处理队列已满");
        if (key !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
            throw new WorkspaceError(400, "幂等键无效");
        const jobId = key ? digest([tenant.tenantId, tenant.workspaceId, tenant.userId, key]) : randomUUID(), fingerprint = digest(input);
        const old = this.owned(tenant, jobId);
        if (old) {
            if (old.fingerprint !== fingerprint)
                throw new WorkspaceError(409, "相同幂等键对应不同入库内容");
            return old;
        }
        const now = Date.now(), job: Job = { jobId, tenant, input, fingerprint, status: "queued", createdAt: now, updatedAt: now, attempt: 1 };
        this.store.put(job);
        this.queue.push(job);
        this.start();
        return job;
    }
    retry(tenant: TenantContext, id: string) {
        const old = this.owned(tenant, id);
        if (!old)
            throw new WorkspaceError(404, "入库作业不存在");
        if (old.tenant.userId !== tenant.userId)
            throw new WorkspaceError(403, "只有提交者可重试入库");
        if (old.status === "queued" || old.status === "processing")
            return old;
        if (old.status !== "failed")
            throw new WorkspaceError(409, "只有失败的入库作业可重试");
        if (this.queue.length >= 100)
            throw new WorkspaceError(503, "知识处理队列已满");
        const { error: _error, document: _document, ...base } = old;
        const job: Job = { ...base, status: "queued", attempt: old.attempt + 1, updatedAt: Date.now() };
        this.store.put(job);
        this.queue.push(job);
        this.start();
        return job;
    }
    private start() {
        if (this.running)
            return;
        this.running = true;
        void (async () => {
            while (this.queue.length) {
                const job = this.queue.shift()!;
                try {
                    this.store.put({ ...job, status: "processing", updatedAt: Date.now() });
                    const document = job.input.documentId ? await this.services.reindexKnowledge(job.tenant,job.input.documentId) : await this.services.ingestKnowledge(job.tenant, job.input);
                    this.store.put({ ...job, status: "ready", document, updatedAt: Date.now() });
                }
                catch (error) {
                    this.store.put({ ...job, status: "failed", error: error instanceof WorkspaceError ? error.message : "文档处理失败，请检查格式后重试", updatedAt: Date.now() });
                }
            }
        })().catch(() => { process.stderr.write("[知识] 作业状态持久化失败\n"); }).finally(() => { this.running = false; if (this.queue.length)
            this.start(); });
    }
}
export function createKnowledgeJobHandler(jobs: KnowledgeJobs, authenticate: (req: IncomingMessage) => Promise<Principal | undefined>) {
    return async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://localhost"), parts = url.pathname.split("/").filter(Boolean);
        const creation = url.pathname === "/api/knowledge" && url.searchParams.get("async") === "true";
        const reindex=parts.length===4 && parts[0]==="api" && parts[1]==="knowledge" && parts[3]==="reindex";
        if (!creation && !reindex && !(parts[0] === "api" && parts[1] === "knowledge" && parts[2] === "jobs"))
            return false;
        try {
            const principal = await authenticate(req);
            if (!principal)
                throw new WorkspaceError(401, "请先登录");
            const tenant = principal.tenant;
            if(reindex && req.method==="POST") {
                if(!/^[a-f0-9]{64}$/.test(parts[2]!))throw new WorkspaceError(400,"文档标识无效");
                const key=req.headers["idempotency-key"];
                sendJson(res,202,{job:jobs.public(jobs.create(tenant,{documentId:parts[2]!},typeof key==="string"?key:undefined))});
            }else if (creation && req.method === "POST") {
                const body = await readJsonBody(req);
                if (!body.ok)
                    throw new WorkspaceError(400, body.reason);
                const data = body.value as Record<string, unknown>;
                const input: Input = {};
                for (const key of ["name", "fileName", "text"] as const) {
                    if (data[key] !== undefined) {
                        if (typeof data[key] !== "string")
                            throw new WorkspaceError(400, "入库参数必须为文本");
                        input[key] = data[key] as string;
                    }
                }
                if ((input.fileName === undefined) === (input.text === undefined))
                    throw new WorkspaceError(400, "请选择文件或文本入库");
                const key = req.headers["idempotency-key"], job = jobs.create(tenant, input, typeof key === "string" ? key : undefined);
                sendJson(res, 202, { job: jobs.public(job) });
            }
            else if (parts.length === 4 && req.method === "GET") {
                const job = jobs.owned(tenant, parts[3]!);
                if (!job)
                    throw new WorkspaceError(404, "入库作业不存在");
                sendJson(res, 200, { job: jobs.public(job) });
            }
            else if (parts.length === 5 && parts[4] === "retry" && req.method === "POST")
                sendJson(res, 202, { job: jobs.public(jobs.retry(tenant, parts[3]!)) });
            else
                throw new WorkspaceError(405, "不支持的入库操作");
        }
        catch (error) {
            sendError(res, error instanceof WorkspaceError ? error.status : 400, error instanceof WorkspaceError ? error.message : "入库操作失败");
        }
        return true;
    };
}
