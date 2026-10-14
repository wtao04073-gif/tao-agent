import {createLocalTransferTools,transferTarget,type LocalInputReference,type LocalTransferArgs} from './transfer.ts';
import { statSync } from 'node:fs';
import type { ConfirmationOptions,PendingAction,PlatformTool,TenantContext,ToolDecision } from '@tao/core';
import { localControlConfig,safeJoin } from './config.ts';
import { classifyCommand } from './classify.ts';
import { localCapabilities,sessionEligible } from './policy.ts';
import { LocalSessionGrants } from './session-grant.ts';
import { createLocalShellToolset,preflightLocalControl } from './tool.ts';
import type { LocalControlConfig,LocalEnvironment,LocalExecutionAudit,LocalShellArgs,CommandRisk } from './types.ts';
import type { Values } from '../admin-settings.ts';
const same=(a:TenantContext|undefined,b:TenantContext)=>!!a&&a.tenantId===b.tenantId&&a.workspaceId===b.workspaceId&&a.userId===b.userId;
export class LocalControlManager {
 private grants=new LocalSessionGrants();
 private counts={started:0,succeeded:0,failed:0};
 private startup:{roots:string;mode:string};
 private values:()=>Values;private environment:()=>LocalEnvironment;private audit:(entry:LocalExecutionAudit)=>void;
 constructor(values:()=>Values,environment:()=>LocalEnvironment,audit:(entry:LocalExecutionAudit)=>void){this.values=values;this.environment=environment;this.audit=audit;const v=values();this.startup={roots:v.LOCAL_CONTROL_ROOTS??'',mode:v.LOCAL_CONTROL_MODE??'auto'};localControlConfig(v,environment());}
 private config(values=this.values()){const v={...values,LOCAL_CONTROL_ROOTS:this.startup.roots||values.LOCAL_CONTROL_ROOTS,LOCAL_CONTROL_MODE:this.startup.mode};return localControlConfig(v,this.environment());}
 validate(values:Values){return localControlConfig(values,this.environment());}
 capability(tenant:TenantContext){try{const c=this.config();const enabled=c.enabled&&same(c.owner,tenant);return {enabled,level:c.level,confined:c.confined,os:c.os,roots:enabled?c.roots:[],network:c.network,confirmMode:c.confirmMode,sessionGrantEligible:enabled&&c.level!=='readonly'&&c.confirmMode!=='never',autoRun:enabled&&c.trustedAutoRun===true,capabilities:localCapabilities(c),host:'service-machine',restartRequired:(this.values().LOCAL_CONTROL_ROOTS??'')!==this.startup.roots||(this.values().LOCAL_CONTROL_MODE??'auto')!==this.startup.mode};}catch{return {enabled:false,confined:false,reason:'本机控制配置、身份或运行权限不满足要求'};}}
 observability(t:TenantContext){return {...this.capability(t),calls:{...this.counts}};}
 tools(tenant:TenantContext,taskId:string,artifactDir:string,sources:readonly LocalInputReference[]=[]):PlatformTool[]{let cfg:LocalControlConfig;try{cfg=this.config();}catch{return [];}if(!cfg.enabled||!same(cfg.owner,tenant))return [];const context={tenant,taskId,artifactDir,audit:(e:LocalExecutionAudit)=>{this.audit(e);}};return [...createLocalShellToolset(cfg,context),...createLocalTransferTools(cfg,context,sources)].map(tool=>({...tool,execute:async input=>{const current=this.config();if(!same(current.owner,tenant)||!current.enabled||current.policyHash!==cfg.policyHash)throw Error('本机权限或身份已变化，请重新提交任务');this.counts.started++;try{const r=await tool.execute(input);if(r.isError)this.counts.failed++;else this.counts.succeeded++;return r;}catch(e){this.counts.failed++;throw e;}}}));}
 decision(tenant:TenantContext,taskId:string,args:unknown,toolName='local_shell'):ToolDecision {
  try {const c=this.config();if(!c.enabled||!same(c.owner,tenant))return {kind:'block',reason:'本机执行仅限已授权的唯一用户'};
   const transfer=toolName==='stage_to_local'||toolName==='collect_from_local';
   const transferArgs=args as LocalTransferArgs;
   const transferPath=transfer?transferTarget(c,transferArgs,toolName==='stage_to_local'):undefined;
   const a=(transfer?{command:toolName==='stage_to_local'?'复制本任务附件 '+transferArgs.fileId+' 至 '+transferPath:'收集本机 out 交付物',rootIndex:transferArgs.rootIndex,cwd:'.'}:args) as LocalShellArgs;if(!a||typeof a.command!=='string'||(a.cwd!==undefined&&typeof a.cwd!=='string'))throw Error('本机命令参数无效');
   const index=a.rootIndex??0;if(!Number.isInteger(index)||index<0||index>=c.roots.length)throw Error('授权目录编号无效');
   if(a.timeoutSec!==undefined&&(!Number.isInteger(a.timeoutSec)||a.timeoutSec<1||a.timeoutSec>c.timeoutSec))throw Error('超时参数无效');
   const cwd=safeJoin(c.roots[index]!,a.cwd??'.');if(!statSync(cwd).isDirectory())throw Error('工作目录不存在');
   const risk:CommandRisk=transfer?{kind:'confirm' as const,reason:'本机文件传输',capabilities:toolName==='stage_to_local'?['read','write_in_root']:['read'],highRisk:false}:classifyCommand(a.command,c);
   const auto=transfer&&c.trustedAutoRun===true;
   const decision:ToolDecision=risk.kind==='block'?{kind:'block',reason:risk.reason}:risk.kind==='allow'||auto||this.grants.allows(taskId,c,risk)?{kind:'allow'}:{kind:'confirm',reason:risk.reason,localControl:{command:a.command,cwd:transferPath??cwd,roots:c.roots,network:c.network,confined:c.confined,capabilities:risk.capabilities,highRisk:risk.highRisk,sessionAllowed:c.confirmMode!=='never'&&c.level!=='readonly'&&!risk.highRisk&&sessionEligible(risk.capabilities),maxTtlMinutes:c.sessionGrantTtlMin,policyHash:c.policyHash}};
   this.audit({tenant,taskId,decision:decision.kind,tool:toolName,command:a.command,cwd:transferPath??cwd,risk:risk.reason,capabilities:risk.capabilities});return decision;
  }catch{return {kind:'block',reason:'本机命令配置、身份、目录或参数校验失败'};}
 }
 async grant(tenant:TenantContext,taskId:string,action:PendingAction,options:ConfirmationOptions){const c=this.config(),meta=action.localControl;if(!meta||!['local_shell','stage_to_local','collect_from_local'].includes(action.toolName)||action.taskId!==taskId||!same(action.tenant,tenant)||!same(c.owner,tenant)||!c.enabled||meta.policyHash!==c.policyHash)throw Error('本机会话授权已经失效');const risk:CommandRisk=action.toolName==='local_shell'?classifyCommand(meta.command,c):{kind:'confirm' as const,reason:'本机文件传输',capabilities:action.toolName==='stage_to_local'?['read','write_in_root']:['read'],highRisk:false};const expiresAt=this.grants.grant(taskId,c,risk,options.ttlMinutes);try{this.audit({tenant,taskId,decision:'session-grant',capabilities:risk.capabilities,risk:'expiresAt='+expiresAt});}catch(error){this.grants.clearTask(taskId);throw error;}}
 clearTask(id:string){this.grants.clearTask(id);}
 clear(){this.grants.clear();}
 async preflight(values:Values){const cfg=this.validate(values);return preflightLocalControl(cfg);}
}
