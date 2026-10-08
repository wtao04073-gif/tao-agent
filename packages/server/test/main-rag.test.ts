import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { RunnerSpec } from "@tao/core";
import type { AppDeps } from "../src/app.ts";
const host=vi.hoisted(()=>({root:"",deps:undefined as AppDeps|undefined,spec:undefined as RunnerSpec|undefined}));
vi.mock("node:http",()=>({createServer:()=>({listen:vi.fn(),close:vi.fn()})}));
vi.mock("../src/config.ts",()=>({loadConfig:()=>({errors:[],config:{workspaceDir:host.root,port:8080,modelName:"test",rag:{endpoint:"http://localhost/embeddings",model:"test",mode:"hybrid",minSimilarity:0.35,chunkChars:800,overlapChars:100}}}),describeConfig:()=>"",renderConfigErrors:()=>""}));
vi.mock("../src/accounts.ts",async original=>({...await original<typeof import("../src/accounts.ts")>(),loadAccounts:()=>({accounts:[]}),hasDefaultTokens:()=>false}));
vi.mock("../src/app.ts",async original=>({...await original<typeof import("../src/app.ts")>(),createApp:(deps:AppDeps)=>{host.deps=deps;return vi.fn();}}));
vi.mock("@tao/knowledge",async original=>({...await original<typeof import("@tao/knowledge")>(),HttpEmbeddings:class {space="test-space";embed=async(texts:readonly string[])=>texts.map(()=>[1,0]);}}));
vi.mock("@tao/agent-host",async original=>({...await original<typeof import("@tao/agent-host")>(),createModelRuntime:()=>({models:{},model:{},modelForId:()=>({id:"test-model",input:["text"]})}),MemorySessionFactory:class {close=vi.fn();},InProcessRunnerFactory:class {async createRunner(spec:RunnerSpec){host.spec=spec;return {sessionId:spec.sessionId,prompt:async()=>{},steer:async()=>{},abort:async()=>{},close:async()=>{},subscribe:()=>()=>{}};}}}));
it("主入口在调用Pi前检索知识并注入来源，不依赖模型自行决定搜索",async()=>{
 host.root=mkdtempSync(join(tmpdir(),"tao-main-rag-"));mkdirSync(join(host.root,"t","w"),{recursive:true});
 const on=process.on.bind(process),spy=vi.spyOn(process,"on").mockImplementation(((event:string,listener:(...a:unknown[])=>void)=>["SIGINT","SIGTERM"].includes(event)?process:on(event,listener)) as typeof process.on);
 try {
  const {createWorkspaceServices}=await import("../src/workspace-services.ts");
  const tenant={tenantId:"t",workspaceId:"w",userId:"u"};
  await createWorkspaceServices({workspaceRoot:host.root,embeddings:{space:"test-space",embed:async texts=>texts.map(()=>[1,0])}}).ingestKnowledge(tenant,{name:"车辆制度",text:"automobile policy evidence"});
  vi.stubEnv('WORKSPACE_DIR', host.root);vi.stubEnv('MODEL_BASE_URL','http://localhost:1');vi.stubEnv('MODEL_NAME','test');vi.stubEnv('MODEL_API_KEY','test-only-key');
  await import("../src/main.ts");await host.deps!.submitTask(tenant,{scenarioId:"general.free-task",fields:{query:"vehicle"}});
  expect(host.spec?.systemPrompt).toContain("automobile policy evidence");expect(host.spec?.systemPrompt).toContain("车辆制度");expect(host.spec?.systemPrompt).toContain("版本 1");
  await new Promise<void>(r=>setImmediate(r));
 }finally{host.deps?.hub.closeAll();spy.mockRestore();vi.unstubAllEnvs();rmSync(host.root,{recursive:true,force:true});}
});
