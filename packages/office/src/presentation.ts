import PptxGenJSImport from "pptxgenjs";
// PptxGenJS 4.x导出映射的Node16声明多包一层default，运行时ESM仍直接导出构造器。
const PptxGenJS = PptxGenJSImport as unknown as typeof PptxGenJSImport.default;
import { boundedJson, publishFile, readWorkspaceFile } from "./file-safety.ts";
export interface PresentationSpec {
 outputName: string; title: string; theme?: { font?: string; accent?: string; background?: string; text?: string };
 slides: { title: string; body?: string[]; notes?: string; imagePath?: string; chart?: { type: "bar" | "line" | "pie"; title?: string; categories: string[]; series: { name: string; values: number[] }[] } }[];
}
export async function writePresentation(workspace: string, input: PresentationSpec): Promise<string> {
 boundedJson(input);
 if(!input||typeof input.title!=="string"||!input.title.trim()||!Array.isArray(input.slides)||!input.slides.length||input.slides.length>100)throw new Error("演示稿须提供标题及1至100张幻灯片");
 const theme=input.theme??{},accent=theme.accent??"2563EB",background=theme.background??"FFFFFF",text=theme.text??"172033",font=theme.font??"Microsoft YaHei";
 for(const color of [accent,background,text])if(!/^[0-9a-f]{6}$/i.test(color))throw new Error("主题颜色须为6位十六进制");
 if(typeof font!=="string"||font.length>100)throw new Error("主题字体无效");
 const deck=new PptxGenJS();deck.layout="LAYOUT_WIDE";deck.title=input.title;deck.author="";deck.subject=input.title;deck.company="";
 deck.theme={headFontFace:font,bodyFontFace:font};
 let imageBytes=0;
 for(const [index,data] of input.slides.entries()){
  if(typeof data.title!=="string"||data.title.length>500||(data.body!==undefined&&(!Array.isArray(data.body)||data.body.length>30||data.body.some(v=>typeof v!=="string"||v.length>3000))))throw new Error("幻灯片标题或正文超过限制");
  const slide=deck.addSlide();slide.background={color:background};
  slide.addShape(deck.ShapeType.rect,{x:0,y:0,w:0.16,h:7.5,line:{color:accent},fill:{color:accent}});
  slide.addText(data.title,{x:0.55,y:0.35,w:12.1,h:0.8,fontFace:font,fontSize:28,bold:true,color:text,breakLine:false,fit:"shrink"});
  const visual=!!(data.chart||data.imagePath),bodyWidth=visual?5.2:12;
  if(data.body?.length)slide.addText(data.body.map(v=>({text:v,options:{bullet:{indent:16},breakLine:true}})),{x:0.65,y:1.45,w:bodyWidth,h:5.2,fontFace:font,fontSize:19,color:text,paraSpaceAfter:14,fit:"shrink",valign:"top"});
  if(data.imagePath){
   const bytes=await readWorkspaceFile(workspace,data.imagePath,5*1024*1024);imageBytes+=bytes.length;if(imageBytes>15*1024*1024)throw new Error("演示稿图片总量超过15 MiB");
   const png=bytes.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex")),jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
   if(!png&&!jpeg)throw new Error("图片仅支持真实PNG/JPEG文件，不接受远程地址或SVG");
   const mime=png?"image/png":"image/jpeg";
   slide.addImage({data:`data:${mime};base64,${bytes.toString("base64")}`,x:6.2,y:1.5,w:6.4,h:data.chart?2.1:4.8,sizing:{type:"contain",w:6.4,h:data.chart?2.1:4.8}});
  }
  if(data.chart){
   const c=data.chart;
   if(!["bar","line","pie"].includes(c.type)||!Array.isArray(c.categories)||!c.categories.length||c.categories.length>100||c.categories.some(v=>typeof v!=="string"||v.length>200)||!Array.isArray(c.series)||!c.series.length||c.series.length>10)throw new Error("图表须包含1至100个类别和1至10个数据系列");
   if(c.type==="pie"&&c.series.length!==1)throw new Error("饼图只能包含一个数据系列");
   for(const s of c.series)if(typeof s.name!=="string"||s.name.length>100||!Array.isArray(s.values)||s.values.length!==c.categories.length||s.values.some(v=>!Number.isFinite(v)))throw new Error("图表系列长度须与类别一致，数值必须有限");
   slide.addChart(deck.ChartType[c.type],c.series.map(s=>({name:s.name,labels:c.categories,values:s.values})),{x:6.2,y:data.imagePath?4:1.5,w:6.4,h:data.imagePath?2.5:4.9,showTitle:!!c.title,...(c.title?{title:c.title}:{}),showLegend:c.series.length>1,catAxisLabelFontFace:font,valAxisLabelFontFace:font,chartColors:[accent,"22C55E","F59E0B","8B5CF6"],showValue:c.type==="pie"});
  }
  slide.addText(`${index+1} / ${input.slides.length}`,{x:11.7,y:7,w:1.1,h:0.2,fontSize:10,color:"64748B",align:"right"});
  if(data.notes!==undefined){if(typeof data.notes!=="string"||data.notes.length>20000)throw new Error("备注超过限制");slide.addNotes(data.notes);}
 }
 const bytes=await deck.write({outputType:"nodebuffer"});
 return publishFile(workspace,input.outputName,".pptx",bytes as Buffer);
}
