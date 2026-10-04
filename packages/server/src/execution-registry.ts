import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FileJsonStore } from "@tao/knowledge";
import type { TenantContext } from "@tao/core";
import type { AppDeps } from "./app.ts";
import { WorkspaceError } from "./workspace-services.ts";
export type TaskInput = Parameters<AppDeps["submitTask"]>[1];
export interface ExecutionSnapshot {
    taskId: string;
    tenant: TenantContext;
    input: TaskInput;
    configurationHash: string;
    configuration?: Record<string, unknown>;
    sources: {
        path: string;
        sha256: string;
        fileId?: string;
        name?: string;
    }[];
    retryOf?: string;
    createdAt: number;
}
interface Receipt {
    id: string;
    tenant: TenantContext;
    fingerprint: string;
    state: "creating" | "submitted" | "failed";
    result?: {
        taskId: string;
        conversationId: string;
    };
}
export function digest(value: unknown): string {
    const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
    return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export class ExecutionRegistry {
    private readonly receiptsDirectory: string;
    readonly snapshots: FileJsonStore<ExecutionSnapshot>;
    private readonly receipts: FileJsonStore<Receipt>;
    private readonly inFlight = new Map<string, {
        fingerprint: string;
        promise: Promise<{
            taskId: string;
            conversationId: string;
        }>;
    }>();
    constructor(dir: string) {
        this.receiptsDirectory = join(dir, "receipts");
        this.snapshots = new FileJsonStore({ dir, collection: "requests", idOf: r => r.taskId });
        this.receipts = new FileJsonStore({ dir, collection: "receipts", idOf: r => r.id });
    }
    async submit(tenant: TenantContext, input: TaskInput, create: () => ReturnType<AppDeps["submitTask"]>) {
        const key = input.idempotencyKey;
        if (key === undefined)
            return create();
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
            throw new WorkspaceError(400, "幂等键须为1至128位字母、数字或 _ . : -");
        const id = digest([tenant.tenantId, tenant.workspaceId, tenant.userId, key]);
        const { idempotencyKey: _key, ...payload } = input;
        const fingerprint = digest(payload);
        const active = this.inFlight.get(id);
        if (active) {
            if (active.fingerprint !== fingerprint)
                throw new WorkspaceError(409, "相同幂等键不能用于不同请求");
            return active.promise;
        }
        const old = this.receipts.get(id);
        if (!old && existsSync(join(this.receiptsDirectory, id + ".json")))
            throw new WorkspaceError(409, "此前提交记录不可读，请核对任务，不能自动重放");
        if (old) {
            if (old.fingerprint !== fingerprint)
                throw new WorkspaceError(409, "相同幂等键不能用于不同请求");
            if (old.state === "submitted" && old.result)
                return old.result;
            throw new WorkspaceError(409, "此前提交未完成或结果不确定，请核对任务后使用新的幂等键");
        }
        const receipt: Receipt = { id, tenant, fingerprint, state: "creating" };
        this.receipts.put(receipt);
        const promise = Promise.resolve().then(create).then(result => {
            this.receipts.put({ ...receipt, state: "submitted", result });
            return result;
        }, error => {
            this.receipts.put({ ...receipt, state: "failed" });
            throw error;
        }).finally(() => { this.inFlight.delete(id); });
        this.inFlight.set(id, { fingerprint, promise });
        return promise;
    }
    owned(tenant: TenantContext, taskId: string): ExecutionSnapshot | undefined {
        const item = this.snapshots.get(taskId);
        return item?.tenant.tenantId === tenant.tenantId && item.tenant.workspaceId === tenant.workspaceId ? item : undefined;
    }
}
/** 有界执行并发；排队占位不消耗模型请求。 */
export class TaskQueue {
    private active = 0;
    private readonly queue: (() => void)[] = [];
    private readonly limit: number;
    constructor(limit: number) {
        if (!Number.isInteger(limit) || limit < 1)
            throw new Error("任务并发上限无效");
        this.limit = limit;
    }
    async run<T>(execute: () => Promise<T>): Promise<T> {
        await new Promise<void>(resolve => {
            const start = () => { this.active++; resolve(); };
            if (this.active < this.limit)
                start();
            else
                this.queue.push(start);
        });
        try {
            return await execute();
        }
        finally {
            this.active--;
            this.queue.shift()?.();
        }
    }
    get pending() { return this.queue.length; }
}
