/** 工作区对象管理。任务删除为归档隐藏，审计和历史产物保留。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { unlinkSync } from "node:fs";
import { FileJsonStore, type FileJobStore } from "@tao/knowledge";
import type { StoredSkill, StoredAgent, StoredTask, TenantContext } from "@tao/core";
import { sendJson, sendError, readJsonBody, type Principal } from "./app.ts";
import { WorkspaceError, workspaceFile } from "./workspace-services.ts";
interface Metadata { id:string; tenant:TenantContext; title?:string; deleted?:boolean }
const finished=(t:StoredTask)=>["SUCCEEDED","FAILED","CANCELLED","EXCEEDED","INTERRUPTED"].includes(t.status);
export class TaskPresentation {
 private readonly store:FileJsonStore<Metadata>;
 constructor(dir:string){this.store=new FileJsonStore({dir,collection:"task-presentation",idOf:m=>m.id});}
 view<T extends StoredTask>(task:T):T|undefined {const m=this.store.get(task.taskId);return m?.deleted?undefined:m?.title?{...task,title:m.title}:task;}
 list<T extends StoredTask>(tasks:readonly T[]):T[]{return tasks.map(t=>this.view(t)).filter((t):t is T=>!!t);}
 update(tasks:readonly StoredTask[],title?:string,deleted=false){for(const t of tasks)this.store.put({id:t.taskId,tenant:t.tenant,...(title?{title}:{}),deleted});}
}
export function createManagementHandler(d:{authenticate:(r:IncomingMessage)=>Promise<Principal|undefined>;root:string;presentation:TaskPresentation;listTasks:(t:TenantContext)=>readonly StoredTask[];skills:FileJsonStore<StoredSkill>;agents:FileJsonStore<StoredAgent>;jobs:FileJobStore;cancel:(id:string)=>Promise<unknown>}){
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const path=new URL(req.url??"/","http://localhost").pathname.split("/").filter(Boolean),method=req.method??"GET";
  if(path[0]!=="api"||path.length!==3||!["tasks","conversations","skills","agents","files","jobs"].includes(path[1]!)||!["PATCH","PUT","DELETE"].includes(method))return false;
  try{
   const p=await d.authenticate(req);if(!p)throw new WorkspaceError(401,"请先登录");
   const id=decodeURIComponent(path[2]!),kind=path[1],tenant=p.tenant,admin=["TENANT_ADMIN","PLATFORM_ADMIN"].includes(p.role);
   const owned=(t:TenantContext)=>{if(t.tenantId!==tenant.tenantId||t.workspaceId!==tenant.workspaceId)throw new WorkspaceError(404,"对象不存在");if(t.userId!==tenant.userId&&!admin)throw new WorkspaceError(403,"只有创建者或管理员可修改");};
   let input:Record<string,unknown>={};
   if(method!=="DELETE"){const b=await readJsonBody(req);if(!b.ok||!b.value||typeof b.value!=="object"||Array.isArray(b.value))throw new WorkspaceError(400,"修改参数无效");input=b.value as Record<string,unknown>;}
   const text=(key:string,max:number,required=false)=>{const v=input[key];if(v===undefined&&!required)return undefined;if(typeof v!=="string"||!v.trim()||v.length>max)throw new WorkspaceError(400,key+" 格式无效");return v.trim();};
   if(kind==="tasks"||kind==="conversations"){
    const tasks=d.listTasks(tenant).filter(t=>kind==="tasks"?t.taskId===id:(t.conversationId??t.taskId)===id);
    if(!tasks.length)throw new WorkspaceError(404,"任务或会话不存在");tasks.forEach(t=>owned(t.tenant));
    if(tasks.some(t=>!finished(t)))throw new WorkspaceError(409,"请先停止正在执行的任务");
    const title=method==="DELETE"?undefined:text("title",120,true);
    d.presentation.update(tasks,title,method==="DELETE");sendJson(res,200,{ok:true,deleted:method==="DELETE"});
   }else if(kind==="skills"||kind==="agents"){
    const item=kind==="skills"?d.skills.get(id):d.agents.get(id);
    if(!item)throw new WorkspaceError(404,"对象不存在或属于不可修改的预置内容");owned(item.tenant);
    if(item.builtin)throw new WorkspaceError(403,"预置内容不能修改或删除");
    if(method==="DELETE"){
     if(kind==="skills"&&d.agents.listByTenant(tenant.tenantId,tenant.workspaceId).some(a=>a.skillIds.includes(id)))throw new WorkspaceError(409,"该技能被智能体引用，请先解除引用");
     if(kind==="skills")d.skills.remove(id);else d.agents.remove(id);sendJson(res,200,{deleted:true});
    }else{
     const name=text("name",120),description=text("description",1000),content=text(kind==="skills"?"content":"systemPrompt",50000);
     const common={...item,...(name?{name}:{}),...(description?{description}:{}),updatedAt:Date.now()};
     if(kind==="skills"){const updated={...common,...(content?{content}: {})} as StoredSkill;d.skills.put(updated);sendJson(res,200,updated);}
     else{let skillIds=(item as StoredAgent).skillIds;if(input.skillIds!==undefined){if(!Array.isArray(input.skillIds)||input.skillIds.length>30||input.skillIds.some(v=>typeof v!=="string"))throw new WorkspaceError(400,"技能列表无效");skillIds=input.skillIds as string[];for(const sid of skillIds){if(!["skill-builtin-official-writing","skill-builtin-data-report"].includes(sid)){const skill=d.skills.get(sid);if(!skill||skill.tenant.tenantId!==tenant.tenantId||skill.tenant.workspaceId!==tenant.workspaceId)throw new WorkspaceError(400,"技能不存在");}}}
      const updated={...common,skillIds,...(content?{systemPrompt:content}:{})} as StoredAgent;d.agents.put(updated);sendJson(res,200,updated);}
    }
   }else if(kind==="files"){
    if(method!=="DELETE")throw new WorkspaceError(405,"文件仅支持删除");
    // 共享资料未保存可靠上传者字段，删除限管理员，不根据访问者猜测所有者。
    if(!admin)throw new WorkspaceError(403,"共享文件须由管理员删除");
    if(d.listTasks(tenant).some(t=>!finished(t)))throw new WorkspaceError(409,"工作区有任务正在执行，请完成后删除文件");
    const target=workspaceFile(d.root,tenant,id);unlinkSync(target);sendJson(res,200,{deleted:true});
   }else{
    const job=d.jobs.get(id);if(!job)throw new WorkspaceError(404,"长期任务不存在");owned(job.tenant);
    if(method==="DELETE"||input.status==="cancelled"){
     for(const task of d.listTasks(tenant).filter(t=>t.jobId===id&&!finished(t)))await d.cancel(task.taskId);
     d.jobs.put({...job,status:"archived",updatedAt:Date.now()});sendJson(res,200,{ok:true,status:"archived"});
    }else{const title=text("title",120);if(input.status!==undefined&&!["active","done","archived"].includes(String(input.status)))throw new WorkspaceError(400,"长期任务状态无效");d.jobs.put({...job,...(title?{title}:{}),...(input.status?{status:input.status as typeof job.status}:{}),updatedAt:Date.now()});sendJson(res,200,{ok:true});}
   }
  }catch(e){sendError(res,e instanceof WorkspaceError?e.status:400,e instanceof WorkspaceError?e.message:"操作失败，请检查输入");}
  return true;
 };
}
