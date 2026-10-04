import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "../../../vendor/pi/agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../vendor/pi/agent/src/harness/session/session.ts";
import { createDocumentEditTool } from "@tao/office";
import { createPermissionGate, type TaskEvent } from "@tao/core";
import { InProcessRunnerFactory } from "../src/in-process-runner.ts";
import { createSubagentTool } from "../src/extensions.ts";

it("父 Pi 委派子 Pi 调用真实文档工具，产物回到父任务且原件不变",async()=>{
 const root=mkdtempSync(join(tmpdir(),"tao-delegation-")), source=join(root,"原件.txt");writeFileSync(source,"合同金额100元，其他内容不变");
 const faux=fauxProvider(),models=createModels();models.setProvider(faux.provider);
 const factory=new InProcessRunnerFactory({models,model:faux.getModel(),createSession:async id=>new StorageBackedSession({id,createdAt:1,storageVersion:1},new MemoryStorage())});
 const tenant={tenantId:"t",workspaceId:"w",userId:"u"};
 const delegate=createSubagentTool({factory,allowedTools:["edit_document"],createSpec:(id,tools)=>{
  const workspace=join(root,id);mkdirSync(workspace);
  return {taskId:id,sessionId:id,tenant,systemPrompt:"完成修订",tools:[createDocumentEditTool(workspace)],activeTools:tools,
   gate:createPermissionGate({workspace,allowedFiles:[source],policies:[{tool:"edit_document",pathParams:["path"]}]})};
 }});
 const runner=await factory.createRunner({taskId:"parent",sessionId:"parent",tenant,systemPrompt:"委派修订",tools:[delegate],gate:createPermissionGate({workspace:root,policies:[{tool:"delegate_tasks"}]})});
 const events:TaskEvent[]=[];runner.subscribe(e=>{events.push(e);});
 faux.setResponses([
  fauxAssistantMessage([fauxToolCall("delegate_tasks",{tasks:[{label:"修订合同",prompt:"修改金额",tools:["edit_document"]}]})]),
  fauxAssistantMessage([fauxToolCall("edit_document",{path:source,outputName:"修订.txt",edits:[{find:"100元",replace:"120元"}]})]),
  fauxAssistantMessage("修订完成"),fauxAssistantMessage("子任务交付完成"),
 ]);
 try {
  await runner.prompt("修改合同");
  const artifact=events.find(e=>e.type==="artifact");expect(artifact?.type).toBe("artifact");
  if(artifact?.type!=="artifact")throw new Error("缺少产物事件");
  expect(artifact.taskId).toBe("parent");expect(readFileSync(artifact.artifactId,"utf8")).toBe("合同金额120元，其他内容不变");
  expect(readFileSync(source,"utf8")).toBe("合同金额100元，其他内容不变");
 }finally{await runner.close();rmSync(root,{recursive:true,force:true});}
});
