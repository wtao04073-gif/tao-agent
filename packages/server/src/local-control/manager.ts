import { statSync } from 'node:fs';
import type { ConfirmationOptions,PendingAction,PlatformTool,TenantContext,ToolDecision } from '@tao/core';
import { localControlConfig,safeJoin } from './config.ts';
import { classifyCommand } from './classify.ts';
import { localCapabilities,sessionEligible } from './policy.ts';
import { LocalSessionGrants } from './session-grant.ts';
import { createLocalShellToolset,preflightLocalControl } from './tool.ts';
import type { LocalControlConfig,LocalEnvironment,LocalExecutionAudit,LocalShellArgs } from './types.ts';
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
 capability(tenant:TenantContext){try{const c=this.config();const enabled=c.enabled&&same(c.owner,tenant);return {enabled,level:c.level,confined:c.confined,os:c.os,roots:enabled?c.roots:[],network:c.network,confirmMode:c.confirmMode,capabilities:localCapabilities(c),host:'service-machine',restartRequired:(this.values().LOCAL_CONTROL_ROOTS??'')!==this.startup.roots||(this.values().LOCAL_CONTROL_MODE??'auto')!==this.startup.mode};}catch{return {enabled:false,confined:false,reason:'本机控制配置、身份或运行权限不满足要求'};}}
 observability(t:TenantContext){return {...this.capability(t),calls:{...this.counts}};}
 tools(tenant:TenantContext,taskId:string,artifactDir:string):PlatformTool[]{let cfg:LocalControlConfig;try{cfg=this.config();}catch{return [];}if(!cfg.enabled||!same(cfg.owner,tenant))return [];return createLocalShellToolset(cfg,{tenant,taskId,artifactDir,audit:e=>{this.audit(e);}}).map(tool=>({...tool,execute:async input=>{const current=this.config();if(!same(current.owner,tenant)||!current.enabled||current.policyHash!==cfg.policyHash)throw Error('本机权限或身份已变化，请重新提交任务');this.counts.started++;try{const r=await tool.execute(input);if(r.isError)this.counts.failed++;else this.counts.succeeded++;return r;}catch(e){this.counts.failed++;throw e;}}}));}
 decision(tenant:TenantContext,taskId:string,args:unknown):ToolDecision {
  try {const c=this.config();if(!c.enabled||!same(c.owner,tenant))return {kind:'block',reason:'本机执行仅限已授权的唯一用户'};
   const a=args as LocalShellArgs;if(!a||typeof a.command!=='string'||(a.cwd!==undefined&&typeof a.cwd!=='string'))throw Error('本机命令参数无效');
   const index=a.rootIndex??0;if(!Number.isInteger(index)||index<0||index>=c.roots.length)throw Error('授权目录编号无效');
   if(a.timeoutSec!==undefined&&(!Number.isInteger(a.timeoutSec)||a.timeoutSec<1||a.timeoutSec>c.timeoutSec))throw Error('超时参数无效');
   const cwd=safeJoin(c.roots[index]!,a.cwd??'.');if(!statSync(cwd).isDirectory())throw Error('工作目录不存在');
   const risk=classifyCommand(a.command,c);
   const decision:ToolDecision=risk.kind==='block'?{kind:'block',reason:risk.reason}:risk.kind==='allow'||this.grants.allows(taskId,c,risk)?{kind:'allow'}:{kind:'confirm',reason:risk.reason,localControl:{command:a.command,cwd,roots:c.roots,network:c.network,confined:c.confined,capabilities:risk.capabilities,highRisk:risk.highRisk,sessionAllowed:c.confirmMode==='session'&&!risk.highRisk&&sessionEligible(risk.capabilities),maxTtlMinutes:c.sessionGrantTtlMin,policyHash:c.policyHash}};
   this.audit({tenant,taskId,decision:decision.kind,command:a.command,cwd,risk:risk.reason,capabilities:risk.capabilities});return decision;
  }catch{return {kind:'block',reason:'本机命令配置、身份、目录或参数校验失败'};}
 }
 async grant(tenant:TenantContext,taskId:string,action:PendingAction,options:ConfirmationOptions){const c=this.config(),meta=action.localControl;if(!meta||action.toolName!=='local_shell'||action.taskId!==taskId||!same(action.tenant,tenant)||!same(c.owner,tenant)||!c.enabled||meta.policyHash!==c.policyHash)throw Error('本机会话授权已经失效');const risk=classifyCommand(meta.command,c);const expiresAt=this.grants.grant(taskId,c,risk,options.ttlMinutes);try{this.audit({tenant,taskId,decision:'session-grant',capabilities:risk.capabilities,risk:'expiresAt='+expiresAt});}catch(error){this.grants.clearTask(taskId);throw error;}}
 clearTask(id:string){this.grants.clearTask(id);}
 clear(){this.grants.clear();}
 async preflight(values:Values){const cfg=this.validate(values);return preflightLocalControl(cfg);}
}
