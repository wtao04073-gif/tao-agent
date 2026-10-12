import { createHash } from 'node:crypto';
import type { PlatformTool, StoredJob, StoredTask, TenantContext } from '@tao/core';
import type { FileJobStore } from '@tao/knowledge';
import type { TaskPresentation } from './workspace-management.ts';

export function chatJobId(tenant: TenantContext, conversationId: string): string {
  return 'job-chat-' + createHash('sha256').update(JSON.stringify([tenant.tenantId, tenant.workspaceId, tenant.userId, conversationId])).digest('hex').slice(0, 32);
}

/** 模型只提供名称和目标，归属由服务端绑定，不能操作任意用户任务。 */
export function chatJobTool(options: {
  tenant: TenantContext; conversationId: string; taskId: string;
  store: FileJobStore; presentation: TaskPresentation;
  tasks: () => readonly StoredTask[]; onRegistered: (job: StoredJob) => void;
}): PlatformTool {
  return {
    name: 'register_chat_task', label: '整理任务需求', replay: 'safe',
    description: '当用户要求完成明确的工作（写文档、分析、开发、调研、制作文件等）时，将当前会话登记为任务，给出简洁名称和准确需求摘要。寒暄、知识问答、仅询问能力不登记。不调用任何外部系统。',
    parameters: {type:'object',properties:{title:{type:'string',maxLength:48},goal:{type:'string',maxLength:4000}},required:['title','goal'],additionalProperties:false},
    async execute(call) {
      if(call.signal.aborted)throw new Error('任务已取消');
      if(call.taskId!==options.taskId||call.tenant.tenantId!==options.tenant.tenantId||call.tenant.workspaceId!==options.tenant.workspaceId||call.tenant.userId!==options.tenant.userId)throw new Error('任务身份不匹配');
      const args=call.args as {title?:unknown;goal?:unknown};
      if(!args||typeof args.title!=='string'||!args.title.trim()||args.title.length>48||typeof args.goal!=='string'||!args.goal.trim()||args.goal.length>4000)throw new Error('任务名称或需求摘要无效');
      const id=chatJobId(options.tenant,options.conversationId);
      const previous=options.store.get(id);
      const job:StoredJob=previous?(previous.title==='新任务'?{...previous,title:args.title.trim(),goal:args.goal.trim(),updatedAt:Date.now()}:previous):{jobId:id,tenant:options.tenant,title:args.title.trim(),goal:args.goal.trim(),status:'active',createdAt:Date.now(),updatedAt:Date.now(),conversationIds:[options.conversationId],memory:[]};
      if(previous&&previous.status!=='active')throw new Error('任务已归档，请新建对话');
      if(previous&&previous.title==='新任务')options.store.put(job);
      if(!previous&&!options.store.create(job))throw new Error('任务建档失败，请重试');
      // 先保存可恢复的任务记录，再关联会话；重放不会创建重复任务。
      for(const task of options.tasks())if(task.conversationId===options.conversationId&&task.tenant.tenantId===options.tenant.tenantId&&task.tenant.workspaceId===options.tenant.workspaceId&&task.tenant.userId===options.tenant.userId)options.presentation.attachJob(task,id);
      options.onRegistered(job);
      call.report('已创建任务：'+job.title);
      return {text:JSON.stringify({jobId:id,title:job.title}),details:{jobId:id,title:job.title}};
    }
  };
}
