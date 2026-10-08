import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {AutomationManager,type AutomationOutbox} from '../src/automation.ts';
import {ConnectorManager} from '../src/connector-inbound.ts';
import {NativeConnectorSender,type NativeConnectorDelivery} from '../src/connector-outbound.ts';
import {AutomationStore} from '../src/automation-store.ts';
const tenant={tenantId:'t',workspaceId:'w',userId:'u'};
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const credentials={verificationToken:'verify-token',encryptKey:'encrypt-key',appId:'app-id',appSecret:'private-app-secret'};
const target:NativeConnectorDelivery={kind:'feishu',recipient:'open-user',appId:credentials.appId,appSecret:credentials.appSecret};
const eventBody=JSON.stringify({taskId:'task1',status:'SUCCEEDED',result:{text:'报告已生成',artifacts:['report.xlsx']},recipient:'@all'});
function setup(fetcher:typeof fetch){
  const dir=mkdtempSync(join(tmpdir(),'tao-native-im-'));dirs.push(dir);let now=Date.parse('2026-10-08T00:00:00Z');
  const deps={dir,fetch:fetcher,now:()=>now,submitTask:vi.fn(async()=>({taskId:'task1',conversationId:'c1'})),cancelTask:vi.fn(async()=>{}),getTask:()=>({status:'SUCCEEDED'}),getResult:()=>({text:'报告已生成',artifacts:['report.xlsx']})};
  const manager=new AutomationManager(deps);const connectors=new ConnectorManager(dir,manager,deps.now);
  const receive=async(id:string,eventId='e1')=>{const raw=JSON.stringify({header:{token:credentials.verificationToken,event_type:'im.message.receive_v1',event_id:eventId},event:{sender:{sender_id:{open_id:'open-user'}},message:{message_type:'text',content:JSON.stringify({text:'生成报告',receive_id:'@all'})}}});const timestamp=String(now/1000);return connectors.receive(id,raw,{'x-lark-request-timestamp':timestamp,'x-lark-request-nonce':'n','x-lark-signature':createHash('sha256').update(timestamp+'n'+credentials.encryptKey+raw).digest('hex')},new URLSearchParams(),'POST');};
  return{dir,deps,manager,connectors,receive,advance:(ms:number)=>{now+=ms;}};
}
describe('原生IM结果回发（全部注入模拟fetch）',()=>{
  it('飞书原生API向固定open_id私聊；成功发送不因重复事件或重启重发',async()=>{
    const sends:Record<string,any>[]=[];let tokens=0;const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{if(String(url).includes('/auth/')){tokens++;return Response.json({code:0,tenant_access_token:'cached-token',expire:7200});}expect(String(url)).toBe('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id');sends.push(JSON.parse(String(init?.body)));return Response.json({code:0,data:{message_id:'message1'}});}) as unknown as typeof fetch;
    const f=setup(fetcher);const b=f.connectors.create(tenant,{name:'飞书',kind:'feishu',externalUserId:'open-user',credentials});expect(b.nativeDeliveryStatus).toBe('configured');await f.receive(b.id);await f.manager.tick();await f.receive(b.id);await new AutomationManager(f.deps).tick();
    expect(sends).toHaveLength(1);expect(tokens).toBe(1);expect(sends[0]?.receive_id).toBe('open-user');expect(sends[0]?.msg_type).toBe('text');expect(JSON.parse(sends[0]!.content).text).toContain('报告已生成');expect(sends[0]?.uuid).toHaveLength(48);expect(f.manager.deliveriesFor(tenant)[0]?.state).toBe('delivered');expect(f.manager.deliveriesFor(tenant)[0]?.channel).toBe('feishu');
    for(const collection of ['connector-bindings','automation-occurrences','automation-outbox'])for(const file of readdirSync(join(f.dir,collection))){const disk=readFileSync(join(f.dir,collection,file),'utf8');expect(disk).not.toContain(credentials.appSecret);expect(disk).not.toContain('cached-token');}
  });
  it('企微gettoken与message/send固定成员；访问令牌失效只刷新一次',async()=>{
    let tokens=0;const messages:Record<string,any>[]=[];const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{if(String(url).includes('/gettoken?')){tokens++;return Response.json({errcode:0,access_token:'token-'+tokens,expires_in:7200});}messages.push(JSON.parse(String(init?.body)));expect(new URL(String(url)).pathname).toBe('/cgi-bin/message/send');return messages.length===1?Response.json({errcode:42001}):Response.json({errcode:0,msgid:'message1'});}) as unknown as typeof fetch;
    const sender=new NativeConnectorSender({fetch:fetcher});const response=await sender.send({kind:'wecom',recipient:'zhangsan',corpId:'corp',corpSecret:'private-corp-secret',agentId:'1000001'},eventBody,'same-event',new AbortController().signal);
    expect(response.ok).toBe(true);expect(tokens).toBe(2);expect(messages).toHaveLength(2);expect(messages[0]).toMatchObject({touser:'zhangsan',agentid:1000001,msgtype:'text',enable_duplicate_check:1,duplicate_check_interval:1800});expect(messages[0]).not.toHaveProperty('toparty');expect(messages[0]).not.toHaveProperty('totag');expect(messages[0]?.text.content).toContain('报告已生成');
  });
  it('缓存令牌仅在内存，过期刷新；消息长度按企微字节上限截断',async()=>{
    let now=0,tokens=0;const messages:Record<string,any>[]=[];const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{if(String(url).includes('/gettoken?')){tokens++;return Response.json({errcode:0,access_token:'token-'+tokens,expires_in:120});}messages.push(JSON.parse(String(init?.body)));return Response.json({errcode:0});}) as unknown as typeof fetch;
    const sender=new NativeConnectorSender({fetch:fetcher,now:()=>now});const t:NativeConnectorDelivery={kind:'wecom',recipient:'user1',corpId:'corp',corpSecret:'secret',agentId:'1'};const body=JSON.stringify({taskId:'task',status:'SUCCEEDED',result:{text:'你好'.repeat(3000)}});
    await sender.send(t,body,'e1',new AbortController().signal);await sender.send(t,body,'e2',new AbortController().signal);expect(tokens).toBe(1);now=61000;await sender.send(t,body,'e3',new AbortController().signal);expect(tokens).toBe(2);expect(Buffer.byteLength(messages[0]?.text.content)).toBeLessThanOrEqual(2048);expect(messages[0]?.text.content).toContain('内容已截断');
  });
  it('拒绝广播和多收件人；原生凭据未配置时保持generic webhook兼容',async()=>{
    const fetcher=vi.fn(async()=>new Response(null,{status:200})) as unknown as typeof fetch;const f=setup(fetcher);
    for(const recipient of ['@all','u1|u2','u1 @all'])expect(()=>f.connectors.create(tenant,{name:'广播',kind:'feishu',externalUserId:recipient,credentials})).toThrow('单个');
    const b=f.connectors.create(tenant,{name:'旧飞书',kind:'feishu',externalUserId:'open-user',credentials:{verificationToken:credentials.verificationToken,encryptKey:credentials.encryptKey},delivery:{url:'https://example.com/result',secret:'s'.repeat(32)}});expect(b.nativeDeliveryStatus).toBe('requires_configuration');await f.receive(b.id);await f.manager.tick();expect(fetcher).toHaveBeenCalledTimes(1);expect(vi.mocked(fetcher).mock.calls[0]?.[0]).toBe('https://example.com/result');
    const sender=new NativeConnectorSender({fetch:fetcher});expect((await sender.send({...target,recipient:'u1|u2'},eventBody,'e',new AbortController().signal)).status).toBe(400);expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('明确429失败持久重试，取消阻止自动投递；手动重投成功后不再发送',async()=>{
    let messages=0;const fetcher=vi.fn(async(url:unknown)=>{if(String(url).includes('/auth/'))return Response.json({code:0,tenant_access_token:'token',expire:7200});messages++;return messages===1?new Response(null,{status:429,headers:{'retry-after':'120'}}):Response.json({code:0});}) as unknown as typeof fetch;
    const f=setup(fetcher);const b=f.connectors.create(tenant,{name:'飞书',kind:'feishu',externalUserId:'open-user',credentials});await f.receive(b.id);await f.manager.tick();const delivery=f.manager.deliveriesFor(tenant)[0]!;expect(delivery.state).toBe('pending');f.advance(60000);await f.manager.tick();expect(messages).toBe(1);f.manager.deliveryAction(tenant,delivery.id,'cancel');f.advance(120000);const restarted=new AutomationManager(f.deps);await restarted.tick();expect(messages).toBe(1);restarted.deliveryAction(tenant,delivery.id,'retry');await restarted.tick();await restarted.tick();expect(messages).toBe(2);expect(restarted.deliveriesFor(tenant)[0]?.state).toBe('delivered');
  });
  it('消息已发出但响应中断，或sending状态重启时不自动重复发送',async()=>{
    let sends=0;const fetcher=vi.fn(async(url:unknown)=>{if(String(url).includes('/auth/'))return Response.json({code:0,tenant_access_token:'token',expire:7200});sends++;throw new Error('response lost');}) as unknown as typeof fetch;
    const f=setup(fetcher);const b=f.connectors.create(tenant,{name:'飞书',kind:'feishu',externalUserId:'open-user',credentials});await f.receive(b.id);await f.manager.tick();expect(f.manager.deliveriesFor(tenant)[0]?.error).toContain('不确定');f.advance(120000);await f.manager.tick();expect(sends).toBe(1);
    const store=new AutomationStore<AutomationOutbox>(f.dir,'automation-outbox');const old=store.all()[0]!;store.put({...old,state:'sending'});await new AutomationManager(f.deps).tick();expect(sends).toBe(1);expect(f.manager.deliveriesFor(tenant)[0]?.state).toBe('failed');
  });
  it('平台errcode失败不伪报成功，账号无效为不可自动重试失败',async()=>{
    const fetcher=vi.fn(async(url:unknown)=>String(url).includes('/gettoken?')?Response.json({errcode:0,access_token:'token',expires_in:7200}):Response.json({errcode:0,invaliduser:'user1'})) as unknown as typeof fetch;
    const sender=new NativeConnectorSender({fetch:fetcher});expect((await sender.send({kind:'wecom',recipient:'user1',corpId:'corp',corpSecret:'secret',agentId:'1'},eventBody,'e',new AbortController().signal)).status).toBe(400);
  });
  it('取消进行中的原生请求会中断fetch且不转入自动重试',async()=>{
    let started!:()=>void;const gate=new Promise<void>(resolve=>{started=resolve;});let aborted=false;
    const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{if(String(url).includes('/auth/'))return Response.json({code:0,tenant_access_token:'token',expire:7200});started();return new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'));},{once:true});});}) as unknown as typeof fetch;
    const f=setup(fetcher);const b=f.connectors.create(tenant,{name:'飞书',kind:'feishu',externalUserId:'open-user',credentials});await f.receive(b.id);const tick=f.manager.tick();await gate;const id=f.manager.deliveriesFor(tenant)[0]!.id;f.manager.deliveryAction(tenant,id,'cancel');await tick;expect(aborted).toBe(true);expect(f.manager.deliveriesFor(tenant)[0]?.state).toBe('cancelled');await new AutomationManager(f.deps).tick();expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
