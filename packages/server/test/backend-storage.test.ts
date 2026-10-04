import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceCatalog } from "../src/resources.ts";
import { KnowledgeJobs } from "../src/knowledge-jobs.ts";
import { createWorkspaceServices } from "../src/workspace-services.ts";
const tenant={tenantId:"t",workspaceId:"w",userId:"u"}, roots:string[]=[];
function setup(){const root=mkdtempSync(join(tmpdir(),"tao-storage-"));roots.push(root);const dir=join(root,"t","w");mkdirSync(dir,{recursive:true});return {root,dir};}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it("产物保留不可变版本、父引用、工作区归属与幂等引用副本",()=>{
 const {root,dir}=setup(),catalog=new ResourceCatalog(root),path=join(dir,"output.txt"),source=join(dir,"input.txt");
 writeFileSync(source,"原始资料");writeFileSync(path,"版本一");
 const first=catalog.record(tenant,"task",path,[source]),id=first.artifactId,v1=first.versions[0]!;
 writeFileSync(path,"版本二");const updated=catalog.record(tenant,"task",path,[source]);
 expect(updated.versions).toHaveLength(2);expect(readFileSync(v1.path,"utf8")).toBe("版本一");
 expect(catalog.record(tenant,"task",path,[source]).versions).toHaveLength(2);
 expect(catalog.owned({...tenant,workspaceId:"other"},id)).toBeUndefined();
 expect(catalog.publicVersions(updated)[0]).not.toHaveProperty("path");
 const ref=catalog.reference(tenant,id,v1.versionId,"request");expect(catalog.reference(tenant,id,v1.versionId,"request")).toEqual(ref);
 const revised=catalog.record(tenant,"revision",path,[ref.path]);expect(revised.versions[0]?.parentVersionId).toBe(v1.versionId);
 writeFileSync(ref.path,"篡改");expect(()=>catalog.reference(tenant,id,v1.versionId,"request")).toThrow("变化");
});
it("产物源文件越界和版本目录符号链接均拒绝",()=>{
 const {root,dir}=setup(),catalog=new ResourceCatalog(root);writeFileSync(join(root,"outside.txt"),"外部");
 expect(()=>catalog.record(tenant,"task",join(root,"outside.txt"),[])).toThrow();
 writeFileSync(join(dir,"out.txt"),"正文");symlinkSync(root,join(dir,".versions"));
 expect(()=>catalog.record(tenant,"task",join(dir,"out.txt"),[])).toThrow();
});
it("知识异步失败可重试，更新发布新版本且坏更新不破坏旧索引",async()=>{
 const {root,dir}=setup(),services=createWorkspaceServices({workspaceRoot:root}),jobs=new KnowledgeJobs(join(root,"jobs"),services);
 const job=jobs.create(tenant,{fileName:"制度.txt"},"ingest");
 await vi.waitFor(()=>expect(jobs.owned(tenant,job.jobId)?.status).toBe("failed"));
 writeFileSync(join(dir,"制度.txt"),"设备维护旧要求");jobs.retry(tenant,job.jobId);
 await vi.waitFor(()=>expect(jobs.owned(tenant,job.jobId)?.status).toBe("ready"));
 expect(jobs.owned(tenant,job.jobId)?.attempt).toBe(2);
 const oldHit=(await services.searchKnowledge(tenant,"设备维护"))[0]!;
 const doc=await services.ingestKnowledge(tenant,{name:"制度.txt",text:"设备维护新要求"});expect(doc.version).toBe(2);
 const newHit=(await services.searchKnowledge(tenant,"设备维护"))[0]!;expect(newHit.chunk.id).not.toBe(oldHit.chunk.id);expect(newHit.chunk.documentVersion).toBe(2);
 expect(services.knowledgeVersion(tenant,doc.documentId,1).chunks[0]?.text).toContain("旧要求");
 await expect(services.ingestKnowledge(tenant,{name:"制度.txt",text:""})).rejects.toThrow();
 expect(services.listKnowledge(tenant)[0]?.version).toBe(2);expect(jobs.public(jobs.owned(tenant,job.jobId)!)).not.toHaveProperty("input");
 expect(jobs.owned({...tenant,workspaceId:"other"},job.jobId)).toBeUndefined();
 services.deleteKnowledge(tenant,doc.documentId);expect(()=>services.knowledgeVersion(tenant,doc.documentId,1)).toThrow("已删除");
});
