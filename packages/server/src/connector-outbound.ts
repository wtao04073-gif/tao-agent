import { createHash } from 'node:crypto';
import { outboundFetch } from './admin-network.ts';

export type NativeConnectorDelivery =
  | { kind:'feishu'; recipient:string; appId:string; appSecret:string }
  | { kind:'wecom'; recipient:string; corpId:string; corpSecret:string; agentId:string };
export const isNativeDelivery = (value:unknown):value is NativeConnectorDelivery => !!value&&typeof value==='object'&&'kind' in value&&['feishu','wecom'].includes(String(value.kind));
export function isSingleRecipient(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=256&&!/[|\s\u0000-\u001f\u007f]/.test(value)&&!value.toLowerCase().includes('@all');}
/** 消息请求已发出但无可信应答时禁止自动重发；人工核对后可显式重试。 */
export class NativeDeliveryUncertainError extends Error { constructor(){super('原生消息发送结果不确定，请先核对接收端再手动重试');} }
class NativeResponseError extends Error {
  readonly response:Response;
  constructor(response:Response){super('原生消息平台拒绝请求');this.response=response;}
}
function result(status:number,retryAfter?:string|null){return new Response(null,{status,...(retryAfter?{headers:{'retry-after':retryAfter}}:{})});}
function privateText(body:string,limit:number):string{
  const event=JSON.parse(body) as {taskId?:string;status?:string;result?:{text?:string;artifacts?:string[]}};
  const labels:Record<string,string>={SUCCEEDED:'任务已完成',FAILED:'任务失败',CANCELLED:'任务已取消',INTERRUPTED:'任务因重启中断'};
  const full=[labels[event.status??'']??'任务状态更新',event.taskId?'任务编号：'+event.taskId:'',event.result?.text??'',event.result?.artifacts?.length?'产物：'+event.result.artifacts.join('、'):''].filter(Boolean).join('\n\n');
  if(Buffer.byteLength(full)<=limit)return full;
  const suffix='\n\n内容已截断，请在工作台查看完整结果。';let text='';let bytes=0;const budget=limit-Buffer.byteLength(suffix);
  for(const char of full){const size=Buffer.byteLength(char);if(bytes+size>budget)break;text+=char;bytes+=size;}return text+suffix;
}
/** 原生API仅面向保存的单个收件人；访问令牌只缓存于该实例内存。 */
export class NativeConnectorSender {
  private readonly request:typeof fetch;
  private readonly now:()=>number;
  private readonly tokens=new Map<string,{value:string;expiresAt:number}>();
  constructor(options:{fetch?:typeof fetch;now?:()=>number}={}){this.request=options.fetch??outboundFetch('',65536);this.now=options.now??Date.now;}
  clear(){this.tokens.clear();}
  private key(target:NativeConnectorDelivery){return createHash('sha256').update(JSON.stringify(target.kind==='feishu'?[target.kind,target.appId,target.appSecret]:[target.kind,target.corpId,target.corpSecret])).digest('hex');}
  private async payload(response:Response,sending:boolean):Promise<Record<string,any>>{
    try{const raw=await response.text();if(Buffer.byteLength(raw)>65536)throw new Error();const data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();return data;}
    catch{if(sending)throw new NativeDeliveryUncertainError();throw new NativeResponseError(result(502));}
  }
  private async token(target:NativeConnectorDelivery,signal:AbortSignal):Promise<string>{
    const key=this.key(target),cached=this.tokens.get(key);if(cached&&cached.expiresAt>this.now())return cached.value;
    signal.throwIfAborted();
    const response=target.kind==='feishu'
      ?await this.request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({app_id:target.appId,app_secret:target.appSecret}),redirect:'error',signal})
      :await this.request('https://qyapi.weixin.qq.com/cgi-bin/gettoken?'+new URLSearchParams({corpid:target.corpId,corpsecret:target.corpSecret}),{redirect:'error',signal});
    if(!response.ok){await response.body?.cancel();throw new NativeResponseError(result(response.status,response.headers.get('retry-after')));}
    const data=await this.payload(response,false);const code=target.kind==='feishu'?data.code:data.errcode;
    if(code!==0){const temporary=code===-1||code===45009||code===99991400;throw new NativeResponseError(result(temporary?429:400));}
    const value=target.kind==='feishu'?data.tenant_access_token:data.access_token;const ttl=target.kind==='feishu'?data.expire:data.expires_in;
    if(typeof value!=='string'||!value||value.length>8192||typeof ttl!=='number'||ttl<=0)throw new NativeResponseError(result(502));
    for(const [id,token]of this.tokens)if(token.expiresAt<=this.now())this.tokens.delete(id);if(this.tokens.size>=512)this.tokens.delete(this.tokens.keys().next().value!);
    this.tokens.set(key,{value,expiresAt:this.now()+Math.max(1,Math.min(ttl,7200)-60)*1000});return value;
  }
  async send(target:NativeConnectorDelivery,body:string,eventId:string,signal:AbortSignal):Promise<Response>{
    if(!isSingleRecipient(target.recipient))return result(400);
    const text=privateText(body,target.kind==='wecom'?2048:12000);
    for(let refresh=0;refresh<2;refresh++){
      let token:string;try{token=await this.token(target,signal);}catch(error){if(error instanceof NativeResponseError)return error.response;throw error;}
      signal.throwIfAborted();
      let response:Response;
      try{
        // 飞书uuid稳定，企微开启原生重复校验；均不接受任务正文改变收件人。
        response=target.kind==='feishu'
          ?await this.request('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({receive_id:target.recipient,msg_type:'text',content:JSON.stringify({text}),uuid:eventId.slice(0,48)}),redirect:'error',signal})
          :await this.request('https://qyapi.weixin.qq.com/cgi-bin/message/send?'+new URLSearchParams({access_token:token}),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({touser:target.recipient,msgtype:'text',agentid:Number(target.agentId),text:{content:text},safe:0,enable_duplicate_check:1,duplicate_check_interval:1800}),redirect:'error',signal});
      }catch{throw new NativeDeliveryUncertainError();}
      if(response.status===401&&refresh===0){await response.body?.cancel();this.tokens.delete(this.key(target));continue;}
      if(!response.ok){await response.body?.cancel();return result(response.status,response.headers.get('retry-after'));}
      const data=await this.payload(response,true);const code=target.kind==='feishu'?data.code:data.errcode;
      if(code===0){if(target.kind==='wecom'&&(data.invaliduser||data.unlicenseduser))return result(400);return result(200);}
      const invalidToken=target.kind==='feishu'?[99991661,99991663,99991664,99991668].includes(code):[40014,42001].includes(code);
      if(invalidToken){this.tokens.delete(this.key(target));if(refresh===0)continue;return result(401);}
      return result(code===-1?503:[45009,45011,99991400].includes(code)?429:400);
    }
    return result(401);
  }
}
