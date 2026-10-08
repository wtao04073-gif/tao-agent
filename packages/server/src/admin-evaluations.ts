import {parseCases,scoreCase,type EvaluationCase,type EvaluationOutcome} from './evaluation-rules.ts';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, AdminError } from './admin-settings.ts';
import type { Principal } from './app.ts';

export interface EvaluationBudget {
 readonly runId: string;
 usedTokens: number;
 usedCost: number;
 exceeded: boolean;
 reserve(tokens: number): (actual: number) => void;
}
type Case = EvaluationCase;
interface Dataset { id: string; tenantId: string; name: string; cases: Case[] }
type Outcome = EvaluationOutcome;
interface Result extends Outcome { caseId?:string;tags?:string[];checks?:{rule:string;expected:string;passed:boolean}[]; query: string; expected: string[]; passed: boolean; review: {result:string;by:string;at:number}|null }
interface Run { id:string;tenantId:string;datasetId:string;revision:number;status:string;createdAt:number;results:Result[];tokens:number;costYuan:number|null }
export class Evaluations {
 private controllers=new Map<string,AbortController>();
 private readonly path:string;
 private data:{datasets:Dataset[];runs:Run[]};
 constructor(root:string){
  mkdirSync(join(root,'.admin'),{recursive:true,mode:0o700});this.path=join(root,'.admin','evaluations.json');
  this.data=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{datasets:[],runs:[]};
  for(const r of this.data.runs)if(r.status==='running')r.status='interrupted';this.save();
 }
 get busy(){return this.controllers.size>0;}
 private save(){atomicJson(this.path,this.data);}
 list(p:Principal){return {datasets:this.data.datasets.filter(x=>x.tenantId===p.tenant.tenantId),runs:this.data.runs.filter(x=>x.tenantId===p.tenant.tenantId).slice(-100).reverse()};}
 dataset(p:Principal,input:any){
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>200||!Array.isArray(input.cases)||!input.cases.length||input.cases.length>100)throw new AdminError(400,'评测集须有名称和1至100个用例');
  const d:Dataset={id:randomUUID(),tenantId:p.tenant.tenantId,name:input.name,cases:parseCases(input.cases)};
  this.data.datasets.push(d);this.save();return d;
 }
 start(p:Principal,id:string,revision:number,maxCases:number,execute:(query:string,signal:AbortSignal,budget:EvaluationBudget)=>Promise<Outcome>,maxTokens=100000,concurrency=1,maxCost?:number,pricePerMillion?:number) {
  const d=this.data.datasets.find(x=>x.id===id&&x.tenantId===p.tenant.tenantId);
  if(!d)throw new AdminError(404,'评测集不存在');if(d.cases.length>maxCases)throw new AdminError(400,'评测集超过本次配置上限');if(this.busy)throw new AdminError(409,'已有评测运行中');
  if(maxCost!==undefined&&pricePerMillion===undefined)throw new AdminError(400,'使用费用预算前须配置评测模型的全部单价');
  const controller=new AbortController();
  const run:Run={id:randomUUID(),tenantId:p.tenant.tenantId,datasetId:id,revision,status:'running',createdAt:Date.now(),results:[],tokens:0,costYuan:null};
  const budget:EvaluationBudget={runId:run.id,usedTokens:0,usedCost:0,exceeded:false,reserve(tokens){
   if(this.exceeded||this.usedTokens+tokens>maxTokens||(maxCost!==undefined&&this.usedCost+tokens*(pricePerMillion||0)/1e6>maxCost)){this.exceeded=true;throw new AdminError(429,'评测预算已用尽');}
   this.usedTokens+=tokens;this.usedCost+=tokens*(pricePerMillion||0)/1e6;
   let settled=false;return actual=>{if(settled)return;settled=true;this.usedTokens+=actual-tokens;this.usedCost+=(actual-tokens)*(pricePerMillion||0)/1e6;};
  }};
  this.data.runs.push(run);this.controllers.set(run.id,controller);this.save();let next=0;
  const worker=async()=>{while(next<d.cases.length&&run.status==='running'&&!budget.exceeded){const index=next++,c=d.cases[index]!;let r:Outcome;try{r=await execute(c.query,controller.signal,budget);}catch{r={answer:'',taskId:'',status:controller.signal.aborted?'CANCELLED':budget.exceeded?'BUDGET_EXCEEDED':'FAILED'};}run.results.push({...r,caseId:c.id??'case-'+(index+1),tags:c.tags??[],query:c.query,expected:c.expected,...scoreCase(c,r),review:null});run.tokens=budget.usedTokens;run.costYuan=pricePerMillion===undefined?null:budget.usedCost;this.save();}};
  void(async()=>{try{const results=await Promise.allSettled(Array.from({length:Math.max(1,Math.min(concurrency,d.cases.length,5))},worker));if(run.status==='running')run.status=budget.exceeded?'budget_exceeded':results.some(r=>r.status==='rejected')?'failed':'completed';}finally{run.tokens=budget.usedTokens;run.costYuan=pricePerMillion===undefined?null:budget.usedCost;this.controllers.delete(run.id);this.save();}})().catch(()=>{});
  return run;
 }
 compare(p:Principal,baseId:string,targetId:string){
  const owned=(id:string)=>this.data.runs.find(r=>r.id===id&&r.tenantId===p.tenant.tenantId);
  const base=owned(baseId),target=owned(targetId);if(!base||!target)throw new AdminError(404,'评测记录不存在');
  if(base.datasetId!==target.datasetId)throw new AdminError(400,'请选择同一评测集的两次运行');
  if([base,target].some(r=>r.status==='running'))throw new AdminError(409,'请等待评测完成后对比');
  const dataset=this.data.datasets.find(d=>d.id===base.datasetId)!;
  return {base:{id:base.id,revision:base.revision,tokens:base.tokens,costYuan:base.costYuan},target:{id:target.id,revision:target.revision,tokens:target.tokens,costYuan:target.costYuan},cases:dataset.cases.map((c,i)=>{
   const find=(r:Run)=>r.results.find(x=>x.caseId?x.caseId===(c.id??'case-'+(i+1)):x.query===c.query);
   const a=find(base),b=find(target);return {caseId:c.id??'case-'+(i+1),query:c.query,tags:c.tags??[],base:a??null,target:b??null,change:!a||!b?'unverified':a.passed===b.passed?'unchanged':b.passed?'improved':'regressed'};
  })};
 }
 cancel(p:Principal,id:string){const r=this.data.runs.find(x=>x.id===id&&x.tenantId===p.tenant.tenantId);if(!r)throw new AdminError(404,'评测不存在');if(r.status==='running'){r.status='cancelled';this.controllers.get(id)?.abort();this.save();}return r;}
 review(p:Principal,id:string,index:number,review:string){const r=this.data.runs.find(x=>x.id===id&&x.tenantId===p.tenant.tenantId);if(!Number.isInteger(index)||!r?.results[index]||!['pass','fail'].includes(review))throw new AdminError(400,'复核参数无效');r.results[index]!.review={result:review,by:p.tenant.userId,at:Date.now()};this.save();return r;}
}
