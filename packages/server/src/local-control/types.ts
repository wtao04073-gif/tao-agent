import type { TenantContext } from '@tao/core';
export type LocalLevel='off'|'readonly'|'workspace'|'extended'|'full';
export type LocalCapability='read'|'write_in_root'|'delete'|'execute_local'|'network'|'install_pkg'|'write_outside'|'system_maintenance';
export interface LocalControlConfig {
 enabled:boolean;singleUser:boolean;level:LocalLevel;roots:string[];mode:'seatbelt'|'bwrap'|'advisory';confined:boolean;os:string;
 network:boolean;allowInstall:boolean;allowDelete:boolean;allowWriteOutside:boolean;confirmMode:'always'|'risk'|'session'|'never';
 sessionGrantTtlMin:number;timeoutSec:number;maxOutputKb:number;allowPatterns:string[];denyPatterns:string[];protectedPaths:string[];policyHash:string;
 owner?:TenantContext;
}
export interface LocalEnvironment {platform?:NodeJS.Platform;home?:string;uid?:number;workspace:string;repository:string;accounts:readonly TenantContext[];exists?:(path:string)=>boolean;}
export interface CommandRisk {kind:'block'|'confirm'|'allow';reason:string;capabilities:LocalCapability[];highRisk:boolean;}
export interface LocalShellArgs {command:string;cwd?:string;rootIndex?:number;timeoutSec?:number;}
export interface LocalExecutionAudit {taskId:string;tenant:TenantContext;decision:string;command?:string;cwd?:string;code?:number|null;durationMs?:number;risk?:string;capabilities?:LocalCapability[];}
