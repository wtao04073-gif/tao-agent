import { expect, it, vi } from "vitest";
import { Confirmations } from "../src/confirmations.ts";
const tenant = { tenantId:"t", workspaceId:"w", userId:"u" };
it("授权绑定参数副本且只能消费一次", async () => {
 const save = vi.fn(), c = new Confirmations("task", tenant, save);
 const args = { amount: 10 }, pending = await c.request("call", "write", args, "确认金额"); args.amount=20;
 expect(save.mock.calls[0]![0].arguments.amount).toBe(10);
 expect(c.list()[0]).not.toHaveProperty("arguments");
 await c.approve(pending.action.actionId); expect(await pending.decision).toBe(true);
 await c.completed("call",false); await c.approve(pending.action.actionId);
 expect(save.mock.calls.map(c=>c[0].status)).toEqual(["pending","approved","executed"]);
});
it("多个待处理动作不能通过空确认授权", async () => {
 const c = new Confirmations("task",tenant,()=>{}), a = await c.request("a","write",{},"确认"), b = await c.request("b","write",{},"确认");
 await expect(c.approve()).rejects.toThrow("唯一");
 await c.cancel(); expect(await a.decision).toBe(false); expect(await b.decision).toBe(false);
 await expect(c.approve(a.action.actionId)).rejects.toThrow("过期");
});
it("超时和授权落盘失败均不执行", async () => {
 const c = new Confirmations("task",tenant,()=>{},Date.now,10), a = await c.request("a","write",{},"确认");
 await vi.waitFor(()=>expect(c.list()[0]?.status).toBe("expired")); expect(await a.decision).toBe(false);
 const broken = new Confirmations("task",tenant,a=>{if(a.status==="approved")throw new Error("存储失败");});
 const b = await broken.request("b","write",{},"确认");
 await expect(broken.approve()).rejects.toThrow("存储失败"); expect(await b.decision).toBe(false);
});
it("异步授权落盘期间取消，不会恢复工具执行", async () => {
 const hold = Promise.withResolvers<void>();
 const c = new Confirmations("task",tenant,a=>a.status==="approved"?hold.promise:undefined);
 const a=await c.request("a","write",{},"确认"), approval=c.approve();
 await c.cancel(); hold.resolve(); await approval;
 expect(await a.decision).toBe(false); expect(c.list()[0]?.status).toBe("rejected");
});
