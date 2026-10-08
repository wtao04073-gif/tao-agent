import { AdminError } from './admin-settings.ts';
export interface EvaluationCase { id:string;query:string;expected:string[];tags:string[];jsonKeys:string[];tools:string[] }
export interface EvaluationOutcome { answer:string;taskId:string;status:string;tokens?:number;tools?:string[] }
export function parseCases(input:unknown):EvaluationCase[]{
 if(!Array.isArray(input)||!input.length||input.length>100)throw new AdminError(400,'评测集须有1至100个用例');
 const strings=(value:unknown,label:string,max=50):string[]=>{if(value===undefined)return [];if(!Array.isArray(value)||value.length>max||value.some(s=>typeof s!=='string'||!s.trim()||s.length>500))throw new AdminError(400,label+'须为非空文本数组');return [...new Set(value.map(s=>s.trim()))];};
 const ids=new Set<string>();return input.map((c,index)=>{
  if(!c||typeof c.query!=='string'||!c.query.trim()||c.query.length>4000)throw new AdminError(400,'用例输入须为1至4000字符');
  const id=c.id??'case-'+(index+1);if(typeof id!=='string'||!/^[\w-]{1,80}$/.test(id)||ids.has(id))throw new AdminError(400,'用例编号无效或重复');ids.add(id);
  return {id,query:c.query.trim(),expected:strings(c.expected,'预期关键词'),tags:strings(c.tags,'标签',20),jsonKeys:strings(c.jsonKeys,'JSON字段'),tools:strings(c.tools,'预期工具')};
 });
}
export function scoreCase(c:EvaluationCase,r:EvaluationOutcome){
 const checks=[{rule:'task_status',expected:'SUCCEEDED',passed:r.status==='SUCCEEDED'}];
 for(const keyword of c.expected)checks.push({rule:'keyword',expected:keyword,passed:r.answer.includes(keyword)});
 if(c.jsonKeys?.length){let json:unknown;try{json=JSON.parse(r.answer.replace(/^```(?:json)?\s*\n?/,'').replace(/\n?```\s*$/,''));}catch{}
  for(const key of c.jsonKeys)checks.push({rule:'json_key',expected:key,passed:!!json&&typeof json==='object'&&!Array.isArray(json)&&Object.hasOwn(json,key)});
 }
 for(const tool of c.tools??[])checks.push({rule:'tool_success',expected:tool,passed:r.tools?.includes(tool)??false});
 return {passed:checks.every(c=>c.passed),checks};
}
