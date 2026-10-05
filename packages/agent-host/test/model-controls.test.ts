import { expect,it } from 'vitest';import {controlledProvider} from '../src/model-controls.ts';import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
function provider(){return {id:'test-'+Math.random(),stream(_m:any,_c:any,opts:any){const s=createAssistantMessageEventStream();void(async()=>{try{await opts.fetch('http://localhost',{body:'{}'});s.push({type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text:'OK'}],usage:{totalTokens:1}}} as any);}catch{ s.push({type:'error',reason:'error',error:{errorMessage:'blocked'}} as any);}s.end();})();return s;}};}
it('实际请求RPM超限时不出网且可取消',async()=>{let calls=0;const p=controlledProvider(provider(),{rpm:1,timeoutMs:80});const model={id:'x',maxTokens:1};const fetcher=async()=>{calls++;return new Response('{}');};await p.stream(model,{}, {fetch:fetcher}).result();const second=await p.stream(model,{}, {fetch:fetcher}).result();expect(calls).toBe(1);expect(second.errorMessage).toBeTruthy();});
it('TPM不足时请求零次出网',async()=>{let calls=0;const p=controlledProvider(provider(),{tpm:1,timeoutMs:100});await p.stream({id:'x',maxTokens:10},{},{fetch:async()=>{calls++;return new Response('{}');}}).result();expect(calls).toBe(0);});
it('请求并发上限与等待取消不会泄漏席位',async()=>{
 let active=0,peak=0,release:()=>void=()=>{};const p=controlledProvider(provider(),{concurrency:1,timeoutMs:2000});
 const fetcher=async()=>{active++;peak=Math.max(peak,active);await new Promise<void>(r=>{release=r;});active--;return new Response('{}');};
 const first=p.stream({id:'x',maxTokens:1},{},{fetch:fetcher});await new Promise(r=>setTimeout(r,10));
 const abort=new AbortController(),second=p.stream({id:'x',maxTokens:1},{},{fetch:fetcher,signal:abort.signal});abort.abort();expect((await second.result()).errorMessage).toBeTruthy();release();await first.result();
 await p.stream({id:'x',maxTokens:1},{},{fetch:async()=>new Response('{}')}).result();expect(peak).toBe(1);expect(active).toBe(0);
});
it('同一SDK执行中的再次HTTP请求也经过RPM预算',async()=>{
 let calls=0;const base=provider();base.stream=(_m:any,_c:any,o:any)=>{const s=createAssistantMessageEventStream();void(async()=>{try{await o.fetch('http://localhost',{body:'{}'});await o.fetch('http://localhost',{body:'{}'});}catch{}s.push({type:'done',reason:'stop',message:{role:'assistant',content:[],usage:{totalTokens:1}}} as any);s.end();})();return s;};
 await controlledProvider(base,{rpm:1,timeoutMs:50}).stream({id:'x',maxTokens:1},{},{fetch:async()=>{calls++;return new Response('{}');}}).result();expect(calls).toBe(1);
});
