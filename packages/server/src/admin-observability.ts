import {outboundFetch} from './admin-network.ts';
import {randomBytes} from 'node:crypto';
import type {RequestMetric} from '@tao/agent-host';
import type {Values} from './admin-settings.ts';
import {checkEndpoint} from './admin-integrations.ts';
let inflight=0;
/** 仅导出不含提示词/正文/密钥的模型请求span，失败不影响业务。 */
export function exportMetric(metric:RequestMetric,values:Values):void{
 if(!values.OTLP_ENDPOINT||inflight>=4)return;
 let url:string;try{url=checkEndpoint(values.OTLP_ENDPOINT).toString();}catch{return;}
 const traceId=randomBytes(16).toString('hex'),spanId=randomBytes(8).toString('hex');
 const body={resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:values.BRAND_NAME||'tao-agent'}}]},scopeSpans:[{scope:{name:'tao-agent'},spans:[{traceId,spanId,name:'model.request',kind:3,startTimeUnixNano:String(BigInt(metric.at)*1000000n),endTimeUnixNano:String(BigInt(metric.at+metric.durationMs)*1000000n),attributes:[{key:'gen_ai.request.model',value:{stringValue:metric.model}},{key:'gen_ai.usage.total_tokens',value:{intValue:String(metric.tokens)}},{key:'tao.first_token_ms',value:{intValue:String(metric.firstTokenMs??-1)}}],status:{code:metric.status==='success'?1:2}}]}]}]};
 inflight++;void outboundFetch(values.NETWORK_ALLOWED_CIDRS)(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json',...(values.OTLP_AUTH_TOKEN?{[values.OTLP_AUTH_HEADER||'Authorization']:values.OTLP_AUTH_TOKEN}:{})},body:JSON.stringify(body)}).then(r=>{void r.body?.cancel();}).catch(()=>{}).finally(()=>{inflight--;});
}
