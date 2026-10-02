import type { IncomingMessage, ServerResponse } from "node:http";
import type { PendingAction, StoredAction, StoredJob, TaskEvent, TenantContext } from "@tao/core";
import type { FileJobStore, FileJsonStore } from "@tao/knowledge";
import type { AppDeps, Principal } from "./app.ts";
import { readJsonBody, sendError, sendJson } from "./app.ts";
import type { ExecutionRegistry } from "./execution-registry.ts";
import { WorkspaceError } from "./workspace-services.ts";
export interface BackendTask {
    taskId: string;
    status: string;
    conversationId?: string;
    title?: string;
    jobId?: string;
    createdAt: number;
    updatedAt: number;
}
export interface BackendDeps {
    authenticate: (req: IncomingMessage) => Promise<Principal | undefined>;
    getTask: (tenant: TenantContext, id: string) => BackendTask | undefined;
    listTasks: (tenant: TenantContext) => readonly BackendTask[];
    events: (tenant: TenantContext, id: string) => readonly TaskEvent[];
    registry: ExecutionRegistry;
    actions: FileJsonStore<StoredAction>;
    jobs: FileJobStore;
    submit: AppDeps["submitTask"];
    capabilities?: (tenant: TenantContext) => Record<string, unknown>;
}
function page(params: URLSearchParams) {
    const limit = Number(params.get("limit") ?? 50), offset = Number(params.get("cursor") ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
        throw new WorkspaceError(400, "分页参数无效");
    return { limit, offset };
}
export function createBackendHandler(deps: BackendDeps) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        const url = new URL(req.url ?? "/", "http://localhost"), parts = url.pathname.split("/").filter(Boolean);
        const match = parts[0] === "api" && (parts[1] === "capabilities" || parts[1] === "conversations" ||
            (parts[1] === "tasks" && parts.length === 4 && ["actions", "retry"].includes(parts[3]!)) || (parts[1] === "jobs" && req.method === "PATCH"));
        if (!match)
            return false;
        res.setHeader("Cache-Control", "no-store");
        try {
            const principal = await deps.authenticate(req);
            if (!principal)
                throw new WorkspaceError(401, "请先登录");
            const tenant = principal.tenant;
            if (req.method === "GET" && parts[1] === "capabilities" && parts.length === 2) {
                sendJson(res, 200, { version: 1, confirmation: true, retry: "new_task", idempotency: true,
                    conversations: true, knowledge: { retrieval: "keyword", asyncIngestion: true, versioned: true, formats: ["txt", "md", "csv", "docx", "xlsx"], ocr: false },
                    control: { usage: true, audit: true, organizationManagement: false },
                    execution: { mode: "single_process", distributed: false, sandbox: false }, ...deps.capabilities?.(tenant) });
            }
            else if (parts[1] === "tasks") {
                const id = decodeURIComponent(parts[2]!);
                const task = deps.getTask(tenant, id);
                if (!task)
                    throw new WorkspaceError(404, "任务不存在");
                if (req.method === "GET" && parts[3] === "actions") {
                    const actions: PendingAction[] = deps.actions.listByTenant(tenant.tenantId, tenant.workspaceId).filter(a => a.taskId === id)
                        .map(({ arguments: _args, ...a }) => a);
                    sendJson(res, 200, { actions });
                }
                else if (req.method === "POST" && parts[3] === "retry") {
                    if (!["FAILED", "CANCELLED", "INTERRUPTED", "EXCEEDED"].includes(task.status))
                        throw new WorkspaceError(409, "只有失败、取消或中断任务可以重试");
                    const body = await readJsonBody(req);
                    if (!body.ok)
                        throw new WorkspaceError(400, body.reason);
                    const snapshot = deps.registry.owned(tenant, id);
                    if (!snapshot)
                        throw new WorkspaceError(409, "旧任务没有可恢复执行规格，请重新发起任务");
                    const key = req.headers["idempotency-key"];
                    const result = await deps.submit(tenant, { ...snapshot.input, retryOf: id, idempotencyKey: typeof key === "string" ? key : "retry:" + id });
                    sendJson(res, 202, { ...result, retryOf: id, mode: "new_task" });
                }
                else
                    throw new WorkspaceError(405, "不支持的任务操作");
            }
            else if (parts[1] === "jobs" && parts.length === 3 && req.method === "PATCH") {
                const body = await readJsonBody(req);
                if (!body.ok)
                    throw new WorkspaceError(400, body.reason);
                const job = deps.jobs.get(decodeURIComponent(parts[2]!));
                if (!job || job.tenant.tenantId !== tenant.tenantId || job.tenant.workspaceId !== tenant.workspaceId)
                    throw new WorkspaceError(404, "长期任务不存在");
                if (job.tenant.userId !== tenant.userId && !["TENANT_ADMIN", "PLATFORM_ADMIN"].includes(principal.role))
                    throw new WorkspaceError(403, "只有创建者或租户管理员可修改长期任务");
                const input = body.value as Record<string, unknown>;
                if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.length > 120))
                    throw new WorkspaceError(400, "标题须为1至120个字符");
                if (input.status !== undefined && !["active", "done", "archived"].includes(String(input.status)))
                    throw new WorkspaceError(400, "长期任务状态无效");
                const updated: StoredJob = { ...job, ...(typeof input.title === "string" ? { title: input.title.trim() } : {}),
                    ...(input.status === undefined ? {} : { status: input.status as StoredJob["status"] }), updatedAt: Date.now() };
                deps.jobs.put(updated);
                sendJson(res, 200, updated);
            }
            else if (parts[1] === "conversations" && req.method === "GET") {
                const { limit, offset } = page(url.searchParams), q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
                const tasks = [...deps.listTasks(tenant)].sort((a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
                if (parts.length === 2) {
                    const groups = new Map<string, {
                        conversationId: string;
                        title: string;
                        taskIds: string[];
                        updatedAt: number;
                        jobId?: string;
                    }>();
                    for (const t of tasks) {
                        const id = t.conversationId ?? t.taskId;
                        const row = groups.get(id) ?? { conversationId: id, title: t.title ?? "对话", taskIds: [], updatedAt: t.updatedAt, ...(t.jobId ? { jobId: t.jobId } : {}) };
                        row.taskIds.push(t.taskId);
                        row.updatedAt = Math.max(row.updatedAt, t.updatedAt);
                        groups.set(id, row);
                    }
                    const rows = [...groups.values()].filter(r => !q || r.title.toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt || a.conversationId.localeCompare(b.conversationId));
                    sendJson(res, 200, { conversations: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : null });
                }
                else if (parts.length === 4 && parts[3] === "messages") {
                    const id = decodeURIComponent(parts[2]!);
                    const selected = tasks.filter(t => (t.conversationId ?? t.taskId) === id);
                    if (!selected.length)
                        throw new WorkspaceError(404, "会话不存在");
                    const messages = selected.flatMap(t => deps.events(tenant, t.taskId).filter(e => e.type === "user_message" || e.type === "assistant_message").map(e => ({
                        messageId: e.eventId, taskId: e.taskId, role: e.type === "user_message" ? "user" : "assistant", text: "text" in e ? e.text : "", at: e.at,
                        ...(e.type === "user_message" ? { references: e.references ?? deps.registry.owned(tenant, t.taskId)?.sources.map(f => ({ fileId: f.fileId, name: f.name ?? f.path.split("/").pop(), sha256: f.sha256 })) ?? [] } : {}),
                    })));
                    sendJson(res, 200, { messages: messages.slice(offset, offset + limit), nextCursor: offset + limit < messages.length ? String(offset + limit) : null });
                }
                else
                    throw new WorkspaceError(404, "接口不存在");
            }
            else
                throw new WorkspaceError(405, "不支持的操作");
        }
        catch (error) {
            sendError(res, error instanceof WorkspaceError ? error.status : 500, error instanceof WorkspaceError ? error.message : "操作失败");
        }
        return true;
    };
}
