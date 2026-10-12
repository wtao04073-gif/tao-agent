import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { CustomExtensions, createCustomExtensionHandler, validateExtensionUI } from '../src/custom-extensions.ts';
import type { TaoExtensionDefinition, TaoExtensionAPI, TenantContext } from '@tao/core';

const tenant:TenantContext={tenantId:'tenant',workspaceId:'workspace',userId:'alice'};
const dirs:string[]=[];const registries:CustomExtensions[]=[];const servers:Server[]=[];
function directory(){const dir=mkdtempSync(join(tmpdir(),'tao-custom-extensions-'));dirs.push(dir);return dir;}
function registry(options:Partial<ConstructorParameters<typeof CustomExtensions>[0]&object>={}){const result=new CustomExtensions({stateDirectory:directory(),...options});registries.push(result);return result;}
const parameters={type:'object',properties:{n:{type:'number',minimum:0,maximum:10}},required:['n'],additionalProperties:false};
function definition(setup:(api:TaoExtensionAPI)=>void|Promise<void>,id='demo'):TaoExtensionDefinition{return {id,name:'演示',version:'1.0',setup};}
function command(api:TaoExtensionAPI,handler=vi.fn(async()=>({text:'完成'}))){api.registerCommand({name:'run',description:'执行演示',parameters,handler});return handler;}
async function token(r:CustomExtensions,args:unknown={n:2},t=tenant){const pending=await r.command(t,'demo:run',args);expect(pending).toMatchObject({confirmationRequired:true});return (pending as {confirmationId:string}).confirmationId;}
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}for(const r of registries.splice(0))await r.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

describe('受信部署扩展注册',()=>{
  it('注册失败不残留工具、命令或监听器，并逆序清理',async()=>{
    const r=registry(),calls:string[]=[];
    await expect(r.register(definition(api=>{api.onDispose(()=>{calls.push('first');});api.onDispose(()=>{calls.push('second');});command(api);command(api);}))).rejects.toThrow('重名');
    expect(r.list()).toEqual([]);expect(r.tools(tenant,'task','/tmp')).toEqual([]);expect(calls).toEqual(['second','first']);
  });
  it('拒绝扩展ID重名与不同ID产生的工具命名空间碰撞',async()=>{
    const r=registry(),tool=(name:string)=>({name,label:'演示',description:'演示',parameters,async execute(){return{text:'ok'};}});
    await r.register(definition(api=>api.registerTool(tool('b_c')),'a'));
    await expect(r.register(definition(api=>api.registerTool(tool('c')),'a_b'))).rejects.toThrow('命名空间');
    await expect(r.register(definition(()=>{},'a'))).rejects.toThrow('已注册');
  });
  it('工具默认确认，运行时校验参数和租户，停用后旧工具引用不可执行',async()=>{
    const r=registry(),execute=vi.fn(async()=>({text:'ok'}));
    await r.register(definition(api=>api.registerTool({name:'work',label:'演示',description:'演示',parameters,execute})));
    const tool=r.tools(tenant,'task','/tmp')[0]!;const input={args:{n:2},tenant,taskId:'task',report:()=>{},signal:new AbortController().signal};
    expect(r.policies()[0]).toMatchObject({tool:'ext_demo_work',requiresConfirm:true});
    await expect(tool.execute({...input,args:{n:'2'}})).rejects.toThrow('数字');
    await expect(tool.execute({...input,tenant:{...tenant,userId:'bob'}})).rejects.toThrow('上下文');
    await expect(tool.execute(input)).resolves.toEqual({text:'ok'});r.setEnabled('demo',false);
    await expect(tool.execute(input)).rejects.toThrow('停用');expect(execute).toHaveBeenCalledTimes(1);
  });

  it('工具执行返回伪造界面时拒绝，已取消信号不能启动工具',async()=>{
    const r=registry(),execute=vi.fn(async()=>({text:'ok',ui:{extensionId:'other',component:'panel',instanceId:'one',view:{type:'text',text:'bad'}}}));
    await r.register(definition(api=>{api.registerUI('panel',()=>({type:'text',text:'ok'}));api.registerTool({name:'work',label:'演示',description:'演示',parameters,execute:execute as any});}));
    const input={tenant,taskId:'task',args:{n:2},report:()=>{},signal:new AbortController().signal},tool=r.tools(tenant,'task','/tmp')[0]!;
    await expect(tool.execute(input)).rejects.toThrow('界面实例');
    const abort=new AbortController();abort.abort();await expect(tool.execute({...input,signal:abort.signal})).rejects.toThrow();expect(execute).toHaveBeenCalledTimes(1);
  });
  it('启停状态原子保存，重新注册恢复停用状态',async()=>{
    const stateDirectory=directory(),a=registry({stateDirectory});await a.register(definition(()=>{}));a.setEnabled('demo',false);
    const b=registry({stateDirectory});await b.register(definition(()=>{}));expect(b.list()[0]?.enabled).toBe(false);expect(readdirSync(stateDirectory)).toEqual(['extensions.json']);
  });
  it('未支持Schema在注册时拒绝，不静默忽略；严格拒绝多余和缺失参数',async()=>{
    const r=registry();await expect(r.register(definition(api=>api.registerCommand({name:'run',description:'演示',parameters:{type:'object',anyOf:[]},async handler(){return{};}})))).rejects.toThrow('字段');
    await r.register(definition(api=>{command(api);}));
    for(const args of [{},{n:11},{n:'2'},{n:2,extra:true},[]])await expect(r.command(tenant,'demo:run',args)).rejects.toThrow();
  });
});

