import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { Role, toolSummary, type StoredTask, type StoredSkill, type StoredAgent } from '@tao/core';
import { FileJsonStore, FileJobStore } from '@tao/knowledge';
import { createWriteTableTool } from '../../office/src/write-table.ts';
import { readSheet } from '@tao/office';
import { AdminIdentity } from '../src/admin-identity.ts';
import { createManagementHandler, TaskPresentation } from '../src/workspace-management.ts';
import { paginate } from '../src/pagination.ts';
import { supportsFile, KNOWLEDGE_FORMATS } from '../src/file-formats.ts';
import { KnowledgeJobs } from '../src/knowledge-jobs.ts';
import { createWorkspaceServices } from '../src/workspace-services.ts';
const servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
const tenant={tenantId:'t',workspaceId:'w',userId:'owner'};
const admin={tenant,role:Role.TenantAdmin};
const task:StoredTask={taskId:'task',tenant,sessionId:'s',conversationId:'conv',title:'原名称',status:'SUCCEEDED',artifacts:[],createdAt:1,updatedAt:1};
async function management(){
 const root=mkdtempSync(join(tmpdir(),'tao-round2-')),presentation=new TaskPresentation(root),skills=new FileJsonStore<StoredSkill>({dir:root,collection:'skills',idOf:x=>x.skillId}),agents=new FileJsonStore<StoredAgent>({dir:root,collection:'agents',idOf:x=>x.agentId}),jobs=new FileJobStore({dir:root});
 const tasks=[{...task}];
 const principals={owner:admin,member:{tenant:{...tenant,userId:'member'},role:Role.Member},other:{tenant:{...tenant,workspaceId:'other'},role:Role.TenantAdmin}};
 const handler=createManagementHandler({root,presentation,skills,agents,jobs,authenticate:async req=>principals[req.headers.authorization as keyof typeof principals],listTasks:t=>presentation.list(tasks.filter(x=>x.tenant.tenantId===t.tenantId&&x.tenant.workspaceId===t.workspaceId)),cancel:async id=>{tasks.find(t=>t.taskId===id)!.status='CANCELLED';}});
 const server=createServer((req,res)=>{void handler(req,res).then(handled=>{if(!handled)res.writeHead(404).end();});});servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const call=(path:string,method='GET',body?:unknown,who='owner')=>fetch(url+path,{method,headers:{authorization:who,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {root,presentation,skills,agents,jobs,tasks,call};
}
describe('第二轮报告回归',()=>{
 it('分页支持偏移、搜索和参数边界，稳定返回最新记录',()=>{
  const rows=Array.from({length:125},(_,i)=>({title:'记录'+i,createdAt:i}));
  expect(paginate(rows,new URLSearchParams('limit=20&offset=20'))).toMatchObject({total:125,nextCursor:'40',items:[{title:'记录104',createdAt:104},...rows.slice(85,104).reverse()]});
  expect(paginate(rows,new URLSearchParams('q=记录124')).items).toHaveLength(1);
  for(const query of ['limit=0','offset=-1','limit=101','cursor=NaN'])expect(()=>paginate(rows,new URLSearchParams(query))).toThrow();
 });
 it('任务管理拒绝越权及运行中删除，改名和删除重启后仍生效',async()=>{
  const s=await management();expect((await s.call('/api/tasks/task','PATCH',{title:'新名称'},'other')).status).toBe(404);
  expect((await s.call('/api/tasks/task','PATCH',{title:'新名称'},'member')).status).toBe(403);
  s.tasks[0]!.status='RUNNING';expect((await s.call('/api/conversations/conv','DELETE')).status).toBe(409);s.tasks[0]!.status='SUCCEEDED';
  expect((await s.call('/api/conversations/conv','PATCH',{title:'新名称'})).status).toBe(200);expect(new TaskPresentation(s.root).view(task)?.title).toBe('新名称');
  expect((await s.call('/api/conversations/conv','DELETE')).status).toBe(200);expect(new TaskPresentation(s.root).view(task)).toBeUndefined();
 });
 it('技能删除保护智能体引用，禁止借更新更换归属',async()=>{
  const s=await management();s.skills.put({skillId:'skill',tenant,name:'技能',description:'描述',content:'原指令',builtin:false,createdAt:1,updatedAt:1});s.agents.put({agentId:'agent',tenant,name:'智能体',description:'描述',systemPrompt:'系统提示',skillIds:['skill'],builtin:false,createdAt:1,updatedAt:1});
  expect((await s.call('/api/skills/skill','DELETE')).status).toBe(409);
  expect((await s.call('/api/skills/skill','PATCH',{content:'修改',tenant:{tenantId:'other'}})).status).toBe(200);expect(s.skills.get('skill')?.tenant).toEqual(tenant);
  expect((await s.call('/api/agents/agent','PATCH',{skillIds:[]})).status).toBe(200);expect((await s.call('/api/skills/skill','DELETE')).status).toBe(200);expect(s.skills.get('skill')).toBeUndefined();
 });
 it('上传文件删除限制管理员，不能删除越界文件；停止长期任务取消其活跃轮次',async()=>{
  const s=await management(),dir=join(s.root,'t','w');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'上传.txt'),'file');
  expect((await s.call('/api/files/上传.txt','DELETE',undefined,'member')).status).toBe(403);
  expect((await s.call('/api/files/上传.txt','DELETE')).status).toBe(200);
  s.tasks[0]!.jobId='job';s.tasks[0]!.status='RUNNING';s.jobs.put({jobId:'job',tenant,title:'任务',goal:'目标',status:'active',createdAt:1,updatedAt:1,conversationIds:[],memory:[]});
  expect((await s.call('/api/jobs/job','PATCH',{status:'cancelled'})).status).toBe(200);expect(s.tasks[0]!.status).toBe('CANCELLED');expect(s.jobs.get('job')?.status).toBe('archived');
 });
 it('非法知识格式同步拒绝，不产生不可查询的队列记录',()=>{
  const root=mkdtempSync(join(tmpdir(),'tao-round2-ingest-')),jobs=new KnowledgeJobs(root,createWorkspaceServices({workspaceRoot:root}));
  expect(()=>jobs.create(tenant,{fileName:'evil.exe'})).toThrow('不支持');expect(jobs.busy).toBe(false);
  expect(supportsFile('a.xls',KNOWLEDGE_FORMATS)).toBe(true);expect(supportsFile('a.xlsx.exe')).toBe(false);
 });
 it('旧 Bearer 登出后不能再认证，重启不能从迁移目录复活',()=>{
  const root=mkdtempSync(join(tmpdir(),'tao-round2-identity-')),token='test-only-not-a-real-token';const directory={accounts:[{...tenant,token,name:'测试',role:Role.TenantAdmin}]};
  const identity=new AdminIdentity(root,directory);expect(identity.token(token)).toBeDefined();identity.logout(token);expect(identity.token(token)).toBeUndefined();expect(new AdminIdentity(root,directory).token(token)).toBeUndefined();
 });
 it('工具摘要限制内容、隐藏多层密钥和越界路径',()=>{
  const result=toolSummary({token:'test-token',nested:{apiKey:'test-key',path:'/private/other/data'},rows:['private-cell'],text:'Bearer token123 https://test.invalid/?secret=key'});
  for(const secret of ['test-token','test-key','/private/other','private-cell','token123','test.invalid'])expect(result).not.toContain(secret);
  expect(result.length).toBeLessThanOrEqual(4096);
 });
 it('Excel 写出保留数字、按文本处理公式，不覆盖已有文件或跟随链接',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tao-round2-xlsx-')),tool=createWriteTableTool(dir),args={outputName:'台账.xlsx',columns:['名称','数量'],rows:[['=SUM(A1:A2)',12]]};
  const execute=(value:unknown)=>tool.execute({args:value,report:()=>{}} as never);
  await execute(args);const sheet=await readSheet(join(dir,args.outputName));expect(sheet.rows[0]).toEqual({'名称':'=SUM(A1:A2)','数量':12});
  await expect(execute(args)).rejects.toThrow('已经存在');await expect(execute({...args,outputName:'../out.xlsx'})).rejects.toThrow();
  const outside=join(dir,'original');writeFileSync(outside,'原文');symlinkSync(outside,join(dir,'link.xlsx'));await expect(execute({...args,outputName:'link.xlsx'})).rejects.toThrow();expect(readFileSync(outside,'utf8')).toBe('原文');
 });
 it('前端同一提交并发合并，网络失败重试复用幂等键，成功后新轮次更换',async()=>{
  const data=new Map<string,string>(),storage={getItem:(k:string)=>data.get(k)||null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)};
  data.set('tao.token','unit-token');const calls:RequestInit[]=[];let reject=true;
  const document={createElement:()=>({}),head:{appendChild(){}},addEventListener(){},querySelectorAll:()=>[]};
  const location={href:'http://localhost/chat.html',origin:'http://localhost',pathname:'/chat.html',search:'',hash:''};
  const window:any={fetch:async(_path:string,init:RequestInit)=>{calls.push(init);if(reject)throw new Error('network');return new Response('{}',{status:202,headers:{'content-type':'application/json'}});},location,document};
  const context:any={window,document,location,localStorage:storage,sessionStorage:storage,Headers,URL,Response,crypto:globalThis.crypto,setTimeout,clearTimeout};
  runInNewContext(readFileSync(new URL('../../../web/assets/core.js',import.meta.url),'utf8'),context);context.fetch=window.fetch;
  const a=window.App.api('POST','/api/tasks',{query:'测试'}),b=window.App.api('POST','/api/tasks',{query:'测试'});expect(a).toBe(b);await expect(a).rejects.toThrow();const key=new Headers(calls[0]!.headers).get('Idempotency-Key');
  reject=false;await window.App.api('POST','/api/tasks',{query:'测试'});expect(new Headers(calls[1]!.headers).get('Idempotency-Key')).toBe(key);
  await window.App.api('POST','/api/tasks',{query:'测试'});expect(new Headers(calls[2]!.headers).get('Idempotency-Key')).not.toBe(key);
 });
});
