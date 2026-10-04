import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { Role } from "@tao/core";
import { createWorkspaceServices } from "../src/workspace-services.ts";
import { createWorkspaceHandler } from "../src/workspace-api.ts";
import { KnowledgeJobs, createKnowledgeJobHandler } from "../src/knowledge-jobs.ts";
it("HTTP语义搜索、待重建状态、异步重建与工作区隔离",async()=>{
 const root=mkdtempSync(join(tmpdir(),"tao-rag-api-")),tenant={tenantId:"t",workspaceId:"w",userId:"u"};mkdirSync(join(root,"t","w"),{recursive:true});
 const old=createWorkspaceServices({workspaceRoot:root}),doc=await old.ingestKnowledge(tenant,{name:"车辆政策",text:"automobile policy"});
 const services=createWorkspaceServices({workspaceRoot:root,embeddings:{space:"test",embed:async texts=>texts.map(()=>[1,0])}});
 const authenticate=async(req:import("node:http").IncomingMessage)=>({tenant:req.headers.authorization==="Bearer other"?{...tenant,workspaceId:"other"}:tenant,role:Role.Member});
 const jobs=new KnowledgeJobs(join(root,"jobs"),services),jobHandler=createKnowledgeJobHandler(jobs,authenticate),handler=createWorkspaceHandler({authenticate,workspaceRoot:root,services,getTask:()=>undefined,artifactPath:()=>undefined});
 const server=createServer((req,res)=>{void(async()=>{if(await jobHandler(req,res))return;if(!await handler(req,res))res.writeHead(404).end();})();});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const search=(token="test")=>fetch(url+"/api/knowledge/search",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify({query:"vehicle",mode:"semantic",limit:4})});
 try{
  expect((await search()).status).toBe(503);
  expect((await (await fetch(url+"/api/knowledge/status")).json()).rag.pendingDocuments).toBe(1);
  const response=await fetch(url+`/api/knowledge/${doc.documentId}/reindex`,{method:"POST"});expect(response.status).toBe(202);
  const {job}=await response.json();await vi.waitFor(()=>expect(jobs.owned(tenant,job.jobId)?.status).toBe("ready"));
  const result=await (await search()).json();expect(result.mode).toBe("semantic");expect(result.hits[0].chunk.documentName).toBe("车辆政策");
  expect((await (await search("other")).json()).hits).toEqual([]);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
