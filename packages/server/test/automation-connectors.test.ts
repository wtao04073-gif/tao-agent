import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, createCipheriv, createHash } from 'node:crypto';
import { AutomationManager, nextAutomationTime, validateAutomationInput, type AutomationDeps } from '../src/automation.ts';
import { ConnectorManager } from '../src/connector-inbound.ts';
import { ExecutionRegistry } from '../src/execution-registry.ts';

const dirs: string[] = [];
const tenant = { tenantId:'t1',workspaceId:'w1',userId:'u1' };
const other = { ...tenant,userId:'u2' };
const input = { scenarioId:'general.free-task',fields:{query:'整理日报'} };
const secret = 'a'.repeat(32);
function fixture(extra: Partial<AutomationDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(),'tao-automation-')); dirs.push(dir);
  let now = Date.parse('2026-10-08T00:00:00Z');
  const submitTask = vi.fn(async()=>({taskId:'task-1',conversationId:'conversation-1'}));
  const deps: AutomationDeps = {dir,now:()=>now,submitTask,cancelTask:vi.fn(async()=>{}),getTask:()=>({status:'RUNNING'}),...extra};
  return {dir,deps,submitTask,manager:new AutomationManager(deps),advance:(ms:number)=>{now+=ms;}};
}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
describe('持久自动化',()=>{
  it('保留已选择的模型与技能包，但不接收外部租户和幂等键',()=>{
    const safe=validateAutomationInput({...input,modelId:'vision-model',skillPackageId:'office-skill',tenant:{tenantId:'evil'},idempotencyKey:'external'});
    expect(safe).toMatchObject({modelId:'vision-model',skillPackageId:'office-skill'});expect(safe).not.toHaveProperty('tenant');expect(safe).not.toHaveProperty('idempotencyKey');expect(()=>validateAutomationInput({...input,modelId:42})).toThrow('标识');
  });
  it('按IANA时区计算cron并跨越夏令时，拒绝无效与过密计划',()=>{
    const time = Date.parse('2026-10-08T00:00:00Z');
    expect(nextAutomationTime({kind:'cron',expression:'0 9 * * *',timezone:'Asia/Shanghai'},time)).toBe(Date.parse('2026-10-08T01:00:00Z'));
    expect(nextAutomationTime({kind:'cron',expression:'0 9 * * *',timezone:'America/New_York'},Date.parse('2026-11-01T00:00:00Z'))).toBe(Date.parse('2026-11-01T14:00:00Z'));
    expect(()=>nextAutomationTime({kind:'interval',everySeconds:1},time)).toThrow();
    expect(()=>nextAutomationTime({kind:'cron',expression:'* * * * * *',timezone:'Asia/Shanghai'},time)).toThrow();
  });
  it('重启补跑一次漏发计划，保存发生项与幂等键，暂停与账号隔离有效',async()=>{
    const f=fixture();const plan=f.manager.create(tenant,{name:'日报',input,schedule:{kind:'interval',everySeconds:60}});
    f.advance(600000);const recovered=new AutomationManager(f.deps);await recovered.tick();await recovered.tick();
    expect(f.submitTask).toHaveBeenCalledTimes(1);expect(f.submitTask.mock.calls[0]![1]).toMatchObject({idempotencyKey:expect.stringMatching(/^automation:/)});
    expect(recovered.history(tenant)).toHaveLength(1);expect(recovered.list(other)).toHaveLength(0);
    expect(()=>recovered.setEnabled(other,plan.id,false)).toThrow(); recovered.setEnabled(tenant,plan.id,false);f.advance(600000);await recovered.tick();expect(f.submitTask).toHaveBeenCalledTimes(1);
  });
  it('一次性任务只触发一次；立即运行返回真实任务且可取消',async()=>{
    const f=fixture();const plan=f.manager.create(tenant,{name:'一次',input,schedule:{kind:'once',at:'2026-10-08T00:01:00Z'}});f.advance(60000);await f.manager.tick();await f.manager.tick();expect(f.submitTask).toHaveBeenCalledTimes(1);expect(f.manager.list(tenant)[0]?.enabled).toBe(false);
    const run=await f.manager.runNow(tenant,plan.id);await f.manager.cancelOccurrence(tenant,run.id);expect(f.deps.cancelTask).toHaveBeenCalledWith(tenant,'task-1','用户取消自动化触发');
  });
  it('同一事件并发与重启不会重复提交；不确定失败不会自动重放',async()=>{
    const f=fixture();await Promise.all([f.manager.submitOccurrence(tenant,'source','event-1',input),f.manager.submitOccurrence(tenant,'source','event-1',input)]);
    const recovered=new AutomationManager(f.deps);await recovered.submitOccurrence(tenant,'source','event-1',input);expect(f.submitTask).toHaveBeenCalledTimes(1);
    const broken=fixture({submitTask:vi.fn(async()=>{throw new Error('failure')})});await broken.manager.submitOccurrence(tenant,'source','event-2',input);await broken.manager.tick();expect(broken.manager.history(tenant)[0]?.state).toBe('uncertain');expect(broken.deps.submitTask).toHaveBeenCalledTimes(1);
  });
  it('registry提交成功但发生项回写前重启时返回既有任务',async()=>{
    const f=fixture();const registry=new ExecutionRegistry(join(f.dir,'registry'));let calls=0;
    const submit=async(t:typeof tenant,i:typeof input)=>registry.submit(t,i,async()=>{calls++;return {taskId:'one',conversationId:'one'};});
    const manager=new AutomationManager({...f.deps,submitTask:submit});const occurrence=await manager.submitOccurrence(tenant,'source','same',input);
    const {writeFileSync}=await import('node:fs');writeFileSync(join(f.dir,'automation-occurrences',occurrence.id+'.json'),JSON.stringify({...occurrence,state:'submitting',taskId:undefined}));
    const recovered=new AutomationManager({...f.deps,submitTask:submit});await recovered.tick();expect(calls).toBe(1);expect(recovered.history(tenant)[0]?.taskId).toBe('one');
  });
  it('投递固定eventId签名，遵守Retry-After，重启恢复并支持取消',async()=>{
    const send=vi.fn().mockResolvedValueOnce(new Response('',{status:429,headers:{'Retry-After':'120'}})).mockResolvedValueOnce(new Response('',{status:200}));
    const f=fixture({getTask:()=>({status:'SUCCEEDED'}),fetch:send});await f.manager.submitOccurrence(tenant,'source','event',input,{url:'https://example.com/callback',secret});await f.manager.tick();expect(send).toHaveBeenCalledTimes(1);
    const init=send.mock.calls[0]![1];expect(init.headers['x-tao-signature']).toBe(createHmac('sha256',secret).update(init.headers['x-tao-timestamp']+'.'+init.body).digest('hex'));
    f.advance(60000);await f.manager.tick();expect(send).toHaveBeenCalledTimes(1);f.advance(60001);const recovered=new AutomationManager(f.deps);await recovered.tick();expect(send).toHaveBeenCalledTimes(2);expect(recovered.deliveriesFor(tenant)[0]?.state).toBe('delivered');
    expect(JSON.stringify(recovered.deliveriesFor(tenant))).not.toContain(secret);
  });
  it('等待人工确认不自动批准或投递完成',async()=>{
    const send=vi.fn();const f=fixture({getTask:()=>({status:'AWAIT_CONFIRM'}),fetch:send});await f.manager.submitOccurrence(tenant,'source','event',input,{url:'https://example.com/callback',secret});await f.manager.tick();expect(f.manager.history(tenant)[0]?.state).toBe('submitted');expect(send).not.toHaveBeenCalled();
  });
});
describe('签名连接器',()=>{
  it('签名校验、有效期、显式绑定与持久eventId去重；不信任传入租户',async()=>{
    const f=fixture();const c=new ConnectorManager(f.dir,f.manager,f.deps.now);const binding=c.create(tenant,{name:'回调',kind:'signed-webhook',externalUserId:'sender-1',credentials:{secret}});
    const raw=JSON.stringify({eventId:'e1',senderId:'sender-1',text:'整理日报',tenantId:'evil'});const timestamp=String(f.deps.now!()/1000);const headers={'x-tao-timestamp':timestamp,'x-tao-signature':createHmac('sha256',secret).update(timestamp+'.'+raw).digest('hex')};
    await c.receive(binding.id,raw,headers,new URLSearchParams(),'POST');await new ConnectorManager(f.dir,new AutomationManager(f.deps),f.deps.now).receive(binding.id,raw,headers,new URLSearchParams(),'POST');expect(f.submitTask).toHaveBeenCalledTimes(1);expect(f.submitTask.mock.calls[0]![0]).toEqual(tenant);
    await expect(c.receive(binding.id,raw,{...headers,'x-tao-signature':'bad'},new URLSearchParams(),'POST')).rejects.toThrow('签名');
    const bad=JSON.stringify({eventId:'e2',senderId:'other',text:'test'});await expect(c.receive(binding.id,bad,{...headers,'x-tao-signature':createHmac('sha256',secret).update(timestamp+'.'+bad).digest('hex')},new URLSearchParams(),'POST')).rejects.toThrow('绑定');
    f.advance(301000);await expect(c.receive(binding.id,raw,headers,new URLSearchParams(),'POST')).rejects.toThrow('过期');expect(JSON.stringify(c.list(tenant))).not.toContain(secret);
  });
  it('未配置凭据保持不可用，飞书challenge必须签名和验证token',async()=>{
    const f=fixture();const c=new ConnectorManager(f.dir,f.manager,f.deps.now);const empty=c.create(tenant,{name:'未配置',kind:'feishu',externalUserId:'open-1'});expect(empty.status).toBe('unconfigured');await expect(c.receive(empty.id,'{}',{},new URLSearchParams(),'POST')).rejects.toThrow('尚未配置');
    const b=c.create(tenant,{name:'飞书',kind:'feishu',externalUserId:'open-1',credentials:{verificationToken:'verify',encryptKey:secret}});const raw=JSON.stringify({type:'url_verification',token:'verify',challenge:'challenge'});const ts=String(f.deps.now!()/1000);const nonce='nonce';const headers={'x-lark-request-timestamp':ts,'x-lark-request-nonce':nonce,'x-lark-signature':createHash('sha256').update(ts+nonce+secret+raw).digest('hex')};expect(await c.receive(b.id,raw,headers,new URLSearchParams(),'POST')).toEqual({type:'json',value:{challenge:'challenge'}});
  });
  it('企业微信加密回调校验企业ID与发送人后提交任务',async()=>{
    const f=fixture();const c=new ConnectorManager(f.dir,f.manager,f.deps.now);const key=Buffer.alloc(32,1);const b=c.create(tenant,{name:'企微',kind:'wecom',externalUserId:'zhangsan',credentials:{token:'token',encodingAESKey:key.toString('base64').slice(0,-1),corpId:'corp'}});
    const xml='<xml><MsgId>123</MsgId><MsgType><![CDATA[text]]></MsgType><FromUserName><![CDATA[zhangsan]]></FromUserName><Content><![CDATA[日报]]></Content></xml>';const length=Buffer.alloc(4);length.writeUInt32BE(Buffer.byteLength(xml));const plain=Buffer.concat([Buffer.alloc(16),length,Buffer.from(xml),Buffer.from('corp')]);const pad=32-plain.length%32;const cipher=createCipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false);const encrypted=Buffer.concat([cipher.update(Buffer.concat([plain,Buffer.alloc(pad,pad)])),cipher.final()]).toString('base64');const timestamp=String(f.deps.now!()/1000);const query=new URLSearchParams({timestamp,nonce:'n',msg_signature:createHash('sha1').update(['token',timestamp,'n',encrypted].sort().join('')).digest('hex')});
    expect(await c.receive(b.id,'<xml><Encrypt><![CDATA['+encrypted+']]></Encrypt></xml>',{},query,'POST')).toEqual({type:'text',value:'success'});expect(f.submitTask).toHaveBeenCalledTimes(1);
  });
  it('飞书加密信封先校验原始签名，再解密与校验账号',async()=>{
    const f=fixture();const c=new ConnectorManager(f.dir,f.manager,f.deps.now);const b=c.create(tenant,{name:'飞书',kind:'feishu',externalUserId:'open-1',credentials:{verificationToken:'verify',encryptKey:secret}});
    const payload={header:{token:'verify',event_type:'im.message.receive_v1',event_id:'lark-1'},event:{sender:{sender_id:{open_id:'open-1'}},message:{message_type:'text',content:JSON.stringify({text:'日报'})}}};
    const iv=Buffer.alloc(16,1);const cipher=createCipheriv('aes-256-cbc',createHash('sha256').update(secret).digest(),iv);const raw=JSON.stringify({encrypt:Buffer.concat([iv,cipher.update(JSON.stringify(payload)),cipher.final()]).toString('base64')});const ts=String(f.deps.now!()/1000);const headers={'x-lark-request-timestamp':ts,'x-lark-request-nonce':'n','x-lark-signature':createHash('sha256').update(ts+'n'+secret+raw).digest('hex')};
    await c.receive(b.id,raw,headers,new URLSearchParams(),'POST');expect(f.submitTask).toHaveBeenCalledTimes(1);
  });
});
