import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { TaskEvent } from "@tao/core";
import { MemoryStorage } from "../../../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../vendor/pi/agent/src/harness/session/session.ts";
import { InProcessRunnerFactory } from "../src/in-process-runner.ts";
import { createModelRuntime } from "../src/model-runtime.ts";
it("真实兼容协议经Pi产生思考、正文增量、可恢复快照和模型步骤",async()=>{
 const server=createServer(async(req,res)=>{
  for await(const _ of req){}res.writeHead(200,{"Content-Type":"text/event-stream"});
  const send=(delta:unknown,finish_reason:string|null=null)=>res.write("data: "+JSON.stringify({id:"response-1",object:"chat.completion.chunk",created:1,model:"test",choices:[{index:0,delta,finish_reason}]})+"\n\n");
  send({role:"assistant",reasoning_content:"公开的思考片段"});await new Promise(r=>setTimeout(r,15));send({content:"流式"});await new Promise(r=>setTimeout(r,15));send({content:"回答"});send({},"stop");res.end("data: [DONE]\n\n");
 });await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 const {models,model}=createModelRuntime({baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:"test-key",modelName:"test"});
 const factory=new InProcessRunnerFactory({models,model,createSession:async id=>new StorageBackedSession({id,createdAt:1,storageVersion:1},new MemoryStorage())});
 const runner=await factory.createRunner({tenant:{tenantId:"t",workspaceId:"w",userId:"u"},taskId:"task",sessionId:"session",systemPrompt:"测试",tools:[],gate:()=>({kind:"allow"})});const events:TaskEvent[]=[];runner.subscribe(e=>{events.push(e);});
 try {
  await runner.prompt("回答");
  expect(events.filter(e=>e.type==="assistant_delta").map(e=>e.type==="assistant_delta"?e.delta:"").join("")).toBe("流式回答");
  expect(events.some(e=>e.type==="thinking_delta"&&e.delta.includes("公开"))).toBe(true);
  expect(events.some(e=>e.type==="message_progress"&&e.channel==="answer"&&e.text==="流式回答")).toBe(true);
  expect(events.find(e=>e.type==="assistant_message")).toMatchObject({text:"流式回答"});
  expect(events.filter(e=>e.type==="step").map(e=>e.type==="step"?e.phase:"")).toEqual(["started","finished"]);
  const persistent=events.filter(e=>e.seq>0).map(e=>e.seq);expect(persistent).toEqual([...persistent].sort((a,b)=>a-b));
 }finally{await runner.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
