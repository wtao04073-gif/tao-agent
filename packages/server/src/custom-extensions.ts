/** 受信部署扩展与宿主同权限；超时是协作取消，不是代码沙箱。 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExtensionCommand, ExtensionContext, ExtensionLifecycleEvent, ExtensionLifecycleName, ExtensionTool, ExtensionUI, ExtensionUINode, PlatformTool, TaoExtensionAPI, TaoExtensionDefinition, TenantContext, ToolPolicy } from '@tao/core';
import type { Principal } from './app.ts';
import { readJsonBody, sendError, sendJson } from './app.ts';

const NAME = /^[a-z][a-z0-9_]{0,31}$/;
const LIFECYCLES = new Set<ExtensionLifecycleName>(['session_start','session_end','before_prompt','after_prompt','before_tool','after_tool','task_event']);
const MAX_BYTES = 64 * 1024;
type JsonObject = Record<string, unknown>;
type Subscription = { event: ExtensionLifecycleName; handler: (event: ExtensionLifecycleEvent, context: ExtensionContext) => void | Promise<void>; active: boolean };
type Entry = { id:string; name:string; version:string; enabled:boolean; generation:number; tools:Map<string,ExtensionTool>; commands:Map<string,ExtensionCommand>; ui:Map<string,(data:unknown)=>ExtensionUINode>; subscriptions:Subscription[]; disposals:(()=>void|Promise<void>)[] };
type Confirmation = { owner:string; hash:string; command:string; extensionId:string; generation:number; expiresAt:number };
export interface CustomExtensionsOptions {
  /** 通常传入 TAO_EXTENSION_DIR；省略时不加载任何宿主源码。 */
  directory?: string;
  /** 位于部署者指定 workspace 的 .admin-config 或 .extension-state 内。 */
  stateDirectory: string;
  logger?: (event:{extensionId:string;code:'load_failed'|'lifecycle_failed'|'dispose_failed'})=>void;
  lifecycleTimeoutMs?: number;
  confirmationTtlMs?: number;
}
export class ExtensionError extends Error {
  readonly status:number;
  constructor(status:number,message:string) { super(message); this.status=status; }
}
function fail(message:string):never {throw new ExtensionError(400,message);}
function object(value:unknown):value is JsonObject {return !!value && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));}
function text(value:unknown,max=4096):value is string {return typeof value==='string' && value.length<=max;}
function fields(value:JsonObject,allowed:string[]):void {if(Object.keys(value).some(key=>!allowed.includes(key)))fail('包含不支持的字段');}
/** JSON-only 并设总大小/深度限制，禁止函数、原型对象、循环与非有限数字。 */
function jsonCopy<T>(value:T):T {
  let nodes=0;
  const seen=new Set<object>();
  function visit(v:unknown,depth:number):void {
    if(++nodes>10000 || depth>20)fail('数据超出结构限制');
    if(v===null || typeof v==='boolean' || typeof v==='string')return;
    if(typeof v==='number' && Number.isFinite(v))return;
    if(typeof v!=='object' || (!Array.isArray(v)&&!object(v)) || seen.has(v))fail('仅支持纯 JSON 数据');
    seen.add(v);
    for(const [key,item] of Object.entries(v)) {if(['__proto__','prototype','constructor'].includes(key))fail('字段名称无效');visit(item,depth+1);}
    seen.delete(v);
  }
  visit(value,0);
  const encoded=JSON.stringify(value);
  if(Buffer.byteLength(encoded)>MAX_BYTES)fail('数据超过 64KB');
  return JSON.parse(encoded) as T;
}
function freeze<T>(value:T):T {if(value && typeof value==='object'){Object.freeze(value);for(const item of Object.values(value))freeze(item);}return value;}
/** 明确支持的严格 JSON Schema 子集；未知关键字在注册时拒绝，而非静默忽略。 */
function checkSchema(schema:unknown,root=true,depth=0):asserts schema is JsonObject {
  if(!object(schema)||depth>12)fail('参数 Schema 无效');
  fields(schema,['$schema','title','description','type','properties','required','additionalProperties','items','enum','const','minimum','maximum','exclusiveMinimum','exclusiveMaximum','minLength','maxLength','minItems','maxItems','pattern','default']);
  if(root && schema.type!=='object')fail('参数 Schema 须为 object');
  if(!['object','array','string','number','integer','boolean','null'].includes(String(schema.type)))fail('Schema 类型不支持');
  if(schema.enum!==undefined && (!Array.isArray(schema.enum)||!schema.enum.length))fail('Schema enum 无效');
  if(schema.type==='object') {
    if(schema.properties!==undefined&&!object(schema.properties))fail('Schema properties 无效');
    const properties=(schema.properties??{}) as JsonObject;
    if(schema.additionalProperties!==undefined&&typeof schema.additionalProperties!=='boolean')fail('Schema additionalProperties 无效');
    if(schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.some(x=>typeof x!=='string'||!Object.hasOwn(properties,x))))fail('Schema required 无效');
    for(const item of Object.values(properties))checkSchema(item,false,depth+1);
  }
  if(schema.type==='array')checkSchema(schema.items,false,depth+1);
  if(schema.pattern!==undefined) {if(typeof schema.pattern!=='string'||schema.pattern.length>256)fail('Schema pattern 无效');try{new RegExp(schema.pattern,'u');}catch{fail('Schema pattern 无效');}}
  for(const key of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum','minLength','maxLength','minItems','maxItems']) {
    if(schema[key]!==undefined && (typeof schema[key]!=='number'||!Number.isFinite(schema[key])))fail('Schema 数值限制无效');
  }
}
function validate(schema:JsonObject,value:unknown):void {
  if(schema.enum!==undefined && !(schema.enum as unknown[]).some(x=>canonical(x)===canonical(value)))fail('参数不在允许值中');
  if(Object.hasOwn(schema,'const') && canonical(schema.const)!==canonical(value))fail('参数常量不匹配');
  if(schema.type==='object') {
    if(!object(value))fail('参数应为对象');
    const properties=(schema.properties??{}) as JsonObject;
    for(const name of (schema.required??[]) as string[])if(!Object.hasOwn(value,name))fail('缺少必填参数');
    for(const [key,item] of Object.entries(value)) {
      if(!Object.hasOwn(properties,key)){if(schema.additionalProperties!==true)fail('存在未声明参数');}
      else validate(properties[key] as JsonObject,item);
    }
  } else if(schema.type==='array') {
    if(!Array.isArray(value))fail('参数应为数组');
    if(value.length>Number(schema.maxItems??1000)||value.length<Number(schema.minItems??0))fail('数组长度不符');
    for(const item of value)validate(schema.items as JsonObject,item);
  } else if(schema.type==='string') {
    if(typeof value!=='string'||value.length>Number(schema.maxLength??MAX_BYTES)||value.length<Number(schema.minLength??0))fail('字符串参数无效');
    if(typeof schema.pattern==='string'&&!new RegExp(schema.pattern,'u').test(value))fail('字符串格式不符');
  } else if(schema.type==='number'||schema.type==='integer') {
    if(typeof value!=='number'||!Number.isFinite(value)||(schema.type==='integer'&&!Number.isInteger(value)))fail('数字参数无效');
    if(value<Number(schema.minimum??-Infinity)||value>Number(schema.maximum??Infinity)||value<=Number(schema.exclusiveMinimum??-Infinity)||value>=Number(schema.exclusiveMaximum??Infinity))fail('数字超出范围');
  } else if(schema.type==='boolean' ? typeof value!=='boolean' : value!==null)fail('参数类型不符');
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
function owner(tenant:TenantContext):string {return JSON.stringify([tenant.tenantId,tenant.workspaceId,tenant.userId]);}

/** 声明式节点不存在 HTML/脚本插槽，操作只引用本扩展的已注册命令。 */
export function validateExtensionUI(value:unknown,extensionId:string,commands:ReadonlySet<string>):ExtensionUINode {
  const view=jsonCopy(value);let count=0;
  function command(name:unknown):void {if(typeof name!=='string'||!name.startsWith(extensionId+':')||!commands.has(name))fail('界面操作须指向本扩展已注册命令');}
  function node(v:unknown,depth:number):void {
    if(!object(v)||depth>8||++count>200)fail('界面节点超出限制');
    const label=(x:unknown,max=4096)=>{if(!text(x,max))fail('界面文字无效');};
    switch(v.type) {
      case 'text':fields(v,['type','text']);label(v.text);break;
      case 'card':fields(v,['type','title','children']);label(v.title,256);if(!Array.isArray(v.children))fail('卡片内容无效');v.children.forEach(x=>node(x,depth+1));break;
      case 'table':fields(v,['type','columns','rows']);if(!Array.isArray(v.columns)||v.columns.length>20||!v.columns.length||v.columns.some(x=>!text(x,256))||!Array.isArray(v.rows)||v.rows.length>100)fail('表格无效');for(const row of v.rows)if(!Array.isArray(row)||row.length!==v.columns.length||row.some(x=>x!==null&&!['string','number','boolean'].includes(typeof x)))fail('表格行无效');break;
      case 'progress':fields(v,['type','label','value','max']);label(v.label,256);if(typeof v.value!=='number'||typeof v.max!=='number'||v.max<=0||v.value<0||v.value>v.max)fail('进度无效');break;
      case 'button':fields(v,['type','label','command','args']);label(v.label,256);command(v.command);if(v.args!==undefined&&!object(v.args))fail('按钮参数无效');break;
      case 'form':fields(v,['type','title','command','fields','submitLabel']);label(v.title,256);command(v.command);if(v.submitLabel!==undefined)label(v.submitLabel,256);if(!Array.isArray(v.fields)||v.fields.length>20)fail('表单字段无效');{
        const names=new Set<string>();
        for(const field of v.fields){if(!object(field))fail('表单字段无效');fields(field,['name','label','type','required','options']);if(typeof field.name!=='string'||!NAME.test(field.name)||names.has(field.name))fail('表单字段名称无效');names.add(field.name);label(field.label,256);if(!['text','number','select'].includes(String(field.type))||(field.required!==undefined&&typeof field.required!=='boolean'))fail('表单字段类型无效');if(field.type==='select'&&(!Array.isArray(field.options)||!field.options.length||field.options.length>50||field.options.some(x=>!text(x,256))))fail('表单选项无效');}
      }break;
      default:fail('界面类型不支持');
    }
  }
  node(view,0);return view as ExtensionUINode;
}

export class CustomExtensions {
  private readonly entries=new Map<string,Entry>();
  private readonly confirmations=new Map<string,Confirmation>();
  private readonly inFlight=new Set<string>();
  private readonly stop=new AbortController();
  private readonly statePath:string;
  private readonly options:CustomExtensionsOptions;
  private state:Record<string,boolean>={};
  private loaded=false;
  private closed=false;
  constructor(input:CustomExtensionsOptions|string) {
    const options:CustomExtensionsOptions=typeof input==='string'?{stateDirectory:join(input,'.extension-state')}:input;
    this.options=options;
    mkdirSync(options.stateDirectory,{recursive:true,mode:0o700});
    this.statePath=join(realpathSync(options.stateDirectory),'extensions.json');
    if(existsSync(this.statePath)){
      if(lstatSync(this.statePath).isSymbolicLink())fail('扩展状态文件无效');
      const state:unknown=JSON.parse(readFileSync(this.statePath,'utf8'));
      if(!object(state)||Object.entries(state).some(([id,value])=>!NAME.test(id)||typeof value!=='boolean'))fail('扩展状态文件无效');
      this.state=state as Record<string,boolean>;
    }
  }
  static async load(options:CustomExtensionsOptions):Promise<CustomExtensions> {const registry=new CustomExtensions(options);await registry.load();return registry;}
  private log(id:string,code:'load_failed'|'lifecycle_failed'|'dispose_failed'):void {try{this.options.logger?.({extensionId:id,code});}catch{/* 日志不影响运行。 */}}
  private safeFile(root:string,entry:string):string {
    if(!entry||isAbsolute(entry)||entry.includes('\\')||entry.split('/').some(x=>x==='..'||x==='.'||!x))fail('扩展入口路径无效');
    const path=resolve(root,entry),rel=relative(root,path);
    if(rel.startsWith('..'+sep)||rel==='..'||isAbsolute(rel))fail('扩展入口不能离开部署目录');
    let current=root;for(const part of rel.split(sep)){current=join(current,part);if(lstatSync(current).isSymbolicLink())fail('扩展入口不允许符号链接');}
    if(!lstatSync(path).isFile()||lstatSync(path).size>1024*1024)fail('扩展入口文件无效');
    return path;
  }
  async load(directory?:string):Promise<void> {
    if(this.loaded||this.closed)throw new ExtensionError(409,'扩展注册表不可重复加载');
    this.loaded=true;
    const source=directory??this.options.directory;
    if(!source||!existsSync(join(source,'manifest.json')))return;
    const root=realpathSync(source);
    const manifest:unknown=JSON.parse(readFileSync(this.safeFile(root,'manifest.json'),'utf8'));
    if(!object(manifest)||!Array.isArray(manifest.extensions)||manifest.extensions.length>100)fail('扩展部署清单无效');
    fields(manifest,['extensions']);
    const seen=new Set<string>();
    for(const item of manifest.extensions) {
      try {
        if(!object(item)||typeof item.entry!=='string'||typeof item.enabled!=='boolean')fail('扩展清单条目无效');
        fields(item,['entry','enabled']);
        const file=this.safeFile(root,item.entry);
        if(!['.ts','.js','.mjs'].includes(extname(file))||seen.has(file))fail('扩展入口类型或重复条目无效');
        seen.add(file);
        let target=file;
        if(extname(file)==='.ts') {
          // 仅擦除类型；enum、namespace、JSX、路径别名等需部署者预编译。
          const code=stripTypeScriptTypes(readFileSync(file,'utf8'),{mode:'strip',sourceUrl:pathToFileURL(file).href});
          target=join(dirname(file),'.tao-extension-'+randomUUID()+'.mjs');
          writeFileSync(target,code,{flag:'wx',mode:0o600});
        }
        try {
          const module=await import(/* @vite-ignore */ pathToFileURL(target).href+'?load='+randomUUID());
          await this.register(module.default as TaoExtensionDefinition,item.enabled);
        } finally {if(target!==file)unlinkSync(target);}
      } catch {this.log('deployment','load_failed');}
    }
  }
  /** 仅供宿主及受信部署入口调用，HTTP 不暴露注册或文件上传。 */
  async register(definition:TaoExtensionDefinition,enabled=true):Promise<void> {
    if(this.closed||!definition||(typeof definition.id!=='string'||!NAME.test(definition.id))||!text(definition.name,128)||!text(definition.version,64)||typeof definition.setup!=='function')fail('扩展定义无效');
    if(this.entries.has(definition.id))fail('扩展标识已注册');
    const entry:Entry={id:definition.id,name:definition.name,version:definition.version,enabled:Object.hasOwn(this.state,definition.id)?this.state[definition.id]!:enabled,generation:0,tools:new Map(),commands:new Map(),ui:new Map(),subscriptions:[],disposals:[]};
    let registering=true;
    const assertRegistration=()=>{if(!registering)fail('只能在 setup 中注册');};
    const name=(value:string)=>{if(typeof value!=='string'||!NAME.test(value))fail('扩展能力名称无效');};
    const api:TaoExtensionAPI={
      registerTool:tool=>{assertRegistration();name(tool.name);if(entry.tools.has(tool.name)||typeof tool.execute!=='function'||!text(tool.description)||!text(tool.label,256))fail('工具注册无效或重名');const parameters=jsonCopy(tool.parameters);checkSchema(parameters);if(tool.policy!==undefined){if(!object(tool.policy))fail('工具策略无效');fields(tool.policy,['pathParams','requiresConfirm','confirmReason']);if(tool.policy.requiresConfirm!==undefined&&typeof tool.policy.requiresConfirm!=='boolean')fail('工具确认策略无效');if(tool.policy.confirmReason!==undefined&&!text(tool.policy.confirmReason))fail('工具确认说明无效');if(tool.policy.pathParams!==undefined&&(!Array.isArray(tool.policy.pathParams)||tool.policy.pathParams.some(value=>typeof value!=='string')))fail('工具路径策略无效');}entry.tools.set(tool.name,{...tool,parameters:freeze(parameters),...(tool.policy?{policy:freeze(jsonCopy(tool.policy))}:{})});},
      registerCommand:command=>{assertRegistration();name(command.name);if(entry.commands.has(command.name)||typeof command.handler!=='function'||!text(command.description))fail('命令注册无效或重名');const parameters=jsonCopy(command.parameters);checkSchema(parameters);entry.commands.set(command.name,{...command,parameters:freeze(parameters)});},
      on:(event,handler)=>{assertRegistration();if(!LIFECYCLES.has(event)||typeof handler!=='function')fail('生命周期订阅无效');const subscription={event,handler,active:true};entry.subscriptions.push(subscription);return ()=>{subscription.active=false;};},
      registerUI:(component,render)=>{assertRegistration();name(component);if(entry.ui.has(component)||typeof render!=='function')fail('界面组件注册无效或重名');entry.ui.set(component,render);},
      renderUI:(component,data,instanceId=randomUUID())=>{const render=entry.ui.get(component);if(!render||!text(instanceId,128)||!instanceId)fail('界面组件不存在或实例无效');return {extensionId:entry.id,component,instanceId,view:validateExtensionUI(render(jsonCopy(data)),entry.id,new Set([...entry.commands.keys()].map(x=>entry.id+':'+x)))};},
      onDispose:dispose=>{assertRegistration();if(typeof dispose!=='function')fail('清理函数无效');entry.disposals.push(dispose);},
    };
    try {
      await this.bounded(()=>definition.setup(api),this.stop.signal);
      if(this.entries.has(entry.id)||this.closed)fail('扩展标识已注册或注册表已关闭');
      const names=new Set([...this.entries.values()].flatMap(item=>[...item.tools.keys()].map(name=>`ext_${item.id}_${name}`)));
      if([...entry.tools.keys()].some(name=>names.has(`ext_${entry.id}_${name}`)))fail('工具命名空间冲突');
      this.entries.set(entry.id,entry);
    } catch(error) {for(const dispose of [...entry.disposals].reverse())try{await this.bounded(()=>dispose());}catch{this.log(entry.id,'dispose_failed');}throw error;}
    finally {registering=false;}
  }
  list(_tenant?:TenantContext) {return [...this.entries.values()].map(entry=>({id:entry.id,name:entry.name,version:entry.version,enabled:entry.enabled,tools:[...entry.tools.values()].map(tool=>({name:`ext_${entry.id}_${tool.name}`,label:tool.label,description:tool.description})),commands:entry.enabled?[...entry.commands.values()].map(command=>({name:entry.id+':'+command.name,description:command.description,parameters:jsonCopy(command.parameters)})):[],ui:entry.enabled?[...entry.ui.keys()].map(name=>({name})):[],components:[...entry.ui.keys()].map(name=>({name,extensionId:entry.id}))}));}
  tools(tenant:TenantContext,taskId:string,_workspace:string):PlatformTool[] {
    return [...this.entries.values()].filter(entry=>entry.enabled).flatMap(entry=>[...entry.tools.values()].map(tool=>({name:`ext_${entry.id}_${tool.name}`,label:tool.label,description:tool.description,parameters:tool.parameters,replay:tool.replay??'never',execute:async(input:Parameters<PlatformTool['execute']>[0])=>{
      if(this.closed||!entry.enabled)throw new ExtensionError(409,'扩展已停用');
      if(owner(input.tenant)!==owner(tenant)||input.taskId!==taskId)throw new ExtensionError(403,'扩展工具上下文不符');
      const args=jsonCopy(input.args);validate(tool.parameters,args);
      const signal=AbortSignal.any([input.signal,this.stop.signal]);signal.throwIfAborted();
      const result=await tool.execute({...input,args,tenant:freeze({...tenant}),signal});
      if(!text(result.text,MAX_BYTES))fail('工具返回文本无效');
      const ui=result.ui===undefined?undefined:this.checkUI(entry,jsonCopy(result.ui));
      if(result.details!==undefined){const details=jsonCopy(result.details);if(object(details)&&details.extensionUI!==undefined)this.checkUI(entry,details.extensionUI);return {...result,details,...(ui?{ui}:{})};}
      return {...result,...(ui?{ui}:{})};
    }})));
  }
  policies(_tenant?:TenantContext):ToolPolicy[] {return [...this.entries.values()].filter(entry=>entry.enabled).flatMap(entry=>[...entry.tools.values()].map(tool=>({...tool.policy,tool:`ext_${entry.id}_${tool.name}`,requiresConfirm:tool.policy?.requiresConfirm??true,confirmReason:tool.policy?.confirmReason??`请确认执行扩展 ${entry.name} 的 ${tool.label}`})));}
  setEnabled(id:string,enabled:boolean):void {
    const entry=this.entries.get(id);if(!entry)throw new ExtensionError(404,'扩展不存在');if(typeof enabled!=='boolean')fail('启停值无效');
    const next={...this.state,[id]:enabled},temp=this.statePath+'.'+randomUUID()+'.tmp';
    try{writeFileSync(temp,JSON.stringify(next),{flag:'wx',mode:0o600});renameSync(temp,this.statePath);}finally{if(existsSync(temp))unlinkSync(temp);}
    this.state=next;entry.enabled=enabled;entry.generation++;
    for(const [token,confirmation] of this.confirmations)if(confirmation.extensionId===id)this.confirmations.delete(token);
  }
  private async bounded<T>(run:(signal:AbortSignal)=>Promise<T>|T,parent?:AbortSignal):Promise<T> {
    const controller=new AbortController();const signal=parent?AbortSignal.any([parent,controller.signal]):controller.signal;
    const timeout=setTimeout(()=>controller.abort(),Math.min(2000,Math.max(1,this.options.lifecycleTimeoutMs??2000)));
    if(signal.aborted){clearTimeout(timeout);throw new ExtensionError(408,'扩展操作已取消或超时');}
    let abort:()=>void=()=>{};
    const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(new ExtensionError(408,'扩展操作已取消或超时'));signal.addEventListener('abort',abort,{once:true});});
    try {if(signal.aborted)throw new ExtensionError(408,'扩展操作已取消或超时');return await Promise.race([Promise.resolve().then(()=>run(signal)),cancelled]);}
    finally {clearTimeout(timeout);signal.removeEventListener('abort',abort);}
  }
  async lifecycle(event:ExtensionLifecycleEvent,context:ExtensionContext):Promise<void> {
    const lifecycleSignal=AbortSignal.any([context.signal,this.stop.signal,AbortSignal.timeout(Math.min(2000,Math.max(1,this.options.lifecycleTimeoutMs??2000)))]);
    if(this.closed||lifecycleSignal.aborted)return;
    for(const entry of this.entries.values())for(const subscription of entry.subscriptions) {
      if(this.closed||lifecycleSignal.aborted)return;
      if(!entry.enabled||!subscription.active||subscription.event!==event.type)continue;
      try{await this.bounded(signal=>subscription.handler(freeze(jsonCopy(event)),Object.freeze({...context,tenant:freeze({...context.tenant}),signal})),lifecycleSignal);}
      catch{this.log(entry.id,'lifecycle_failed');}
    }
  }
  private checkUI(entry:Entry,value:unknown):ExtensionUI {
    if(!object(value))fail('界面实例无效');fields(value,['extensionId','component','instanceId','view']);
    if(value.extensionId!==entry.id||typeof value.component!=='string'||!entry.ui.has(value.component)||!text(value.instanceId,128)||!value.instanceId)fail('界面实例无效');
    return {extensionId:entry.id,component:value.component,instanceId:value.instanceId,view:validateExtensionUI(value.view,entry.id,new Set([...entry.commands.keys()].map(x=>entry.id+':'+x)))};
  }
  async command(tenant:TenantContext,name:string,input:unknown,confirmationId?:string,signal:AbortSignal=new AbortController().signal):Promise<{confirmationRequired:true;confirmationId:string;description:string;reason:string}|{text?:string;ui?:ExtensionUI;prompt?:string}> {
    const [id,local,...rest]=name.split(':'),entry=this.entries.get(id??''),command=entry?.commands.get(local??'');
    if(!entry?.enabled||!command||rest.length||this.closed)throw new ExtensionError(404,'命令不存在或扩展已停用');
    const args=jsonCopy(input);validate(command.parameters,args);
    const key=owner(tenant),hash=createHash('sha256').update(canonical(args)).digest('hex'),now=Date.now();
    for(const [token,pending] of this.confirmations)if(pending.expiresAt<=now)this.confirmations.delete(token);
    if(!confirmationId) {
      if(this.confirmations.size>=10000||[...this.confirmations.values()].filter(x=>x.owner===key).length>=16)throw new ExtensionError(429,'待确认命令过多');
      const token=randomUUID();this.confirmations.set(token,{owner:key,hash,command:name,extensionId:entry.id,generation:entry.generation,expiresAt:now+Math.min(300000,Math.max(1,this.options.confirmationTtlMs??60000))});
      return {confirmationRequired:true,confirmationId:token,description:command.description,reason:command.description};
    }
    const pending=this.confirmations.get(confirmationId);
    if(!pending||pending.owner!==key||pending.hash!==hash||pending.command!==name||pending.generation!==entry.generation||pending.expiresAt<=now)throw new ExtensionError(409,'确认已失效或与当前请求不符');
    if(this.inFlight.has(key))throw new ExtensionError(429,'已有扩展命令正在执行');
    if(signal.aborted)throw new ExtensionError(408,'命令已取消');
    this.confirmations.delete(confirmationId);this.inFlight.add(key);
    try {
      // 同步消费确认后才进入处理器；生命周期通知无权改变这里的授权结果。
      const result=await command.handler(args as JsonObject,Object.freeze({tenant:freeze({...tenant}),signal:AbortSignal.any([signal,this.stop.signal])}));
      const output=jsonCopy(result);if(!object(output))fail('命令返回无效');fields(output,['text','ui','prompt']);
      if(output.text!==undefined&&!text(output.text,MAX_BYTES))fail('命令文本无效');if(output.prompt!==undefined&&!text(output.prompt,16000))fail('命令提示无效');
      return {...(typeof output.text==='string'?{text:output.text}:{}),...(typeof output.prompt==='string'?{prompt:output.prompt}:{}),...(output.ui!==undefined?{ui:this.checkUI(entry,output.ui)}:{})};
    } finally {this.inFlight.delete(key);}
  }
  async close():Promise<void> {if(this.closed)return;this.closed=true;this.stop.abort();this.confirmations.clear();for(const entry of [...this.entries.values()].reverse())for(const dispose of [...entry.disposals].reverse())try{await this.bounded(()=>dispose());}catch{this.log(entry.id,'dispose_failed');}}
}

