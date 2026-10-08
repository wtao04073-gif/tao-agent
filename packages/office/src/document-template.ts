import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { boundedJson, parseSafeXml, publishFile, readBoundedZip, readWorkspaceFile } from "./file-safety.ts";
export async function fillDocumentTemplate(workspace:string,input:{path:string;outputName:string;data:Record<string,unknown>}):Promise<string>{
 boundedJson(input);
 if(!input.data||typeof input.data!=="object"||Array.isArray(input.data))throw new Error("模板data须为字段对象");
 let maxListLength=1,maxValueLength=1;
 const validate=(value:unknown,depth=0):void=>{
  if(depth>8)throw new Error("模板数据嵌套过深");
  if(typeof value==="string")maxValueLength=Math.max(maxValueLength,value.length);
  if(value===null||typeof value==="boolean"||(typeof value==="number"&&Number.isFinite(value))||(typeof value==="string"&&value.length<=100000))return;
  if(Array.isArray(value)){if(value.length>1000)throw new Error("模板列表超过1000项");maxListLength=Math.max(maxListLength,value.length);value.forEach(v=>validate(v,depth+1));return;}
  if(value&&typeof value==="object"){for(const [k,v]of Object.entries(value)){if(["__proto__","constructor","prototype"].includes(k))throw new Error("模板字段名不安全");validate(v,depth+1);}return;}
  throw new Error("模板值仅支持文本、有限数字、布尔值、空值和列表对象");
 };validate(input.data);
 const bytes=await readWorkspaceFile(workspace,input.path),files=readBoundedZip(bytes);
 if(!files["word/document.xml"])throw new Error("模板须为DOCX文件");
 for(const [name,data]of Object.entries(files)){
  if(/vbaProject|activeX|embeddings/i.test(name))throw new Error("模板包含宏、控件或嵌入对象，请提供普通DOCX模板");
  if(name.endsWith(".xml")){
   const doc=parseSafeXml(data),text=Array.from(doc.getElementsByTagNameNS("*","t")).map(n=>n.textContent??"").join("");
   let loopDepth=0,maxLoopDepth=0,loops=0;
   for (const tag of text.matchAll(/\{\s*([#^/])[^}]+\}/g)) {
    if (tag[1] === "/") loopDepth--; else { loopDepth++; loops++; maxLoopDepth=Math.max(maxLoopDepth,loopDepth); }
   }
   const expansion=Math.pow(maxListLength,maxLoopDepth),tagCount=[...text.matchAll(/\{[^}]+\}/g)].length;
   if (loops > 30 || maxLoopDepth > 3 || expansion > 10000 || data.length*expansion > 50*1024*1024 || maxValueLength*tagCount*expansion > 20*1024*1024) throw new Error("模板循环展开超过安全上限，请减少嵌套与列表数据");
   if(/\{\s*[@%]/.test(text))throw new Error("模板不允许原始XML或图片执行标签，仅支持字段与列表标签");
  }
 }
 const template=new Docxtemplater(new PizZip(bytes),{paragraphLoop:true,linebreaks:true,nullGetter(part){throw new Error(`模板字段未提供：${part.value}`);}});
 template.render(input.data);
 const result=template.getZip().generate({type:"nodebuffer",compression:"DEFLATE"});
 readBoundedZip(result);
 return publishFile(workspace,input.outputName,".docx",result);
}
