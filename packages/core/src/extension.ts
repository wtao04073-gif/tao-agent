/** 平台扩展契约。受信部署代码；不依赖Pi或浏览器实现。 */
import type { PlatformTool } from './runner.ts';
import type { ToolPolicy } from './permission-gate.ts';
import type { TenantContext } from './tenant.ts';
import type { TaskEvent } from './events.ts';

export type ExtensionUINode =
 | {type:'text';text:string}
 | {type:'card';title:string;children:ExtensionUINode[]}
 | {type:'table';columns:string[];rows:(string|number|boolean|null)[][]}
 | {type:'progress';label:string;value:number;max:number}
 | {type:'form';title:string;command:string;fields:{name:string;label:string;type:'text'|'number'|'select';required?:boolean;options?:string[]}[];submitLabel?:string}
 | {type:'button';label:string;command:string;args?:Record<string,unknown>};
export interface ExtensionUI {extensionId:string;component:string;instanceId:string;view:ExtensionUINode;}
export interface ExtensionContext {readonly tenant:TenantContext;readonly taskId?:string;readonly signal:AbortSignal;readonly workspace?:string;}
export type ExtensionLifecycleName='session_start'|'session_end'|'before_prompt'|'after_prompt'|'before_tool'|'after_tool'|'task_event';
export interface ExtensionLifecycleEvent {readonly type:ExtensionLifecycleName;readonly taskId:string;readonly toolName?:string;readonly outcome?:'success'|'error';readonly event?:TaskEvent;}
export interface ExtensionCommand {name:string;description:string;parameters:Readonly<Record<string,unknown>>;handler:(args:Record<string,unknown>,context:ExtensionContext)=>Promise<{text?:string;ui?:ExtensionUI;prompt?:string}>;}
export interface ExtensionTool extends PlatformTool {policy?:Omit<ToolPolicy,'tool'>;}
export interface TaoExtensionAPI {
 registerTool(tool:ExtensionTool):void;
 registerCommand(command:ExtensionCommand):void;
 on(event:ExtensionLifecycleName,handler:(event:ExtensionLifecycleEvent,context:ExtensionContext)=>void|Promise<void>):()=>void;
 registerUI(name:string,render:(data:unknown)=>ExtensionUINode):void;
 renderUI(name:string,data:unknown,instanceId?:string):ExtensionUI;
 onDispose(dispose:()=>void|Promise<void>):void;
}
export interface TaoExtensionDefinition {id:string;name:string;version:string;setup:(api:TaoExtensionAPI)=>void|Promise<void>;}
export interface ExtensionRuntimeHooks {
 lifecycle:(event:ExtensionLifecycleEvent,context:ExtensionContext)=>Promise<void>;
}