describe('命令确认令牌',()=>{
  it('确认前零执行；绑定所有租户字段与参数；确认仅可消费一次',async()=>{
    const r=registry(),handler=vi.fn(async()=>({text:'完成'}));await r.register(definition(api=>{command(api,handler);}));const id=await token(r);expect(handler).not.toHaveBeenCalled();
    for(const foreign of [{...tenant,userId:'bob'},{...tenant,tenantId:'other'},{...tenant,workspaceId:'other'}])await expect(r.command(foreign,'demo:run',{n:2},id)).rejects.toThrow('不符');
    await expect(r.command(tenant,'demo:run',{n:3},id)).rejects.toThrow('不符');
    await expect(r.command(tenant,'demo:run',{n:2},id)).resolves.toEqual({text:'完成'});
    await expect(r.command(tenant,'demo:run',{n:2},id)).rejects.toThrow('失效');expect(handler).toHaveBeenCalledTimes(1);expect(handler.mock.calls[0]?.[1]?.tenant).toEqual(tenant);
  });
  it('停用再启用仍使旧令牌失效，过期令牌不可消费',async()=>{
    const r=registry({confirmationTtlMs:5});await r.register(definition(api=>{command(api);}));const first=await token(r);r.setEnabled('demo',false);r.setEnabled('demo',true);await expect(r.command(tenant,'demo:run',{n:2},first)).rejects.toThrow('失效');
    const expired=await token(r);await new Promise(resolve=>setTimeout(resolve,12));await expect(r.command(tenant,'demo:run',{n:2},expired)).rejects.toThrow('失效');
  });
  it('同一用户并发命令受限，另一个用户独立执行',async()=>{
    const r=registry();let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
    await r.register(definition(api=>{api.registerCommand({name:'run',description:'演示',parameters,async handler(_args,context){if(context.tenant.userId==='alice')await waiting;return{text:'ok'};}});}));
    const a=await token(r),b=await token(r),other={...tenant,userId:'bob'},c=await token(r,{n:2},other);const running=r.command(tenant,'demo:run',{n:2},a);
    await expect(r.command(tenant,'demo:run',{n:2},b)).rejects.toThrow('正在执行');await expect(r.command(other,'demo:run',{n:2},c)).resolves.toEqual({text:'ok'});release();await running;
  });
  it('界面只能引用当前扩展已注册命令，拒绝HTML、越界深度与超量节点',()=>{
    const commands=new Set(['demo:run']);expect(validateExtensionUI({type:'button',label:'执行',command:'demo:run'},'demo',commands)).toMatchObject({type:'button'});
    for(const view of [{type:'html',html:'<script>bad()</script>'},{type:'button',label:'执行',command:'foreign:run'},{type:'button',label:'执行',command:'demo:unknown'},{type:'text',text:'x',html:'bad'},{type:'card',title:'many',children:Array.from({length:201},()=>({type:'text',text:'x'}))}])expect(()=>validateExtensionUI(view,'demo',commands)).toThrow();
    let deep:unknown={type:'text',text:'leaf'};for(let i=0;i<10;i++)deep={type:'card',title:'deep',children:[deep]};expect(()=>validateExtensionUI(deep,'demo',commands)).toThrow();
  });
});

