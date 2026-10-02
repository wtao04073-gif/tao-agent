import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { Runner, RunnerSpec, TaskEvent } from "@tao/core";
import { createMcpToolset, createSubagentTool } from "../src/extensions.ts";
const tenant={tenantId:"t",workspaceId:"w",userId:"u"};
const input = (args:unknown,signal=new AbortController().signal)=>({args,tenant,taskId:"parent",signal,report:()=>{}});
const servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}});
it("MCP 实际握手、只列白名单工具、调用一次并保留服务错误",async()=>{
 const calls:unknown[]=[];
 const server=createServer(async(req,res)=>{
  if(req.method!=="POST"){res.writeHead(405).end();return;}
  const parts:Buffer[]=[];for await(const b of req)parts.push(b);
  const request=JSON.parse(Buffer.concat(parts).toString());
  if(request.id===undefined){res.writeHead(202).end();return;}
  let result:unknown;
  if(request.method==="initialize")result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"test",version:"1"}};
  else if(request.method==="tools/list")result={tools:[{name:"echo",description:"回声",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}},{name:"hidden",inputSchema:{type:"object"}}]};
  else if(request.method==="tools/call"){calls.push(request.params);result={content:[{type:"text",text:request.params.arguments.text}],...(request.params.arguments.text==="fail"?{isError:true}:{})};}
  else result={};
  res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({jsonrpc:"2.0",id:request.id,result}));
 });servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 const address=server.address() as {port:number};
 const tools=createMcpToolset([{name:"local",url:`http://127.0.0.1:${address.port}/mcp`,tools:["echo"]}]);
 const list=await tools[0]!.execute(input({server:"local"}));expect(JSON.parse(list.text).map((t:{name:string})=>t.name)).toEqual(["echo"]);
 const result=await tools[1]!.execute(input({server:"local",tool:"echo",arguments:{text:"hello"}}));
 expect(result.isError).not.toBe(true);expect(result.text).toContain("hello");expect(calls).toHaveLength(1);
 expect((await tools[1]!.execute(input({server:"local",tool:"hidden",arguments:{}}))).isError).toBe(true);expect(calls).toHaveLength(1);
 expect((await tools[1]!.execute(input({server:"local",tool:"echo",arguments:{text:"fail"}}))).isError).toBe(true);expect(calls).toHaveLength(2);
},30000);
it("子任务创建失败不丢其他结果，并发受限，权限不能扩张",async()=>{
 let active=0,peak=0,created=0,closed=0;const specs:RunnerSpec[]=[];
 const tool=createSubagentTool({allowedTools:["read","delegate_tasks","mcp_call"],maxConcurrency:2,
  createSpec:(id,tools)=>({taskId:id,sessionId:id,tenant,systemPrompt:"s",tools:[],activeTools:tools,gate:()=>({kind:"allow"})}),
  factory:{async createRunner(spec){specs.push(spec);if(++created===2)throw new Error("创建失败");
   let listener:((e:TaskEvent)=>void|Promise<void>)|undefined;
   return {sessionId:spec.sessionId,subscribe(fn){listener=fn;return()=>{listener=undefined;};},async prompt(){active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;await listener?.({type:"artifact",artifactId:spec.taskId+".txt"} as TaskEvent);},async abort(){},async steer(){},async close(){closed++;}};
  }},
 });
 const result=await tool.execute(input({tasks:Array.from({length:5},(_,i)=>({label:String(i),prompt:"工作",tools:["read","write","mcp_call"]}))}));
 expect(peak).toBeLessThanOrEqual(2);expect(closed).toBe(4);
 expect(specs.every(s=>s.activeTools?.join()==="read")).toBe(true);
 const rows=JSON.parse(result.text);expect(rows.filter((r:{status:string})=>r.status==="failed")).toHaveLength(1);
 expect(result.details).toMatchObject({partialFailure:true});expect((result.details as {outputPaths:string[]}).outputPaths).toHaveLength(4);
 expect(result.isError).not.toBe(true);
});
it("父取消与子超时均中止并关闭子执行器",async()=>{
 for(const cancel of [false,true]){
  const controller=new AbortController(), started=Promise.withResolvers<void>(), stopped=Promise.withResolvers<void>();
  const runner:Runner={sessionId:"child",subscribe:()=>()=>{},prompt:async()=>{started.resolve();await stopped.promise;},steer:async()=>{},abort:vi.fn(async()=>{stopped.resolve();}),close:vi.fn(async()=>{})};
  const tool=createSubagentTool({factory:{createRunner:async()=>runner},allowedTools:[],timeoutMs:20,createSpec:id=>({tenant,taskId:id,sessionId:id,systemPrompt:"s",tools:[],gate:()=>({kind:"allow"})})});
  const execution=tool.execute(input({tasks:[{label:"子任务",prompt:"工作"}]},controller.signal));
  await started.promise;if(cancel)controller.abort();
  expect(JSON.parse((await execution).text)[0].status).toBe(cancel?"cancelled":"timed_out");
  expect(runner.abort).toHaveBeenCalledOnce();expect(runner.close).toHaveBeenCalledOnce();
 }
});
