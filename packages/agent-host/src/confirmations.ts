import { createHash, randomUUID } from "node:crypto";
import type { PendingAction, StoredAction, TenantContext } from "@tao/core";
export class Confirmations {
    private cancelled = false;
    private readonly records = new Map<string, StoredAction>();
    private readonly waiting = new Map<string, {
        settle: (ok: boolean) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private readonly taskId: string;
    private readonly tenant: TenantContext;
    private readonly save: (action: StoredAction) => void | Promise<void>;
    private readonly now: () => number;
    private readonly timeoutMs: number;
    constructor(taskId: string, tenant: TenantContext, save: (action: StoredAction) => void | Promise<void>, now = Date.now, timeoutMs = 300000) {
        this.taskId = taskId;
        this.tenant = tenant;
        this.save = save;
        this.now = now;
        this.timeoutMs = timeoutMs;
    }
    list(): PendingAction[] {
        return [...this.records.values()].map(({ arguments: _args, ...item }) => ({ ...item }));
    }
    async request(toolCallId: string, toolName: string, args: unknown, reason: string) {
        const action: StoredAction = {
            actionId: randomUUID(), taskId: this.taskId, tenant: this.tenant, toolCallId, toolName,
            arguments: structuredClone(args), argsHash: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
            reason, createdAt: this.now(), expiresAt: this.now() + this.timeoutMs, status: "pending",
        };
        await this.save(action);
        this.records.set(action.actionId, action);
        if (this.cancelled) {
            await this.finish(action.actionId, "rejected");
            return { action, decision: Promise.resolve(false) };
        }
        const decision = new Promise<boolean>((settle) => {
            const timer = setTimeout(() => {
                if (this.records.get(action.actionId)?.status !== "pending")
                    return;
                void this.finish(action.actionId, "expired").catch(() => {
                    this.waiting.delete(action.actionId);
                    settle(false);
                });
            }, this.timeoutMs);
            timer.unref();
            this.waiting.set(action.actionId, { settle, timer });
        });
        return { action, decision };
    }
    async approve(actionId?: string): Promise<void> {
        const candidates = this.list().filter((a) => a.status === "pending");
        const id = actionId ?? (candidates.length === 1 ? candidates[0]?.actionId : this.records.size === 1 ? this.list()[0]?.actionId : undefined);
        const action = id === undefined ? undefined : this.records.get(id);
        if (!action)
            throw new Error("请指定唯一的待确认 actionId");
        if (action.status === "approved" || action.status === "executed")
            return;
        if (action.status !== "pending" || action.expiresAt <= this.now())
            throw new Error("动作已过期或不再等待确认");
        await this.finish(action.actionId, "approved");
    }
    async finish(id: string, status: StoredAction["status"]): Promise<void> {
        const action = this.records.get(id);
        if (!action)
            return;
        // 先更新内存状态，重复请求不会在异步持久化期间重复消费授权。
        const updated = { ...action, status };
        this.records.set(id, updated);
        try {
            await this.save(updated);
        }
        catch (error) {
            this.records.set(id, { ...updated, status: "failed" });
            const wait = this.waiting.get(id);
            if (wait) {
                clearTimeout(wait.timer);
                this.waiting.delete(id);
                wait.settle(false);
            }
            throw error;
        }
        if (this.records.get(id) !== updated)
            return;
        const wait = this.waiting.get(id);
        if (wait) {
            clearTimeout(wait.timer);
            this.waiting.delete(id);
            wait.settle(status === "approved");
        }
    }
    async completed(toolCallId: string, failed: boolean): Promise<void> {
        for (const action of this.records.values()) {
            if (action.toolCallId === toolCallId && action.status === "approved")
                await this.finish(action.actionId, failed ? "failed" : "executed");
        }
    }
    async cancel(): Promise<void> {
        this.cancelled = true;
        await Promise.all([...this.waiting.keys()].map((id) => this.finish(id, "rejected")));
    }
}