describe('生命周期与清单加载',()=>{
  it('订阅按顺序、失败和超时隔离，取消订阅有效，关闭逆序清理且幂等',async()=>{
    const log=vi.fn(),r=registry({lifecycleTimeoutMs:10,logger:log}),calls:string[]=[];let timeoutSignal:AbortSignal|undefined;
    await r.register(definition(api=>{api.on('session_start',()=>{calls.push('first');throw Error('secret error content');});api.on('session_start',(_event,context)=>{timeoutSignal=context.signal;return new Promise(()=>{});});const off=api.on('session_start',()=>{calls.push('unsubscribed');});off();api.on('session_start',()=>{calls.push('last');});api.onDispose(()=>{calls.push('dispose1');});api.onDispose(()=>{calls.push('dispose2');});}));
    await r.lifecycle({type:'session_start',taskId:'task'},{tenant,taskId:'task',signal:new AbortController().signal});expect(calls).toEqual(['first','last']);expect(timeoutSignal?.aborted).toBe(true);expect(JSON.stringify(log.mock.calls)).not.toContain('secret');expect(log).toHaveBeenCalledTimes(2);
    await r.close();await r.close();expect(calls).toEqual(['first','last','dispose2','dispose1']);
  });
  it('部署清单中的TS通过原生类型擦除加载，临时文件删除，示例返回注册UI',async()=>{
    const dir=directory();copyFileSync(resolve('extensions/example.ts'),join(dir,'example.ts'));writeFileSync(join(dir,'manifest.json'),JSON.stringify({extensions:[{entry:'example.ts',enabled:true}]}));
    const r=registry({directory:dir});await r.load();expect(r.list()[0]?.id).toBe('example');expect(readdirSync(dir).sort()).toEqual(['example.ts','manifest.json']);
    const pending=await r.command(tenant,'example:add',{a:1,b:2});const output=await r.command(tenant,'example:add',{a:1,b:2},(pending as {confirmationId:string}).confirmationId);expect(output).toMatchObject({text:'1 + 2 = 3',ui:{extensionId:'example',component:'result',view:{type:'card'}}});
    const outcome=await r.tools(tenant,'task','/tmp')[0]!.execute({tenant,taskId:'task',args:{a:2,b:3},signal:new AbortController().signal,report:()=>{}});expect(outcome).toMatchObject({text:'5',ui:{extensionId:'example',view:{type:'card'}}});
  });
  it('只加载清单列出的允许类型，拒绝目录穿越、绝对路径和符号链接逃逸',async()=>{
    const dir=directory(),outside=directory(),log=vi.fn();const source="export default {id:'outside',name:'外部',version:'1',setup(){}}";writeFileSync(join(outside,'external.mjs'),source);writeFileSync(join(dir,'unlisted.mjs'),source);symlinkSync(join(outside,'external.mjs'),join(dir,'escape.mjs'));mkdirSync(join(dir,'nested'));symlinkSync(outside,join(dir,'nested','link'));
    writeFileSync(join(dir,'manifest.json'),JSON.stringify({extensions:[{entry:'../external.mjs',enabled:true},{entry:join(outside,'external.mjs'),enabled:true},{entry:'escape.mjs',enabled:true},{entry:'nested/link/external.mjs',enabled:true}]}));
    const r=registry({directory:dir,logger:log});await r.load();expect(r.list()).toEqual([]);expect(log).toHaveBeenCalledTimes(4);
  });
});

describe('鉴权HTTP入口',()=>{
  it('接口复用鉴权，启停只准平台管理员，拒绝宿主源码上传与额外身份字段',async()=>{
    const r=registry();await r.register(definition(api=>{command(api);}));
    const handler=createCustomExtensionHandler({registry:r,authenticate:async req=>req.headers.authorization?{tenant,role:req.headers.authorization==='admin'?'PLATFORM_ADMIN':'MEMBER'}:undefined});
    const server=createServer((req,res)=>{void handler(req,res).then(handled=>{if(!handled){res.statusCode=404;res.end();}});});servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('address');const base='http://127.0.0.1:'+address.port;
    expect((await fetch(base+'/api/extensions')).status).toBe(401);
    expect((await fetch(base+'/api/control/extensions',{headers:{authorization:'member'}})).status).toBe(403);
    expect((await fetch(base+'/api/control/extensions',{method:'PATCH',headers:{authorization:'admin','content-type':'application/json'},body:JSON.stringify({id:'demo',enabled:false,entry:'evil.ts'})})).status).toBe(400);
    const list=await fetch(base+'/api/extensions',{headers:{authorization:'member'}});expect(list.headers.get('cache-control')).toBe('no-store');expect(await list.json()).toMatchObject({extensions:[{id:'demo',commands:[{name:'demo:run'}]}],commands:[{name:'demo:run',extensionId:'demo'}],components:[]});
    const post=(body:unknown)=>fetch(base+'/api/extensions/commands',{method:'POST',headers:{authorization:'member','content-type':'application/json'},body:JSON.stringify(body)});
    expect((await post({command:'demo:run',args:{n:2},tenantId:'other'})).status).toBe(400);
    const pending=await (await post({command:'demo:run',args:{n:2}})).json() as {confirmationId:string};expect(await (await post({command:'demo:run',args:{n:2},confirmationId:pending.confirmationId})).json()).toEqual({text:'完成'});
    expect((await fetch(base+'/api/control/extensions',{method:'PATCH',headers:{authorization:'admin','content-type':'application/json'},body:JSON.stringify({id:'demo',enabled:false})})).status).toBe(200);
  });
});
