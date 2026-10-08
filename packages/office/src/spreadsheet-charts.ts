import { strToU8, strFromU8, zipSync } from "fflate";
import type ExcelJS from "exceljs";
import { readBoundedZip } from "./file-safety.ts";
export interface SpreadsheetChart { type: "bar" | "line" | "pie"; title?: string; categoryRange: string; series: { name: string; range: string }[] }
const esc=(s:string)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
function cells(sheet:ExcelJS.Worksheet,input:string):{refs:string;values:(string|number)[]}{
 const m=/^([A-Z]{1,2})([1-9]\d{0,3}):\1([1-9]\d{0,3})$/.exec(input);
 if(!m||+m[3]!<+m[2]!||+m[3]!-+m[2]!>99)throw new Error("图表引用须是同列1至100行区域，如A2:A10");
 const values:(string|number)[]=[];
 for(let r=+m[2]!;r<=+m[3]!;r++){const cell=sheet.getCell(`${m[1]}${r}`),v=cell.value;if(v&&typeof v==="object"&&"formula"in v)throw new Error("图表数据引用暂不支持未重算公式，请提供原始数值");values.push(typeof v==="number"?v:typeof v==="string"?v:"");}
 return{refs:`'${sheet.name.replace(/'/g,"''")}'!$${m[1]}$${m[2]}:$${m[1]}$${m[3]}`,values};
}
/** 为ExcelJS生成的基础工作簿增加ECMA-376原生图表部件，数据引用仍指向原单元格。 */
export function addWorkbookCharts(bytes:Buffer,book:ExcelJS.Workbook,charts:readonly (readonly SpreadsheetChart[]|undefined)[]):Uint8Array{
 if(!charts.some(c=>c?.length))return bytes;
 const files=readBoundedZip(bytes);let id=0,types=strFromU8(files["[Content_Types].xml"]!);
 const chartNs="http://schemas.openxmlformats.org/drawingml/2006/chart",drawNs="http://schemas.openxmlformats.org/drawingml/2006/main",relNs="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
 charts.forEach((list,idx)=>{
  if(!list?.length)return;if(list.length>5)throw new Error("每张工作表最多5个图表");
  const sheet=book.worksheets[idx]!,drawingId=idx+1;let anchors="",rels="";
  list.forEach((chart,chartIndex)=>{
   if(!["bar","line","pie"].includes(chart.type)||!Array.isArray(chart.series)||!chart.series.length||chart.series.length>10||(chart.type==="pie"&&chart.series.length!==1))throw new Error("图表类型或系列数量无效");
   const categories=cells(sheet,chart.categoryRange);id++;
   const cache=(values:(string|number)[],tag:string)=>`<c:${tag}><c:ptCount val="${values.length}"/>${values.map((v,i)=>`<c:pt idx="${i}"><c:v>${esc(String(v))}</c:v></c:pt>`).join("")}</c:${tag}>`;
   const series=chart.series.map((s,i)=>{
    if(typeof s.name!=="string"||s.name.length>100)throw new Error("图表系列名称无效");const v=cells(sheet,s.range);if(v.values.length!==categories.values.length||v.values.some(n=>typeof n!=="number"||!Number.isFinite(n)))throw new Error("图表数据须为与类别数量相同的有限数字");
    return`<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx><c:cat><c:strRef><c:f>${esc(categories.refs)}</c:f>${cache(categories.values,"strCache")}</c:strRef></c:cat><c:val><c:numRef><c:f>${esc(v.refs)}</c:f>${cache(v.values,"numCache")}</c:numRef></c:val></c:ser>`;
   }).join("");
   if(chart.title!==undefined&&(typeof chart.title!=="string"||chart.title.length>500))throw new Error("图表标题无效");
   const title=chart.title?`<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${esc(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`:"";
   const kind=chart.type+"Chart",options=chart.type==="bar"?'<c:barDir val="col"/><c:grouping val="clustered"/>':chart.type==="line"?'<c:grouping val="standard"/>':"";
   const axisIds=chart.type==="pie"?"":'<c:axId val="123456"/><c:axId val="123457"/>';
   const axes=chart.type==="pie"?"":'<c:catAx><c:axId val="123456"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="123457"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="123457"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="123456"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>';
   files[`xl/charts/chart${id}.xml`]=strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${chartNs}" xmlns:a="${drawNs}" xmlns:r="${relNs}"><c:chart>${title}<c:plotArea><c:layout/><c:${kind}>${options}${series}${axisIds}</c:${kind}>${axes}</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`);
   types=types.replace("</Types>",`<Override PartName="/xl/charts/chart${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
   rels+=`<Relationship Id="rId${chartIndex+1}" Type="${relNs}/chart" Target="../charts/chart${id}.xml"/>`;
   const start=chartIndex*17;
   anchors+=`<xdr:twoCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${start}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>15</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${start+16}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${chartIndex+1}" name="图表${chartIndex+1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${chartNs}"><c:chart xmlns:c="${chartNs}" xmlns:r="${relNs}" r:id="rId${chartIndex+1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  });
  files[`xl/drawings/drawing${drawingId}.xml`]=strToU8(`<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${drawNs}">${anchors}</xdr:wsDr>`);
  files[`xl/drawings/_rels/drawing${drawingId}.xml.rels`]=strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`);
  const sheetPath=`xl/worksheets/sheet${drawingId}.xml`,relsPath=`xl/worksheets/_rels/sheet${drawingId}.xml.rels`,rid="rIdOfficeChart";
  files[sheetPath]=strToU8(strFromU8(files[sheetPath]!).replace("</worksheet>",`<drawing r:id="${rid}"/></worksheet>`));
  let sheetRels=files[relsPath]?strFromU8(files[relsPath]!):'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  sheetRels=sheetRels.replace("</Relationships>",`<Relationship Id="${rid}" Type="${relNs}/drawing" Target="../drawings/drawing${drawingId}.xml"/></Relationships>`);files[relsPath]=strToU8(sheetRels);
  types=types.replace("</Types>",`<Override PartName="/xl/drawings/drawing${drawingId}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
 });files["[Content_Types].xml"]=strToU8(types);return zipSync(files,{level:1});
}
