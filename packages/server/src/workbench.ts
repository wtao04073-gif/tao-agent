/** 工作台持久化元数据；所有资源读取仍经过原有任务可见性与文件边界。 */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, lstatSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { zipSync, strToU8 } from 'fflate';
import type { TenantContext, StoredTask, TaskEvent } from '@tao/core';
import { FileJsonStore } from '@tao/knowledge';
import { contentDisposition, readJsonBody, sendJson, sendError, type Principal } from './app.ts';
import { workspaceDirectory, checkedFile, isSafeFileName, WorkspaceError } from './workspace-services.ts';
import type { ResourceCatalog } from './resources.ts';
import { paginate } from './pagination.ts';

type RecordData = { id:string; tenant:TenantContext; kind:string; [key:string]:unknown };
export interface WorkbenchTeam { id:string; tenant:TenantContext; kind:'team'; name:string; members:{userId:string;role:'owner'|'editor'|'viewer'}[]; taskIds:string[] }
export interface WorkbenchPreferences { nickname:string; styleInstructions:string }
const key = (t:TenantContext, ...parts:string[]) => createHash('sha256').update(JSON.stringify([t.tenantId,t.workspaceId,...parts])).digest('hex');
const admin = (p:Principal) => ['TENANT_ADMIN','PLATFORM_ADMIN'].includes(p.role);
const same = (a:TenantContext,b:TenantContext) => a.tenantId===b.tenantId && a.workspaceId===b.workspaceId;
const clean = (s:string) => s
 .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|$)/g,'<REDACTED>')
 .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi,'<REDACTED>')
 .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,'<REDACTED>')
 .replace(/((?:["']?(?:api[_ -]?key|access[_ -]?token|token|password|secret|cookie|authorization)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,'$1<REDACTED>');
export interface WorkbenchInput { fileId:string; name:string; path:string; sha256:string }
interface SharedFile { artifactId:string; versionId:string; name:string; sha256:string; sizeBytes:number }
const MAX_TRANSFER_BYTES=64*1024*1024;
const hashBytes=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const archiveName=(name:string)=>clean(name).replace(/[\\/<>:"|?*\x00-\x1f\x7f]/g,'_').slice(0,180)||'file';
function downloadBytes(res:ServerResponse,bytes:Uint8Array,name:string,mime='application/octet-stream'){
 res.writeHead(200,{'Content-Type':mime,'Content-Length':bytes.byteLength,'Content-Disposition':contentDisposition(archiveName(name)),'X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Referrer-Policy':'no-referrer'});res.end(bytes);
}
function selectArtifactFiles(d:WorkbenchDeps,tenant:TenantContext,taskId:string,selection:unknown):SharedFile[]{
 if(!Array.isArray(selection)||selection.length>50)throw new WorkspaceError(400,'请选择至多 50 个产物版本');
 const selected:SharedFile[]=[],seen=new Set<string>();let total=0;
 for(const item of selection){
  if(!item||typeof item!=='object'||typeof item.artifactId!=='string'||typeof item.versionId!=='string')throw new WorkspaceError(400,'产物选择参数无效');
  const artifact=d.catalog.owned(tenant,item.artifactId),version=artifact?.versions.find(v=>v.versionId===item.versionId&&v.taskId===taskId);
  if(!version)throw new WorkspaceError(404,'产物版本不属于当前已授权任务');
  if(item.sha256!==undefined&&item.sha256!==version.sha256)throw new WorkspaceError(409,'产物版本已变化，请刷新列表');
  const key=item.artifactId+':'+item.versionId;if(seen.has(key))continue;seen.add(key);
  const bytes=d.catalog.readVersion(tenant,version);if(hashBytes(bytes)!==version.sha256)throw new WorkspaceError(409,'产物完整性校验失败');
  total+=bytes.length;if(total>MAX_TRANSFER_BYTES)throw new WorkspaceError(413,'所选文件合计超过 64 MB');
  selected.push({artifactId:artifact!.artifactId,versionId:version.versionId,name:archiveName(version.name),sha256:version.sha256,sizeBytes:bytes.length});
 }
 return selected;
}
function readSharedFile(d:WorkbenchDeps,tenant:TenantContext,file:SharedFile):Uint8Array{
 const version=d.catalog.owned(tenant,file.artifactId)?.versions.find(v=>v.versionId===file.versionId);
 if(!version||version.sha256!==file.sha256)throw new WorkspaceError(409,'分享版本已变化或不再可用');
 const bytes=d.catalog.readVersion(tenant,version);if(hashBytes(bytes)!==file.sha256||bytes.length!==file.sizeBytes)throw new WorkspaceError(409,'分享文件完整性校验失败');return bytes;
}

export class WorkbenchStore {
 readonly records:FileJsonStore<RecordData>;
 constructor(root:string){this.records=new FileJsonStore({dir:join(root,'.workbench'),collection:'records',idOf:r=>r.id});}
 preferences(t:TenantContext):WorkbenchPreferences {const r=this.records.get(key(t,'preferences',t.userId));return {nickname:String(r?.nickname??''),styleInstructions:String(r?.styleInstructions??'')};}
 list(t:TenantContext,kind:string){return this.records.listByTenant(t.tenantId,t.workspaceId).filter(r=>r.kind===kind);}
 team(t:TenantContext,id:string):WorkbenchTeam|undefined {const r=this.records.get(id);return r?.kind==='team'&&same(t,r.tenant)?r as unknown as WorkbenchTeam:undefined;}
 teamRole(t:TenantContext,id:string):'owner'|'editor'|'viewer'|undefined {const r=this.team(t,id);if(!r)return undefined;if(r.tenant.userId===t.userId)return 'owner';return r.members.find(m=>m.userId===t.userId)?.role;}
 canTeam(p:Principal,id:string,action:'read'|'edit'|'manage'='read'):boolean {if(!this.team(p.tenant,id))return false;if(admin(p))return true;const role=this.teamRole(p.tenant,id);return action==='manage'?role==='owner':action==='edit'?role==='owner'||role==='editor':role!==undefined;}
 visibleTeams(p:Principal):WorkbenchTeam[]{return this.list(p.tenant,'team').filter(r=>this.canTeam(p,r.id)).map(r=>r as unknown as WorkbenchTeam);}

}
export interface WorkbenchDeps {
 root:string;
 authenticate:(req:IncomingMessage)=>Promise<Principal|undefined>;
 /** 必须由宿主注入统一的 Origin/CSRF 写入检查；返回 false 时宿主已响应。 */
 authorizeWrite:(req:IncomingMessage,res:ServerResponse)=>boolean|Promise<boolean>;
 listTasks:(tenant:TenantContext)=>readonly StoredTask[];
 catalog:ResourceCatalog;
 store?:WorkbenchStore;
 /** 仅提供当前租户/工作区可加入的账号，不可注入全局账号列表。 */
 members?:(tenant:TenantContext)=>readonly {userId:string;name:string}[];
 /** 只返回该用户可读任务的事件。导出会再投影字段并脱敏，不导出原始工具参数。 */
 events?:(tenant:TenantContext,taskId:string)=>readonly TaskEvent[]|Promise<readonly TaskEvent[]>;
 /** 必须来自已授权执行规格的输入快照白名单，不接受客户端提供路径。 */
 inputs?:(tenant:TenantContext,taskId:string)=>readonly WorkbenchInput[]|Promise<readonly WorkbenchInput[]>;
}
export function createWorkbenchHandler(d:WorkbenchDeps){
 const store=d.store??new WorkbenchStore(d.root);
 return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
  const url=new URL(req.url??'/', 'http://localhost');if(!url.pathname.startsWith('/api/workbench/'))return false;
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try{
   const parts=url.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent),method=req.method??'GET';
   if(!['GET','HEAD'].includes(method)&&!await d.authorizeWrite(req,res))return true;
   const p=await d.authenticate(req);
   // token 仅授权创建时冻结的版本列表，不开放 catalog 查询接口。
   if(parts[0]==='shares'&&(parts.length===2||parts.length===5&&parts[2]==='files')&&method==='GET'){
    const item=store.records.get(parts[1]!);if(!item||item.kind!=='share'||item.revoked||Number(item.expiresAt)<=Date.now())throw new WorkspaceError(404,'分享不存在或已过期');
    if(!item.public&&(!p||!same(p.tenant,item.tenant)))throw new WorkspaceError(p?404:401,p?'分享不存在':'请先登录');
    const files=(Array.isArray(item.files)?item.files:[]) as SharedFile[];
    if(parts.length===5){const file=files.find(f=>f.artifactId===parts[3]&&f.versionId===parts[4]);if(!file)throw new WorkspaceError(404,'此分享未授权该文件');downloadBytes(res,readSharedFile(d,item.tenant,file),file.name);return true;}
    sendJson(res,200,{snapshot:item.snapshot,expiresAt:item.expiresAt,public:item.public,files:files.map(f=>({...f,downloadUrl:'/api/workbench/shares/'+encodeURIComponent(item.id)+'/files/'+encodeURIComponent(f.artifactId)+'/'+encodeURIComponent(f.versionId)}))});return true;
   }
   if(!p)throw new WorkspaceError(401,'请先登录');const t=p.tenant;
   let body:Record<string,unknown>={};if(!['GET','HEAD','DELETE'].includes(method)){const b=await readJsonBody(req);if(!b.ok||!b.value||typeof b.value!=='object'||Array.isArray(b.value))throw new WorkspaceError(400,'参数无效');body=b.value as Record<string,unknown>;}
   const str=(name:string,max=120,required=false)=>{const v=body[name];if(v===undefined&&!required)return undefined;if(typeof v!=='string'||v.length>max||(required&&!v.trim()))throw new WorkspaceError(400,name+' 格式无效');return v.trim();};
   const owned=(r:RecordData|undefined)=>{if(!r||!same(t,r.tenant))throw new WorkspaceError(404,'对象不存在');return r;};
   const owner=(r:RecordData)=>{if(r.tenant.userId!==t.userId&&!admin(p))throw new WorkspaceError(403,'只有创建者或管理员可以操作');};
   const task=(id:string)=>{const v=d.listTasks(t).find(v=>v.taskId===id);if(!v)throw new WorkspaceError(404,'任务不存在');return v;};
   const snapshot=(id:string)=>{const v=task(id);return {taskId:v.taskId,title:clean(v.title??'未命名任务'),status:v.status,artifacts:d.catalog.listForTask(t,id).map(a=>({artifactId:a.artifactId,versions:a.versions.map(x=>({versionId:x.versionId,name:clean(x.name),sha256:x.sha256}))}))};};
   if(parts[0]==='preferences'&&parts.length===1){
    if(method==='GET')sendJson(res,200,store.preferences(t));
    else if(method==='PUT'){const value={nickname:str('nickname',80)??'',styleInstructions:str('styleInstructions',4000)??''};store.records.put({id:key(t,'preferences',t.userId),tenant:t,kind:'preferences',...value});sendJson(res,200,value);}else throw new WorkspaceError(405,'不支持的偏好操作');
   }else if(parts[0]==='conversations'){
    if(parts.length===1&&method==='GET')sendJson(res,200,{groups:store.list(t,'conversation').filter(r=>r.tenant.userId===t.userId)});
    else if(parts.length===2&&method==='PATCH'){const id=parts[1]!,tasks=d.listTasks(t).filter(v=>(v.conversationId??v.taskId)===id);if(!tasks.length)throw new WorkspaceError(404,'会话不存在');if(tasks.some(v=>v.tenant.userId!==t.userId)&&!admin(p))throw new WorkspaceError(403,'只有创建者可分组');const group=str('group',80)??'';store.records.put({id:key(t,'conversation',id),tenant:t,kind:'conversation',conversationId:id,group});sendJson(res,200,{group});}else throw new WorkspaceError(405,'不支持的会话操作');
   }else if(parts[0]==='files'){
    const root=workspaceDirectory(d.root,t),trash=join(root,'.recycle');
    const metadata=(name:string)=>store.records.get(key(t,'file',name));
    const path=(name:string)=>{if(!isSafeFileName(name)||name.startsWith('.'))throw new WorkspaceError(400,'文件名无效');const candidate=join(root,name);if(lstatSync(candidate).isSymbolicLink()||!lstatSync(candidate).isFile())throw new WorkspaceError(400,'仅可管理普通文件');return checkedFile(root,candidate);};
    const canEdit=(name:string)=>{const f=d.catalog.file(t,join(root,name));if(!admin(p)&&f?.tenant.userId!==t.userId)throw new WorkspaceError(403,'共享文件或未知归属文件仅管理员可修改');};
    if(method==='GET'&&parts.length===1){
     const deleted=url.searchParams.get('trash')==='true';let rows:unknown[];
     if(deleted)rows=store.list(t,'trash').filter(r=>r.tenant.userId===t.userId||admin(p)).map(r=>({trashId:r.id,name:r.name,folder:r.folder,deletedAt:r.deletedAt}));
     else rows=existsSync(root)?readdirSync(root).filter(n=>!n.startsWith('.')&&isSafeFileName(n)&&lstatSync(join(root,n)).isFile()&&!lstatSync(join(root,n)).isSymbolicLink()).map(name=>{const f=d.catalog.file(t,join(root,name));return {name,sizeBytes:lstatSync(join(root,name)).size,folder:metadata(name)?.folder??'',editable:admin(p)||f?.tenant.userId===t.userId};}):[];
     sendJson(res,200,paginate(rows,url.searchParams));
    }else if(method==='POST'&&parts[1]==='batch'){
     if(d.listTasks(t).some(v=>['QUEUED','RUNNING','AWAIT_CONFIRM'].includes(v.status)))throw new WorkspaceError(409,'请等待工作区任务结束后管理文件');
     if(!Array.isArray(body.operations)||!body.operations.length||body.operations.length>50)throw new WorkspaceError(400,'每批需要 1 至 50 个操作');
     const results=[];for(const input of body.operations){try{
      if(!input||typeof input!=='object')throw new WorkspaceError(400,'文件操作无效');const op=input as Record<string,unknown>;
      if(op.action==='restore'){
       const r=owned(store.records.get(String(op.trashId)));if(r.kind!=='trash')throw new WorkspaceError(404,'回收文件不存在');owner(r);
       const name=String(r.name);if(!isSafeFileName(name))throw new WorkspaceError(400,'恢复文件名无效');const target=join(root,name);if(existsSync(target))throw new WorkspaceError(409,'原位置已有同名文件');
       if(lstatSync(trash).isSymbolicLink()||lstatSync(join(trash,r.id)).isSymbolicLink())throw new WorkspaceError(400,'回收文件无效');const source=checkedFile(root,join(trash,r.id));renameSync(source,target);d.catalog.registerFile(r.tenant,target);store.records.remove(r.id);results.push({ok:true,name});continue;
      }
      const name=String(op.name??''),source=path(name);canEdit(name);
      if(op.action==='rename'){const next=String(op.newName??'');if(!isSafeFileName(next)||next.startsWith('.'))throw new WorkspaceError(400,'新文件名无效');const target=join(root,next);if(existsSync(target))throw new WorkspaceError(409,'目标文件已存在');const uploader=d.catalog.file(t,source)?.tenant??t;renameSync(source,target);d.catalog.registerFile(uploader,target,source);store.records.put({id:key(t,'file',next),tenant:t,kind:'file',folder:metadata(name)?.folder??''});}
      else if(op.action==='move'){const folder=String(op.folder??'').trim();if(folder.length>80||/[\\/\x00-\x1f]/.test(folder))throw new WorkspaceError(400,'分类文件夹名称无效');store.records.put({id:key(t,'file',name),tenant:t,kind:'file',folder});}
      else if(op.action==='trash'){if(existsSync(trash)&&lstatSync(trash).isSymbolicLink())throw new WorkspaceError(409,'回收目录无效');mkdirSync(trash,{recursive:true,mode:0o700});const id=randomUUID(),uploader=d.catalog.file(t,source)?.tenant??t;store.records.put({id,tenant:uploader,kind:'trash',name,folder:metadata(name)?.folder??'',deletedAt:Date.now()});try{renameSync(source,join(trash,id));}catch(e){store.records.remove(id);throw e;}}
      else throw new WorkspaceError(400,'未知文件操作');results.push({ok:true,name});
     }catch(e){results.push({ok:false,error:e instanceof WorkspaceError?e.message:'文件操作失败'});}}
     sendJson(res,200,{results});
    }else throw new WorkspaceError(405,'不支持的文件操作');
   }else if(parts[0]==='shares'){
    if(method==='GET'&&parts.length===1)sendJson(res,200,{shares:store.list(t,'share').filter(r=>r.tenant.userId===t.userId).map(({snapshot,...r})=>r)});
    else if(method==='POST'&&parts.length===1){
     const id=str('taskId',200,true)!,isPublic=body.public===true;task(id);
     if(isPublic&&body.confirmPublic!==true)throw new WorkspaceError(400,'公开分享必须明确确认');
     if(body.includeFiles===true&&body.confirmFiles!==true)throw new WorkspaceError(400,'分享文件内容必须额外明确确认');
     const files=body.includeFiles===true?selectArtifactFiles(d,t,id,body.files):[];
     if(body.includeFiles===true&&!files.length)throw new WorkspaceError(400,'请至少选择一个产物版本');
     const hours=Number(body.expiresInHours??24);if(!Number.isInteger(hours)||hours<1||hours>168)throw new WorkspaceError(400,'有效期须为 1 至 168 小时');
     const share={id:randomUUID(),tenant:t,kind:'share',snapshot:snapshot(id),files,public:isPublic,expiresAt:Date.now()+hours*3600000,revoked:false};store.records.put(share);sendJson(res,201,{id:share.id,url:'/share.html?id='+share.id,expiresAt:share.expiresAt,files});
    }
    else if(method==='DELETE'&&parts.length===2){const r=owned(store.records.get(parts[1]!));if(r.kind!=='share')throw new WorkspaceError(404,'分享不存在');owner(r);store.records.put({...r,revoked:true});sendJson(res,200,{revoked:true});}else throw new WorkspaceError(405,'不支持的分享操作');
   }else if(parts[0]==='handoff'&&parts[1]==='options'&&method==='GET'){
    const id=url.searchParams.get('taskId')??'';task(id);
    const inputs=await d.inputs?.(t,id)??[];
    sendJson(res,200,{artifacts:d.catalog.listForTask(t,id),inputs:inputs.map(i=>({fileId:i.fileId,name:archiveName(i.name),sha256:i.sha256})),inputsAvailable:!!d.inputs,eventsAvailable:!!d.events});
   }else if(parts[0]==='handoff'&&parts.length===1&&method==='POST'){
    const id=str('taskId',200,true)!,selectedTask=task(id);
    if(!d.events)throw new WorkspaceError(503,'对话与操作轨迹接口尚未接入，暂不能导出完整转交包');
    if(body.includeInputs===true&&body.confirmInputs!==true)throw new WorkspaceError(400,'打包输入原件必须明确确认');
    const files=selectArtifactFiles(d,t,id,body.files??[]);
    const archive:Record<string,Uint8Array>={},manifestFiles:{path:string;kind:string;sha256:string;sizeBytes:number;artifactId?:string;versionId?:string;fileId?:string}[]=[];let total=0;
    const add=(path:string,bytes:Uint8Array,metadata:Omit<(typeof manifestFiles)[number],'path'|'sha256'|'sizeBytes'>)=>{total+=bytes.length;if(total>MAX_TRANSFER_BYTES)throw new WorkspaceError(413,'转交包内容超过 64 MB');archive[path]=bytes;manifestFiles.push({path,...metadata,sha256:hashBytes(bytes),sizeBytes:bytes.length});};
    for(const [index,file]of files.entries())add('artifacts/'+String(index+1).padStart(3,'0')+'_'+file.name,readSharedFile(d,t,file),{kind:'artifact',artifactId:file.artifactId,versionId:file.versionId});
    if(body.includeInputs===true){
     if(!d.inputs)throw new WorkspaceError(503,'输入快照白名单尚未接入');
     if(!Array.isArray(body.inputIds)||!body.inputIds.length||body.inputIds.length>50||body.inputIds.some(i=>typeof i!=='string'))throw new WorkspaceError(400,'请选择至多 50 个输入原件');
     const allowed=await d.inputs(t,id);const selected=[...new Set(body.inputIds as string[])];
     for(const [index,inputId]of selected.entries()){
      const input=allowed.find(i=>i.fileId===inputId);if(!input||!/^[a-f0-9]{64}$/i.test(input.sha256))throw new WorkspaceError(404,'输入文件未获授权');
      if(lstatSync(input.path).isSymbolicLink()||!lstatSync(input.path).isFile())throw new WorkspaceError(409,'输入快照不是普通文件');
      const bytes=readFileSync(checkedFile(workspaceDirectory(d.root,t),input.path));if(hashBytes(bytes)!==input.sha256)throw new WorkspaceError(409,'输入快照已变化，不能导出');
      add('inputs/'+String(index+1).padStart(3,'0')+'_'+archiveName(input.name),bytes,{kind:'input',fileId:input.fileId});
     }
    }
    const conversationId=selectedTask.conversationId??selectedTask.taskId;
    const allRounds=d.listTasks(t).filter(v=>(v.conversationId??v.taskId)===conversationId).sort((a,b)=>Number(a.createdAt)-Number(b.createdAt));
    const rounds=allRounds.slice(0,100),conversation:unknown[]=[],trace:unknown[]=[];let truncated=allRounds.length>rounds.length,eventCount=0,textBytes=0;
    const safeText=(value:unknown)=>{if(typeof value!=='string')return undefined;const redacted=clean(value).split(d.root).join('[工作区]'),result=redacted.slice(0,20000);if(redacted.length>20000)truncated=true;textBytes+=Buffer.byteLength(result);return result;};
    roundsLoop:for(const round of rounds){
     const events=await d.events?.(t,round.taskId)??[];
     for(const event of events){if(eventCount++>=10000||textBytes>4*1024*1024){truncated=true;break roundsLoop;}const e=event as unknown as Record<string,unknown>,base={taskId:round.taskId,type:e.type,at:e.at,seq:e.seq};
      if(e.type==='user_message'||e.type==='assistant_message')conversation.push({...base,text:safeText(e.text)});
      if(['step','tool_decision','status','artifact'].includes(String(e.type))){const projection:Record<string,unknown>={...base};for(const k of ['toolName','action','phase','decision','reason','inputSummary','resultSummary','detail','from','to','name']){const value=safeText(e[k]);if(value!==undefined)projection[k]=value;}trace.push(projection);}
     }
    }
    add('conversation.json',strToU8(JSON.stringify(conversation,null,2)),{kind:'conversation'});
    add('operations.json',strToU8(JSON.stringify(trace,null,2)),{kind:'operations'});
    const manifest={format:'tao-handoff-v2',createdAt:Date.now(),snapshot:snapshot(id),note:clean(str('note',4000)??''),conversationId,rounds:rounds.map(r=>({taskId:r.taskId,title:clean(r.title??''),status:r.status})),eventsAvailable:!!d.events,truncated,includesInputs:body.includeInputs===true,files:manifestFiles,instructions:'此包通过登录鉴权导出；不包含登录凭据或执行权限。对话与轨迹已按规则脱敏，产物和输入文件保持原始字节，请按资料权限转交。'};
    archive['manifest.json']=strToU8(JSON.stringify(manifest,null,2));downloadBytes(res,zipSync(archive,{level:0}),'任务转交包.zip','application/zip');
   }else if(parts[0]==='artifacts'&&parts[1]){
    const artifact=d.catalog.owned(t,parts[1]);if(!artifact||!artifact.versions.some(v=>d.listTasks(t).some(task=>task.taskId===v.taskId)))throw new WorkspaceError(404,'产物不存在');
    if(parts[2]==='diff'&&method==='GET'){
     const a=artifact.versions.find(v=>v.versionId===url.searchParams.get('from')),b=artifact.versions.find(v=>v.versionId===url.searchParams.get('to'));if(!a||!b)throw new WorkspaceError(404,'版本不存在');
     if(!/\.(txt|md|csv|tsv|json|html|css|js|ts|py|xml)$/i.test(a.name)||a.sizeBytes>262144||b.sizeBytes>262144)throw new WorkspaceError(400,'仅支持 256 KB 以内文本版本对比');
     const before=d.catalog.readVersion(t,a).toString('utf8'),after=d.catalog.readVersion(t,b).toString('utf8');sendJson(res,200,{before,after,from:a.versionId,to:b.versionId});
    }else if(parts[2]==='comments'){
     if(method==='GET')sendJson(res,200,{comments:store.list(t,'comment').filter(r=>r.artifactId===artifact.artifactId)});
     else if(method==='POST'){const r={id:randomUUID(),tenant:t,kind:'comment',artifactId:artifact.artifactId,text:clean(str('text',4000,true)!),proposal:body.proposal===true,status:'pending',createdAt:Date.now()};store.records.put(r);sendJson(res,201,{comment:r});}
     else if(method==='PATCH'&&parts[3]){const r=owned(store.records.get(parts[3]));if(r.kind!=='comment'||r.artifactId!==artifact.artifactId||!r.proposal)throw new WorkspaceError(404,'修订建议不存在');if(artifact.tenant.userId!==t.userId&&!admin(p))throw new WorkspaceError(403,'只有产物创建者或管理员可裁定');if(!['accepted','rejected'].includes(String(body.status)))throw new WorkspaceError(400,'修订状态无效');store.records.put({...r,status:body.status,decidedBy:t.userId,decidedAt:Date.now()});sendJson(res,200,{ok:true});}else throw new WorkspaceError(405,'不支持的评论操作');
    }else throw new WorkspaceError(404,'接口不存在');
   }else if(parts[0]==='teams'){
    if(parts[1]==='members'&&method==='GET')sendJson(res,200,{members:d.members?.(t)??[],available:!!d.members});
    else if(parts.length===1&&method==='GET')sendJson(res,200,{teams:store.visibleTeams(p)});
    else if(parts.length===1&&method==='POST'){const r={id:randomUUID(),tenant:t,kind:'team',name:str('name',80,true)!,members:[{userId:t.userId,role:'owner'}],taskIds:[]};store.records.put(r);sendJson(res,201,{team:r});}
    else if(parts.length===2&&method==='PATCH'){
     const r=owned(store.records.get(parts[1]!));if(r.kind!=='team')throw new WorkspaceError(404,'团队空间不存在');const isOwner=r.tenant.userId===t.userId||admin(p),isEditor=(r.members as {userId:string;role:string}[]).some(m=>m.userId===t.userId&&m.role==='editor');if(!isOwner&&!isEditor)throw new WorkspaceError(403,'只读成员不能修改团队空间');const patch:Record<string,unknown>={};
     if(body.members!==undefined){if(!isOwner)throw new WorkspaceError(403,'只有空间创建者可管理成员');if(!d.members)throw new WorkspaceError(503,'账号目录尚未接入');const known=new Set(d.members(t).map(m=>m.userId));if(!Array.isArray(body.members)||body.members.length>100||body.members.some(m=>!m||typeof m!=='object'||!known.has(m.userId)||!['viewer','editor'].includes(m.role)))throw new WorkspaceError(400,'成员或角色无效');patch.members=[{userId:r.tenant.userId,role:'owner'},...body.members.filter(m=>m.userId!==r.tenant.userId)];}
     if(body.taskIds!==undefined){if(!Array.isArray(body.taskIds)||body.taskIds.length>100||body.taskIds.some(id=>typeof id!=='string'))throw new WorkspaceError(400,'任务列表无效');body.taskIds.forEach(id=>task(id));patch.taskIds=body.taskIds;}
     store.records.put({...r,...patch});sendJson(res,200,{ok:true});
    }else throw new WorkspaceError(405,'不支持的团队操作');
   }else throw new WorkspaceError(404,'接口不存在');
  }catch(e){if(!res.headersSent)sendError(res,e instanceof WorkspaceError?e.status:500,e instanceof WorkspaceError?e.message:'工作台操作失败');}return true;
 };
}
