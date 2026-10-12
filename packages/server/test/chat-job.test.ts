import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileJobStore} from '@tao/knowledge';
import type {StoredTask} from '@tao/core';
import {chatJobTool,chatJobId} from '../src/chat-job.ts';
import {TaskPresentation} from '../src/workspace-management.ts';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
function setup(){
 const root=mkdtempSync(join(tmpdir(),'chat-job-'));roots.push(root);
 const tenant={tenantId:'tenant',workspaceId:'work',userId:'user'};
 const store=new FileJobStore({dir:root}),presentation=new TaskPresentation(root);
 const task={taskId:'task-1',tenant,conversationId:'conv-1',title:'原始问题',status:'SUCCEEDED'} as StoredTask;
 const tool=chatJobTool({tenant,conversationId:'conv-1',taskId:'task-1',store,presentation,tasks:()=>[task],onRegistered:()=>{}});
 const call={tenant,taskId:'task-1',signal:new AbortController().signal,report:()=>{},args:{title:'整理季度报告',goal:'整理季度数据并生成报告'}};
 return {root,tenant,store,presentation,task,tool,call};
}
it('登记需求并持久关联会话，重放不重复创建或覆盖已有标题',async()=>{
 const f=setup();await f.tool.execute(f.call);await f.tool.execute({...f.call,args:{title:'不要覆盖',goal:'新目标'}});
 const jobs=f.store.listByTenant('tenant','work');expect(jobs).toHaveLength(1);expect(jobs[0].title).toBe('整理季度报告');
 expect(new TaskPresentation(f.root).view(f.task)?.jobId).toBe(jobs[0].jobId);
 f.presentation.update([f.task],'用户自定名称');expect(f.presentation.view(f.task)?.jobId).toBe(jobs[0].jobId);
});
it('主动任务模式的占位名称可被模型摘要补全',async()=>{
 const f=setup(),id=chatJobId(f.tenant,'conv-1');
 f.store.create({jobId:id,tenant:f.tenant,title:'新任务',goal:'原文',status:'active',createdAt:1,updatedAt:1,conversationIds:['conv-1'],memory:[]});
 await f.tool.execute(f.call);expect(f.store.get(id)?.title).toBe('整理季度报告');expect(f.store.get(id)?.goal).toBe('整理季度数据并生成报告');
});
it('拒绝跨用户和跨执行调用，不产生任务',async()=>{
 const f=setup();await expect(f.tool.execute({...f.call,tenant:{...f.tenant,userId:'other'}})).rejects.toThrow('身份');
 await expect(f.tool.execute({...f.call,taskId:'other'})).rejects.toThrow('身份');expect(f.store.listByTenant('tenant','work')).toHaveLength(0);
 expect(chatJobId({...f.tenant,userId:'other'},'conv-1')).not.toBe(chatJobId(f.tenant,'conv-1'));
});
it('取消或无效摘要不建档，已归档任务不能被工具重新激活',async()=>{
 const f=setup();await expect(f.tool.execute({...f.call,args:{title:' ',goal:'目标'}})).rejects.toThrow('无效');
 await expect(f.tool.execute({...f.call,signal:AbortSignal.abort()})).rejects.toThrow('取消');
 expect(f.store.listByTenant('tenant','work')).toHaveLength(0);await f.tool.execute(f.call);
 const job=f.store.listByTenant('tenant','work')[0];f.store.put({...job,status:'archived'});
 await expect(f.tool.execute(f.call)).rejects.toThrow('归档');expect(f.store.get(job.jobId)?.status).toBe('archived');
});
