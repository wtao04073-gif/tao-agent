import { extname, dirname, join, sep } from "node:path";
import { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";
import { parseSafeXml, publishFile, readBoundedZip, readWorkspaceFile } from "./file-safety.ts";
export interface ExtendedReadResult { format: string; text: string; total: number; offset: number; nextOffset: number | null; warnings: string[]; requiresOcr?: boolean; units?: string[]; entries?: { name: string; bytes: number }[] }
export const EXTENDED_READ_FORMATS=[".pdf",".pptx",".rtf",".zip",".txt",".md",".json",".jsonl",".yaml",".yml",".xml",".html",".htm",".js",".jsx",".ts",".tsx",".py",".go",".java",".rs",".c",".h",".cpp",".css",".sql",".sh",".log"] as const;
function paginate(format:string, units:string[], offset:number, limit:number, warnings:string[]=[]):ExtendedReadResult{
 const selected:string[]=[];let chars=0;
 for(const unit of units.slice(offset,offset+limit)){if(chars+unit.length>60000){if(!selected.length)throw new Error("单段超过60000字符，请拆分源文件后读取");break;}selected.push(unit);chars+=unit.length;}
 const nextOffset=offset+selected.length<units.length?offset+selected.length:null;
 return{format,text:selected.join("\n\n"),total:units.length,offset,nextOffset,warnings,units:selected};
}
function xmlTexts(data:Uint8Array, localName:string):string[] {
 const doc=parseSafeXml(data);return Array.from(doc.getElementsByTagNameNS("*",localName)).map(n=>n.textContent??"");
}
/** RTF只提取文字，不加载对象、图片或外部字段。支持Unicode转义和代码页。 */
export function readRtfText(bytes:Buffer):string {
 const source=bytes.toString("latin1");if(!source.startsWith("{\\rtf"))throw new Error("不是有效的RTF文档");
 let output="",depth=0,skip=false,uc=1,fallback=0,codepage="windows-1252";
 const stack:{skip:boolean;uc:number}[]=[];
 for(let i=0;i<source.length;){
  const c=source[i++]!;
  if(c==="{"){if(++depth>256)throw new Error("RTF嵌套层数超限");stack.push({skip,uc});continue;}
  if(c==="}"){const state=stack.pop();if(!state)throw new Error("RTF分组损坏");skip=state.skip;uc=state.uc;depth--;continue;}
  if(c!=="\\"){if(fallback>0){fallback--;continue;}if(!skip&&c!=="\r"&&c!=="\n")output+=c;continue;}
  const next=source[i];
  if(next==="\\"||next==="{"||next==="}"){i++;if(fallback>0)fallback--;else if(!skip)output+=next;continue;}
  if(next==="*"){skip=true;i++;continue;}
  if(next==="'"){
   const octets:number[]=[];i--;
   while(source.slice(i,i+2)==="\\'"){const hex=source.slice(i+2,i+4);if(!/^[0-9a-f]{2}$/i.test(hex))throw new Error("RTF转义损坏");octets.push(parseInt(hex,16));i+=4;}
   if(fallback>0)fallback=Math.max(0,fallback-octets.length);else if(!skip){try{output+=new TextDecoder(codepage).decode(new Uint8Array(octets));}catch{throw new Error("RTF代码页暂不支持");}}continue;
  }
  const m=/^([a-z]+)(-?\d+)? ?/.exec(source.slice(i));
  if(!m){i++;if(!skip&&next==="~")output+=" ";continue;}
  i+=m[0].length;const word=m[1]!,num=m[2]===undefined?undefined:Number(m[2]);
  if(["fonttbl","colortbl","stylesheet","info","pict","object","objdata","fldinst","datastore","themedata","header","footer"].includes(word))skip=true;
  if(word==="bin"){if(num===undefined||num<0||num>source.length-i)throw new Error("RTF二进制长度无效");i+=num;continue;}
  if(word==="ansicpg"&&num!==undefined)codepage=num===936?"gb18030":num===65001?"utf-8":`windows-${num}`;
  if(word==="uc"&&num!==undefined){if(num<0||num>16)throw new Error("RTF Unicode回退无效");uc=num;}
  if(skip)continue;
  if(word==="u"&&num!==undefined){output+=String.fromCharCode(num<0?num+65536:num);fallback=uc;}
  if(word==="par"||word==="line")output+="\n";
  if(word==="tab")output+="\t";
 }
 if(depth!==0)throw new Error("RTF分组未闭合");return output.trim();
}
export async function readExtendedFile(workspace:string,input:{path:string;offset?:number;limit?:number;entry?:string}):Promise<ExtendedReadResult>{
 const offset=input.offset??0,limit=input.limit??20;
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error("offset须非负，limit须为1至100");
 const bytes=await readWorkspaceFile(workspace,input.path),ext=extname(input.path).toLowerCase();
 if(ext===".pdf"){
  const {getDocument}=await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfRoot=dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const loading=getDocument({standardFontDataUrl:join(pdfRoot,"standard_fonts")+sep,cMapUrl:join(pdfRoot,"cmaps")+sep,cMapPacked:true,useWorkerFetch:false,data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,isOffscreenCanvasSupported:false,stopAtErrors:true});
  try{
   const pdf=await loading.promise;if(pdf.numPages>1000)throw new Error("PDF超过1000页，请拆分处理");
   const units:string[]=[],ocrPages:number[]=[];let chars=0;
   for(let n=offset+1;n<=Math.min(pdf.numPages,offset+limit);n++){
    const page=await pdf.getPage(n),content=await page.getTextContent();
    const text=content.items.map(v=>"str"in v?v.str+(v.hasEOL?"\n":" "):"").join("").trim();
    if(text.length>60000)throw new Error(`PDF第${n}页文字超过单页读取上限`);
    if(chars+text.length>60000&&units.length)break;
    if(!text)ocrPages.push(n);units.push(`[第${n}页]\n${text||"未检测到文本层，需要OCR或确认本页为空白页"}`);chars+=text.length;
    page.cleanup();
   }
   return{format:"pdf",text:units.join("\n\n"),total:pdf.numPages,offset,nextOffset:offset+units.length<pdf.numPages?offset+units.length:null,requiresOcr:ocrPages.length>0,warnings:ocrPages.length?[`第${ocrPages.join("、")}页无文本层，不能把空白解析结果当作已读取内容；扫描件需OCR`]:[]};
  }finally{await loading.destroy();}
 }
 if(ext===".pptx"){
  const files=readBoundedZip(bytes),presentation=files["ppt/presentation.xml"],relations=files["ppt/_rels/presentation.xml.rels"];
  if(!presentation||!relations)throw new Error("不是完整PPTX文件");
  const rels=new Map(Array.from(parseSafeXml(relations).getElementsByTagNameNS("*","Relationship")).map(r=>[r.getAttribute("Id"),r.getAttribute("Target")]));
  const ids=Array.from(parseSafeXml(presentation).getElementsByTagNameNS("*","sldId"));if(ids.length>1000)throw new Error("演示稿超过1000页");
  const units=ids.map((id,i)=>{const target=rels.get(id.getAttribute("r:id"));if(!target||target.includes("..")||target.includes(":")||target.includes("\\"))throw new Error("幻灯片引用无效");const key=target.startsWith("/")?target.slice(1):"ppt/"+target;const data=files[key];if(!data)throw new Error("幻灯片内容缺失");return`[第${i+1}页]\n${xmlTexts(data,"t").join("\n")}`;});
  return paginate("pptx",units,offset,limit,["读取幻灯片文本；图片和图表数值不作视觉识别"]);
 }
 if(ext===".zip"){
  const files=readBoundedZip(bytes),entries=Object.entries(files).filter(([name])=>!name.endsWith("/")).map(([name,b])=>({name,bytes:b.length}));
  if(input.entry){const data=files[input.entry];if(!data)throw new Error("压缩包内不存在该条目");if(data.length>2*1024*1024)throw new Error("单个文本条目超过2 MiB");const e=extname(input.entry).toLowerCase();if(!EXTENDED_READ_FORMATS.includes(e as never)||[".pdf",".pptx",".rtf",".zip"].includes(e))throw new Error("压缩包条目仅支持代码和纯文本读取，不解压到磁盘");const text=new TextDecoder("utf-8",{fatal:true}).decode(data);if(text.includes("\0"))throw new Error("条目不是文本");return paginate("zip-text",text.split(/\r?\n/).map((v,i)=>`[第${i+1}行] ${v}`),offset,limit);}
  const result=paginate("zip",entries.map(e=>`${e.name} (${e.bytes}字节)`),offset,limit,["仅列出目录；用entry指定文本条目，不执行代码、不递归解压"]);return{...result,entries:entries.slice(offset,offset+limit)};
 }
 if(ext===".rtf")return paginate("rtf",readRtfText(bytes).split(/\n+/),offset,limit,["提取文字，忽略嵌入对象与版式"]);
 if(!EXTENDED_READ_FORMATS.includes(ext as never))throw new Error("不支持该格式的扩展读取");
 if(bytes.length>2*1024*1024)throw new Error("文本文件超过2 MiB，请拆分读取");
 let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new Error("文本不是UTF-8编码，请先转码");}
 if(text.includes("\0"))throw new Error("文件不是纯文本");
 return paginate(ext.slice(1),text.split(/\r?\n/).map((v,i)=>`[第${i+1}行] ${v}`),offset,limit);
}
export async function mergePdf(workspace:string,input:{paths:string[];outputName:string}):Promise<string>{
 if(!Array.isArray(input.paths)||input.paths.length<2||input.paths.length>20)throw new Error("合并须提供2至20个PDF文件");
 const output=await PDFDocument.create();let pages=0,totalBytes=0;
 for(const path of input.paths){const data=await readWorkspaceFile(workspace,path);totalBytes+=data.length;if(totalBytes>40*1024*1024)throw new Error("PDF输入总量超过40 MiB");const doc=await PDFDocument.load(data,{updateMetadata:false});pages+=doc.getPageCount();if(pages>500)throw new Error("合并后超过500页");for(const page of await output.copyPages(doc,doc.getPageIndices()))output.addPage(page);}
 return publishFile(workspace,input.outputName,".pdf",await output.save());
}
