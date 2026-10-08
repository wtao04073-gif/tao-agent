/** 模型HTTP出口预算。重试同样经过fetch，每次请求独立预留。 */
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
export interface RequestMetric {model:string;at:number;durationMs:number;firstTokenMs:number|null;status:string;tokens:number}
export interface ModelControls {checkOutput?:(text:string,signal:AbortSignal)=>Promise<void>;retryCount?:number;retryBaseMs?:number;rpm?:number;tpm?:number;concurrency?:number;timeoutMs?:number;budgetFile?:string;fetch?:typeof fetch;isEnabled?:()=>boolean;requestBudget?:{reserve(tokens:number):(actual:number)=>void};onMetric?:(metric:RequestMetric)=>void}
interface Reservation {at:number;tokens:number}
interface Budget {active:number;requests:Reservation[]}
const budgets=new Map<string,Budget>();
export function controlledProvider(provider:any,controls:ModelControls) {
 const key=controls.budgetFile||provider.id;
 let budget=budgets.get(key);
 if(!budget){let requests:Reservation[]=[];if(controls.budgetFile&&existsSync(controls.budgetFile)){const parsed=JSON.parse(readFileSync(controls.budgetFile,'utf8'));if(!Array.isArray(parsed)||parsed.some(r=>!r||!Number.isFinite(r.at)||!Number.isFinite(r.tokens)||r.tokens<0))throw new Error('模型预算记录无效');requests=parsed.filter(r=>r.at>Date.now()-60000);}budget={active:0,requests};budgets.set(key,budget);}
 const state=budget;
 const persist=()=>{if(controls.budgetFile){mkdirSync(dirname(controls.budgetFile),{recursive:true,mode:0o700});const path=controls.budgetFile+'.tmp';const fd=openSync(path,'w',0o600);try{writeFileSync(fd,JSON.stringify(state.requests));fsyncSync(fd);}finally{closeSync(fd);}renameSync(path,controls.budgetFile);}};
 const wrap=(method:string)=>(model:any,context:any,options:any={})=>{
  const output=createAssistantMessageEventStream();
  void(async()=>{let moderationFailed=false;let acquired=false;const start=Date.now();let first:number|null=null,tokens=0,status='error';let last:Reservation|undefined;let settle:((actual:number)=>void)|undefined;
   const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(controls.timeoutMs||120000)]);
   const wait=(delayMs=100)=>new Promise<void>((resolve,reject)=>{signal.throwIfAborted();const timer=setTimeout(done,delayMs);function done(){signal.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new Error('请求等待已取消或超时'));}signal.addEventListener('abort',abort,{once:true});});
   try{
    while(state.active>=(controls.concurrency||3)){signal.throwIfAborted();await wait();}signal.throwIfAborted();state.active++;acquired=true;
    let upstreamStatus=0,retried=0;
    const transport:typeof fetch=async(input,init)=>{
     const template=input instanceof Request?input.clone():input;
     for(let attempt=0;;attempt++){
     if(controls.isEnabled&&!controls.isEnabled())throw new Error('模型已暂停');
     const raw=typeof init?.body==='string'?init.body:JSON.stringify(context);
     // UTF-8字节数是保守上界估计，非服务商的精确Tokenizer。
     let maxOutput=model.maxTokens||4096;try{const body=JSON.parse(raw);maxOutput=body.max_tokens||body.max_completion_tokens||maxOutput;}catch{}
     const reserve=Buffer.byteLength(raw,'utf8')+maxOutput;
     if(controls.tpm&&reserve>controls.tpm)throw new Error('单次请求预留Token超过TPM预算');
     while(true){signal.throwIfAborted();if(controls.isEnabled&&!controls.isEnabled())throw new Error('模型已暂停');const now=Date.now();state.requests=state.requests.filter(r=>r.at>now-60000);
      if((!controls.rpm||state.requests.length<controls.rpm)&&(!controls.tpm||state.requests.reduce((n,r)=>n+r.tokens,0)+reserve<=controls.tpm)){settle=controls.requestBudget?.reserve(reserve);last={at:now,tokens:reserve};state.requests.push(last);persist();break;}
      await wait();
     }
     const response=await (controls.fetch||options.fetch||fetch)(template instanceof Request?template.clone():template,{...init,redirect:'error',signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});
     upstreamStatus=response.status;
     if(![429,502,503,504].includes(response.status)||attempt>=(controls.retryCount??3))return response;
     retried++;
     // 仅重试尚未消费响应的HTTP请求，不重放Agent回合或已执行的工具。
     const rawAfter=response.headers.get('retry-after');
     const requested=rawAfter?(Number.isFinite(Number(rawAfter))?Number(rawAfter)*1000:Date.parse(rawAfter)-Date.now()):0;
     const delay=Math.max(Number.isFinite(requested)?requested:0,Math.min(30000,(controls.retryBaseMs??1000)*2**attempt));
     await response.body?.cancel();status='retrying-'+upstreamStatus;
     await wait(delay);signal.throwIfAborted();
     }
    };
    const buffered:any[]=[];let bufferedBytes=0;
    for await(const event of provider[method](model,context,{...options,signal,fetch:transport})){
     if(first===null&&(event.type==='text_delta'||event.type==='thinking_delta'))first=Date.now()-start;
     if(event.type==='error')status='error';
     if(event.type==='done'){status='success';tokens=event.message.usage?.totalTokens||0;if(last&&tokens>0){last.tokens=tokens;settle?.(tokens);persist();}}
     if(controls.checkOutput&&event.type!=='error'){bufferedBytes+=Buffer.byteLength(JSON.stringify(event));if(bufferedBytes>8*1024*1024||buffered.length>=4096){moderationFailed=true;throw Error('moderation buffer limit');}buffered.push(structuredClone(event));if(event.type==='done'){try{await controls.checkOutput((event.message.content||[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n'),signal);}catch{moderationFailed=true;throw Error('moderation');}for(const saved of buffered)output.push(saved);}continue;}
     output.push(event.type==='error'?{...event,error:{...event.error,errorMessage:upstreamStatus===429?'模型服务限流，已等待并重试'+retried+'次，请稍后重试或调整限流设置':'模型服务请求失败，请管理员检查连接、额度或取消状态'}}:event);
    }
   }catch{status=moderationFailed?'moderation_error':'error';output.push({type:'error',reason:'error',error:{role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,stopReason:'error',errorMessage:moderationFailed?'内容未通过已配置审核服务，或审核服务暂不可用':'模型请求受限、取消或超时，请检查模型限流与连接配置',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}} as any);}
   finally{if(acquired)state.active--;try{controls.onMetric?.({model:model.id,at:start,durationMs:Date.now()-start,firstTokenMs:first,status,tokens});}catch{}output.end();}
  })();return output;
 };
 return {...provider,stream:wrap('stream'),streamSimple:wrap('streamSimple')};
}