/** 由宿主在 Origin 校验后挂载；authenticate 复用宿主 Cookie/CSRF 校验。 */
export function createCustomExtensionHandler(deps:({registry:CustomExtensions;extensions?:never}|{extensions:CustomExtensions;registry?:never})&{authenticate:(req:IncomingMessage)=>Promise<Principal|undefined>}) {
  const registry=deps.registry??deps.extensions;
  const catalog=(tenant:TenantContext)=>{const extensions=registry.list(tenant);return {extensions,commands:extensions.filter(entry=>entry.enabled).flatMap(entry=>entry.commands.map(command=>({...command,extensionId:entry.id}))),components:extensions.filter(entry=>entry.enabled).flatMap(entry=>entry.components)};};
  return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    const path=new URL(req.url??'/','http://localhost').pathname;
    if(!['/api/extensions','/api/extensions/commands','/api/control/extensions'].includes(path))return false;
    res.setHeader('Cache-Control','no-store');
    try {
      const principal=await deps.authenticate(req);if(!principal)throw new ExtensionError(401,'请先登录');
      if(path==='/api/control/extensions'&&principal.role!=='PLATFORM_ADMIN')throw new ExtensionError(403,'需要平台管理员权限');
      if(req.method==='GET'&&path!=='/api/extensions/commands')sendJson(res,200,catalog(principal.tenant));
      else if((path==='/api/extensions/commands'&&req.method==='POST')||(path==='/api/control/extensions'&&req.method==='PATCH')) {
        const body=await readJsonBody(req,MAX_BYTES);if(!body.ok||!object(body.value))fail('请求 JSON 无效');
        if(path==='/api/control/extensions') {fields(body.value,['id','enabled']);if(typeof body.value.id!=='string'||typeof body.value.enabled!=='boolean')fail('请提供扩展标识和启停状态');registry.setEnabled(body.value.id,body.value.enabled);sendJson(res,200,catalog(principal.tenant));}
        else {fields(body.value,['command','args','confirmationId']);if(typeof body.value.command!=='string'||!object(body.value.args)||(body.value.confirmationId!==undefined&&typeof body.value.confirmationId!=='string'))fail('命令参数无效');const controller=new AbortController();const cancel=()=>controller.abort();res.on('close',cancel);try{sendJson(res,200,await registry.command(principal.tenant,body.value.command,body.value.args,body.value.confirmationId as string|undefined,controller.signal));}finally{res.off('close',cancel);}}
      } else throw new ExtensionError(405,'不支持的操作');
    } catch(error) {sendError(res,error instanceof ExtensionError?error.status:500,error instanceof ExtensionError?error.message:'扩展操作失败');}
    return true;
  };
}
