import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createModelRuntime } from '../src/model-runtime.ts';
import type { RequestMetric } from '../src/model-controls.ts';
import { InProcessRunnerFactory } from '../src/in-process-runner.ts';
import { MemoryStorage } from '../../../vendor/pi/agent/src/harness/session/memory.ts';
import { StorageBackedSession } from '../../../vendor/pi/agent/src/harness/session/session.ts';

const servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}});
async function endpoint(statuses:number[]){
 const bodies:string[]=[];let requests=0;
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;bodies.push(body);
  const status=statuses[Math.min(requests++,statuses.length-1)]!;
  if(status!==200){res.writeHead(status,{'Content-Type':'application/json','Retry-After':'0'});res.end(JSON.stringify({error:{code:'QuotaExceeded',message:'private upstream payload'}}));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.end('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta:{role:'assistant',content:'恢复成功'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:2,total_tokens:4}})+'\n\ndata: [DONE]\n\n');
 });servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const metrics:RequestMetric[]=[];
 const runtime=createModelRuntime({flagship:{baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:'test-key',modelName:'test'},controls:{retryCount:2,retryBaseMs:1,timeoutMs:3000,onMetric:m=>metrics.push(m)}});
 const run=()=>runtime.models.streamSimple(runtime.model,{messages:[{role:'user',content:'生成回答',timestamp:1}]}).result();
 return {run,runtime,metrics,bodies,count:()=>requests};
}
it('真实兼容模型HTTP 429后恢复流式生成，只重发相同模型请求',async()=>{
 const s=await endpoint([429,200]),answer=await s.run();expect(answer.content).toContainEqual({type:'text',text:'恢复成功'});expect(s.count()).toBe(2);expect(s.bodies[0]).toBe(s.bodies[1]);expect(s.metrics[0]).toMatchObject({status:'success',statusCode:200,error:null,errorCode:null,retryCount:1});
});
it('真实持续429仅重试配置次数，失败摘要包含真实错误码且不泄露上游正文',async()=>{
 const s=await endpoint([429]),answer=await s.run();expect(s.count()).toBe(3);expect(answer.errorMessage).toContain('QuotaExceeded');expect(s.metrics[0]).toMatchObject({status:'error',statusCode:429,errorCode:'QuotaExceeded',retryCount:2});expect(JSON.stringify(s.metrics)).not.toContain('private upstream payload');
});
it.each([401,404])('HTTP %s不重试且观测保留状态',async status=>{
 const s=await endpoint([status]);await s.run();expect(s.count()).toBe(1);expect(s.metrics[0]).toMatchObject({status:'error',statusCode:status,retryCount:0});
});
it('HTTP 500与503指数退避后成功',async()=>{const s=await endpoint([500,503,200]);await s.run();expect(s.count()).toBe(3);expect(s.metrics[0]).toMatchObject({status:'success',retryCount:2});});
it('真实内核失败保留HTTP和服务错误码；无工具生成不执行副作用',async()=>{
 const s=await endpoint([429]);const factory=new InProcessRunnerFactory({...s.runtime,createSession:async id=>new StorageBackedSession({id,createdAt:1,storageVersion:1},new MemoryStorage())});
 const runner=await factory.createRunner({taskId:'retry-generation',sessionId:'retry-generation',tenant:{tenantId:'t',workspaceId:'w',userId:'u'},systemPrompt:'只生成回答',tools:[],activeTools:[],gate:()=>{throw Error('不应调用工具权限门');}});
 try{await expect(runner.prompt('基于已有结果生成')).rejects.toThrow('HTTP 429 / QuotaExceeded');expect(s.count()).toBe(3);expect(JSON.parse(s.bodies[0]!)).not.toHaveProperty('tools');}
 finally{await runner.close();}
});
