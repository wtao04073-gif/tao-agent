import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import type { EmbeddingProvider } from "@tao/knowledge";
import { createWorkspaceServices } from "../src/workspace-services.ts";
import { parseRagConfig } from "../src/rag-config.ts";
const tenant={tenantId:"t",workspaceId:"w",userId:"u"},roots:string[]=[];
const provider:EmbeddingProvider={space:"v1",embed:async texts=>texts.map(t=>/vehicle|automobile/.test(t)?[1,0]:[0,1])};
function setup(embeddings:EmbeddingProvider|undefined=provider){const root=mkdtempSync(join(tmpdir(),"tao-rag-"));roots.push(root);mkdirSync(join(root,"t","w"),{recursive:true});return {root,services:createWorkspaceServices({workspaceRoot:root,...(embeddings?{embeddings}:{})})};}
afterEach(()=>{for(const d of roots.splice(0))rmSync(d,{recursive:true,force:true});});
it("向量随文档原子持久化，重启工具能语义召回且保留版本引用",async()=>{
 const {root,services}=setup();await services.ingestKnowledge(tenant,{name:"汽车指南",text:"automobile"});
 const restarted=createWorkspaceServices({workspaceRoot:root,embeddings:provider});
 expect(restarted.ragStatus(tenant)).toMatchObject({enabled:true,indexedDocuments:1,pendingDocuments:0});
 const result=await restarted.createKnowledgeTool(tenant).execute({args:{query:"vehicle"},tenant,taskId:"task",signal:new AbortController().signal,report:()=>{}});
 expect(result.text).toContain("automobile");expect(result.details).toMatchObject({citations:[{documentName:"汽车指南",documentVersion:1}]});
 expect(await restarted.searchKnowledge({...tenant,workspaceId:"other"},"vehicle")).toEqual([]);
});
it("嵌入失败保留旧正文与旧向量，不发布半个版本",async()=>{
 const {root,services}=setup();const doc=await services.ingestKnowledge(tenant,{name:"汽车指南",text:"automobile"});
 const broken=createWorkspaceServices({workspaceRoot:root,embeddings:{space:"v1",embed:async()=>{throw new Error("服务不可用");}}});
 await expect(broken.ingestKnowledge(tenant,{name:"汽车指南",text:"新正文"})).rejects.toThrow();
 expect(services.knowledgeVersion(tenant,doc.documentId,1).chunks[0]?.text).toBe("automobile");expect((await services.searchKnowledge(tenant,"vehicle"))[0]?.chunk.documentVersion).toBe(1);
});
it("旧索引迁移和模型变更必须补建，不自动伪降级",async()=>{
 const {root}=setup();const old=createWorkspaceServices({workspaceRoot:root});const doc=await old.ingestKnowledge(tenant,{name:"汽车指南",text:"automobile"});
 const services=createWorkspaceServices({workspaceRoot:root,embeddings:provider});
 expect(services.ragStatus(tenant).pendingDocuments).toBe(1);await expect(services.searchKnowledge(tenant,"vehicle")).rejects.toThrow("重建");
 await services.reindexKnowledge(tenant,doc.documentId);expect((await services.searchKnowledge(tenant,"vehicle")).length).toBe(1);
 const changed=createWorkspaceServices({workspaceRoot:root,embeddings:{...provider,space:"v2"}});await expect(changed.searchKnowledge(tenant,"vehicle")).rejects.toThrow("重建");
 await expect(services.reindexKnowledge({...tenant,userId:"other"},doc.documentId)).rejects.toMatchObject({status:403});
});
it("检索期间删除文档，不能返回旧内容",async()=>{
 const hold=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();
 const {services}=setup({...provider,embed:async(texts,kind)=>{if(kind==="query"){started.resolve();await hold.promise;}return provider.embed(texts,kind);}});
 const doc=await services.ingestKnowledge(tenant,{name:"汽车指南",text:"automobile"});const search=services.searchKnowledge(tenant,"vehicle");await started.promise;services.deleteKnowledge(tenant,doc.documentId);hold.resolve();expect(await search).toEqual([]);
});
it("入库期间删除文档，不能因向量完成而复活文档",async()=>{
 let paused=false;const hold=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();
 const {services}=setup({...provider,embed:async(texts,kind)=>{if(paused){started.resolve();await hold.promise;}return provider.embed(texts,kind);}});
 const doc=await services.ingestKnowledge(tenant,{name:"汽车指南",text:"automobile"});paused=true;
 const updating=services.ingestKnowledge(tenant,{name:"汽车指南",text:"vehicle"});await started.promise;services.deleteKnowledge(tenant,doc.documentId);hold.resolve();await expect(updating).rejects.toMatchObject({status:409});expect(services.listKnowledge(tenant)).toEqual([]);
});
it("配置缺失不宣称启用，强制RAG时阻止缺配置启动",()=>{
 expect(parseRagConfig({})).toBeUndefined();expect(()=>parseRagConfig({RAG_REQUIRED:"true"})).toThrow("同时配置");
 expect(()=>parseRagConfig({EMBEDDING_ENDPOINT:"https://example.com/v1/embeddings"})).toThrow();
 expect(parseRagConfig({EMBEDDING_ENDPOINT:"https://example.com/v1/embeddings",EMBEDDING_MODEL:"model"})?.mode).toBe("hybrid");
});
