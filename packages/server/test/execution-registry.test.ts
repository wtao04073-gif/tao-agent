import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ExecutionRegistry, TaskQueue } from "../src/execution-registry.ts";
const tenant={tenantId:"t",workspaceId:"w",userId:"u"}, dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
it("并发重试同键只创建一次，持久化结果可恢复且租户隔离",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"tao-executions-"));dirs.push(dir);
 const registry=new ExecutionRegistry(dir), input={scenarioId:"test",fields:{query:"hello"},idempotencyKey:"same"};
 const create=vi.fn(async()=>({taskId:"task",conversationId:"conv"}));
 const results=await Promise.all(Array.from({length:8},()=>registry.submit(tenant,input,create)));
 expect(create).toHaveBeenCalledOnce();expect(results.every(r=>r.taskId==="task")).toBe(true);
 await new ExecutionRegistry(dir).submit(tenant,input,create);expect(create).toHaveBeenCalledOnce();
 await expect(registry.submit(tenant,{...input,fields:{query:"changed"}},create)).rejects.toMatchObject({status:409});
 await registry.submit({...tenant,workspaceId:"other"},input,create);expect(create).toHaveBeenCalledTimes(2);
});
it("结果不确定的提交重启后不自动重做",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"tao-executions-"));dirs.push(dir);
 const input={scenarioId:"test",fields:{},idempotencyKey:"failed"}, create=vi.fn(async()=>{throw new Error("结果不确定");});
 await expect(new ExecutionRegistry(dir).submit(tenant,input,create)).rejects.toThrow("不确定");
 await expect(new ExecutionRegistry(dir).submit(tenant,input,create)).rejects.toMatchObject({status:409});
 expect(create).toHaveBeenCalledOnce();
});
it("排队任务遵守并发上限，失败也释放席位",async()=>{
 const q=new TaskQueue(2);let active=0,peak=0;
 const outcomes=await Promise.allSettled(Array.from({length:8},(_,i)=>q.run(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;if(i===1)throw new Error("失败");return i;})));
 expect(peak).toBe(2);expect(q.pending).toBe(0);expect(outcomes.filter(x=>x.status==="fulfilled")).toHaveLength(7);
});
