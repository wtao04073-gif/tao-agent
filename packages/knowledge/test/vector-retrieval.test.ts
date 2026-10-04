import { expect, it, vi } from "vitest";
import { Role, Scope, type Chunk } from "@tao/core";
import { indexChunks, retrieveVectors } from "../src/vector-retrieval.ts";
import type { EmbeddingProvider } from "../src/embeddings.ts";
const membership={tenantId:"t",workspaceId:"w",userId:"u",role:Role.Member};
const chunk=(id:string,text:string,extra:Partial<Chunk>={}):Chunk=>({id,text,documentId:id,documentName:id,position:1,...membership,ownerId:"u",scope:Scope.Workspace,knowledgeBaseId:"kb",...extra});
const provider:EmbeddingProvider={space:"model-v1",embed:async texts=>texts.map(t=>["automobile","vehicle"].includes(t)?[1,0]:[0,1])};
it("无关键词重合仍按向量召回，过滤低分项",async()=>{
 const chunks=[chunk("cars","automobile"),chunk("food","vegetables")], index=await indexChunks(provider,chunks);
 const hits=await retrieveVectors({provider,membership,documents:[{chunks,index}],query:"vehicle",mode:"semantic"});
 expect(hits.map(h=>h.chunk.id)).toEqual(["cars"]);expect(hits[0]?.score).toBe(1);
});
it("租户、工作区与知识库权限先于向量检索",async()=>{
 const chunks=[chunk("hidden","automobile",{tenantId:"other"})];const embed=vi.fn(provider.embed);
 expect(await retrieveVectors({provider:{...provider,embed},membership,documents:[{chunks}],query:"vehicle"})).toEqual([]);expect(embed).not.toHaveBeenCalled();
 const visible=[chunk("cars","automobile")],index=await indexChunks(provider,visible);
 expect(await retrieveVectors({provider,membership,documents:[{chunks:visible,index}],query:"vehicle",knowledgeBaseIds:["other"]})).toEqual([]);
});
it("混合召回融合关键词和语义，不重复片段",async()=>{
 const chunks=[chunk("cars","automobile"),chunk("literal","vehicle document")],index=await indexChunks(provider,chunks);
 const hits=await retrieveVectors({provider,membership,documents:[{chunks,index}],query:"vehicle",mode:"hybrid"});
 expect(new Set(hits.map(h=>h.chunk.id))).toEqual(new Set(["cars","literal"]));
});
it("拒绝旧模型、错位片段、维度变化及无效向量",async()=>{
 const chunks=[chunk("cars","automobile")],index=await indexChunks(provider,chunks);
 await expect(retrieveVectors({provider:{...provider,space:"v2"},membership,documents:[{chunks,index}],query:"vehicle"})).rejects.toThrow("重建");
 await expect(retrieveVectors({provider,membership,documents:[{chunks,index:{...index,chunkIds:["wrong"]}}],query:"vehicle"})).rejects.toThrow("版本");
 await expect(retrieveVectors({provider:{...provider,embed:async()=>[[1,0,0]]},membership,documents:[{chunks,index}],query:"vehicle"})).rejects.toThrow("维度");
 await expect(indexChunks({...provider,embed:async()=>[[0,0]]},chunks)).rejects.toThrow("零");
});
it("长片段按字符预算切分并保留重叠、版本与Unicode字符",async()=>{
 const {boundRagChunks}=await import("../src/rag-chunks.ts");
 const original=chunk("long","🦑".repeat(220),{documentVersion:3});const pieces=boundRagChunks([original],100,20);
 expect(pieces.map(p=>Array.from(p.text).length)).toEqual([100,100,60]);
 expect(pieces.every(p=>p.documentVersion===3&&p.documentId==="long")).toBe(true);expect(new Set(pieces.map(p=>p.id)).size).toBe(3);
 expect(()=>boundRagChunks([original],100,100)).toThrow("配置");
});
