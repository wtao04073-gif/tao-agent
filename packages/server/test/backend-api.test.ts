import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileJsonStore, FileJobStore } from "@tao/knowledge";
import { Role, type StoredAction, type TaskEvent } from "@tao/core";
import { createBackendHandler, type BackendTask } from "../src/backend-api.ts";
import { ResourceCatalog, createResourceHandler } from "../src/resources.ts";
import { ExecutionRegistry } from "../src/execution-registry.ts";
const tenant={tenantId:"t",workspaceId:"w",userId:"u"}, roots:string[]=[],servers:Server[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}for(const d of roots.splice(0))rmSync(d,{recursive:true,force:true});});
async function setup(){
 const root=mkdtempSync(join(tmpdir(),"tao-backend-api-"));roots.push(root);
 const actions=new FileJsonStore<StoredAction>({dir:root,collection:"actions",idOf:a=>a.actionId}), jobs=new FileJobStore({dir:join(root,"jobs")}),registry=new ExecutionRegistry(join(root,"execution"));
 const task:BackendTask={taskId:"task",status:"FAILED",conversationId:"conv",title:"合同修订",createdAt:1,updatedAt:2};
 const create=vi.fn(async()=>({taskId:"retry-task",conversationId:"conv"}));
 const handler=createBackendHandler({authenticate:async req=>req.headers.authorization?{tenant:req.headers.authorization==="Bearer other"?{...tenant,workspaceId:"other"}:tenant,role:Role.Member}:undefined,
  registry,actions,jobs,getTask:(t,id)=>t.workspaceId==="w"&&id==="task"?task:undefined,listTasks:t=>t.workspaceId==="w"?[task]:[],
  events:()=>[{type:"user_message",eventId:"m1",taskId:"task",text:"修订",at:1,references:[{fileId:"file",name:"合同.txt",sha256:"hash"}]} as TaskEvent],
  submit:(t,i)=>registry.submit(t,i,create),capabilities:t=>({mcp:{configured:t.workspaceId==="w"}}),
 });
 const catalog=new ResourceCatalog(root), resourceHandler=createResourceHandler({catalog,authenticate:async req=>req.headers.authorization?{tenant:req.headers.authorization==="Bearer other"?{...tenant,workspaceId:"other"}:tenant,role:Role.Member}:undefined,getTask:(t,id)=>t.workspaceId==="w"&&id==="task"?task:undefined,submit:(t,i)=>registry.submit(t,i,create)});
 const server=createServer((req,res)=>{void(async()=>{if(await resourceHandler(req,res))return;if(!await handler(req,res))res.writeHead(404).end();})();});servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const call=(path:string,method="GET",body?:unknown,token="test")=>fetch(url+path,{method,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {root,catalog,actions,jobs,registry,task,create,call,url};
}
it("重试返回关联的新任务且重复请求幂等，未授权与跨工作区拒绝",async()=>{
 const s=await setup();s.registry.snapshots.put({taskId:"task",tenant,input:{scenarioId:"general.free-task",fields:{query:"修订"},conversationId:"conv"},configurationHash:"config",sources:[],createdAt:1});
 const response=await s.call("/api/tasks/task/retry","POST",{});expect(response.status).toBe(202);expect(await response.json()).toMatchObject({taskId:"retry-task",retryOf:"task",mode:"new_task"});
 expect((await s.call("/api/tasks/task/retry","POST",{})).status).toBe(202);expect(s.create).toHaveBeenCalledOnce();
 expect((await s.call("/api/tasks/task/retry","POST",{},"other")).status).toBe(404);
 expect((await fetch(s.url+"/api/capabilities")).status).toBe(401);
 s.task.status="RUNNING";expect((await s.call("/api/tasks/task/retry","POST",{})).status).toBe(409);
});
it("动作参数不出接口，消息保留结构化引用与分页校验",async()=>{
 const s=await setup();s.actions.put({actionId:"a",taskId:"task",tenant,toolCallId:"call",toolName:"mcp_call",argsHash:"hash",arguments:{privateValue:"不可返回"},reason:"确认",createdAt:1,expiresAt:Date.now()+60000,status:"pending"});
 const actions=await (await s.call("/api/tasks/task/actions")).json();expect(actions.actions[0]).not.toHaveProperty("arguments");
 expect((await s.call("/api/tasks/task/actions","GET",undefined,"other")).status).toBe(404);
 const messages=await (await s.call("/api/conversations/conv/messages?limit=1")).json();expect(messages.messages[0].references[0].fileId).toBe("file");
 expect((await s.call("/api/conversations?limit=0")).status).toBe(400);
 expect((await (await s.call("/api/capabilities","GET",undefined,"other")).json()).mcp.configured).toBe(false);
});

it("产物版本实际下载，修订幂等且越权下载拒绝",async()=>{
 const s=await setup(),dir=join(s.root,"t","w");mkdirSync(dir,{recursive:true});const path=join(dir,"合同.txt");writeFileSync(path,"原版正文");
 const artifact=s.catalog.record(tenant,"task",path,[]),version=artifact.versions[0]!;
 const download=await s.call(`/api/artifacts/${artifact.artifactId}/versions/${version.versionId}`);expect(download.status).toBe(200);expect(await download.text()).toBe("原版正文");
 expect((await s.call(`/api/artifacts/${artifact.artifactId}/versions/${version.versionId}`,"GET",undefined,"other")).status).toBe(404);
 const submit=()=>fetch(s.url+`/api/artifacts/${artifact.artifactId}/revisions`,{method:"POST",headers:{Authorization:"Bearer test","Content-Type":"application/json","Idempotency-Key":"revision"},body:JSON.stringify({versionId:version.versionId,instruction:"修改指定段落"})});
 expect((await submit()).status).toBe(202);expect((await submit()).status).toBe(202);expect(s.create).toHaveBeenCalledOnce();
});
it("Job 可改名归档并保留已有记忆",async()=>{
 const s=await setup();s.jobs.put({jobId:"job",tenant,title:"原名",goal:"目标",status:"active",createdAt:1,updatedAt:1,conversationIds:["conv"],memory:[{conversationId:"conv",at:1,summary:"原记忆"}]});
 const response=await s.call("/api/jobs/job","PATCH",{title:"新名",status:"archived"});expect(response.status).toBe(200);expect(s.jobs.get("job")).toMatchObject({title:"新名",status:"archived",memory:[{summary:"原记忆"}]});
 expect((await s.call("/api/jobs/job","PATCH",{status:"active"},"other")).status).toBe(404);
});
