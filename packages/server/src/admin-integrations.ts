import {outboundFetch} from './admin-network.ts';
import type { PlatformTool } from '@tao/core';
import type { Values } from './admin-settings.ts';
import { AdminError } from './admin-settings.ts';
export function checkEndpoint(value:string){let u:URL;try{u=new URL(value);}catch{throw new AdminError(400,'服务地址无效');}if(u.username||u.password||u.hash||u.search||!['https:','http:'].includes(u.protocol))throw new AdminError(400,'服务地址须为无凭据的HTTP(S)地址');if(u.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw new AdminError(400,'非本机服务必须使用HTTPS');if(/^(169\.254\.|0\.|metadata\.)/.test(u.hostname))throw new AdminError(400,'不能访问元数据地址');return u;}
export function searchTool(values:Values):PlatformTool[] {if(values.SEARCH_ENABLED!=='true'||values.ALLOW_OUTBOUND_NETWORK!=='true'||!['tavily','brave'].includes(values.SEARCH_PROVIDER||'')||!values.SEARCH_API_KEY)return [];return [{name:'web_search',label:'联网搜索',replay:'safe',description:'检索互联网公开信息并返回来源链接。不能替代读取用户附件。',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']},async execute({args,signal}){const query=(args as {query?:unknown}).query;if(typeof query!=='string'||!query.trim()||query.length>1000)throw new Error('搜索问题须为1至1000字符');const limit=Number(values.SEARCH_MAX_RESULTS||5), transport=outboundFetch(values.NETWORK_ALLOWED_CIDRS,1024*1024);let response:Response;
 if(values.SEARCH_PROVIDER==='tavily')response=await transport('https://api.tavily.com/search',{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(Number(values.SEARCH_TIMEOUT_MS||15000))]),headers:{'Content-Type':'application/json',Authorization:'Bearer '+values.SEARCH_API_KEY},body:JSON.stringify({query,max_results:limit,include_raw_content:false})});
 else response=await transport('https://api.search.brave.com/res/v1/web/search?'+new URLSearchParams({q:query,count:String(limit)}),{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(Number(values.SEARCH_TIMEOUT_MS||15000))]),headers:{'X-Subscription-Token':values.SEARCH_API_KEY!}});
 if(!response.ok)return {isError:true,text:'搜索服务请求失败（'+response.status+'），请管理员检查密钥或配额'};const data:any=await response.json();const results=values.SEARCH_PROVIDER==='tavily'?data.results:data.web?.results;if(results!==undefined&&!Array.isArray(results))throw new Error('搜索响应无效');return {text:JSON.stringify((results||[]).slice(0,limit).map((r:any)=>({title:String(r.title||'').slice(0,300),url:String(r.url||''),content:String(r.content||r.description||'').slice(0,4000)}))),details:{provider:values.SEARCH_PROVIDER}};}}];}
export function parseMcp(values:Values,tenantId='default',workspaceId='default') {
 if(values.MCP_ENABLED!=='true')return [];
 if(values.ALLOW_OUTBOUND_NETWORK!=='true')throw new AdminError(400,'请先允许联网工具出网');
 if(!values.MCP_NAME||!values.MCP_URL||!values.MCP_TOOLS)throw new AdminError(400,'MCP须填写名称、地址和工具白名单');
 checkEndpoint(values.MCP_URL);
 const header=values.MCP_AUTH_HEADER||'Authorization';if(!/^[A-Za-z0-9-]+$/.test(header))throw new AdminError(400,'认证头无效');
 return [{name:values.MCP_NAME,url:values.MCP_URL,tools:values.MCP_TOOLS.split(',').map(s=>s.trim()).filter(Boolean),tenantId,workspaceId,fetch:outboundFetch(values.NETWORK_ALLOWED_CIDRS),...(values.MCP_AUTH_TOKEN?{headers:{[header]:values.MCP_AUTH_TOKEN}}:{})}];
}
