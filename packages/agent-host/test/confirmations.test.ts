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

it('本机会话授权先持久化再放行，不能授权高危或普通工具',async()=>{
 const stored:any[]=[];const order:string[]=[];const c=new Confirmations('task-local',{tenantId:'t',workspaceId:'w',userId:'u'},a=>{stored.push(a);order.push(a.status);});
 const meta={command:'ls',cwd:'/work',roots:['/work'],network:false,confined:true,capabilities:['read'],highRisk:false,sessionAllowed:true,maxTtlMinutes:30,policyHash:'p'};
 const p=await c.request('call','local_shell',{command:'ls'},'确认',meta);
 await c.approve(p.action.actionId,{scope:'session',ttlMinutes:5},async()=>{order.push('grant');});expect(await p.decision).toBe(true);expect(order).toEqual(['pending','approved','grant']);expect(stored.at(-1).grant.scope).toBe('session');
 const q=await c.request('q','local_shell',{command:'curl'},'高危',{...meta,highRisk:true});await expect(c.approve(q.action.actionId,{scope:'session'},async()=>{})).rejects.toThrow('不支持');await c.cancel();expect(await q.decision).toBe(false);
});
it('授权持久化失败不产生会话放权',async()=>{let grants=0;const c=new Confirmations('task-local',{tenantId:'t',workspaceId:'w',userId:'u'},a=>{if(a.status==='approved')throw Error('save failed');});const p=await c.request('c','local_shell',{command:'ls'},'确认',{command:'ls',cwd:'/work',roots:['/work'],network:false,confined:true,capabilities:['read'],highRisk:false,sessionAllowed:true,maxTtlMinutes:30,policyHash:'p'});await expect(c.approve(p.action.actionId,{scope:'session'},async()=>{grants++;})).rejects.toThrow();expect(grants).toBe(0);expect(await p.decision).toBe(false);});
