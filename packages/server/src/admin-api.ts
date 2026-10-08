import {createOriginPolicy} from './request-origin.ts';
import {ConnectionChecks,type ConnectionType} from './admin-connections.ts';
import {outboundFetch} from './admin-network.ts';
import {HttpEmbeddings} from '@tao/knowledge';
import {createMcpToolset} from '@tao/agent-host';
import type { IncomingMessage,ServerResponse } from 'node:http';
import { Role } from '@tao/core';
import { timingSafeEqual } from 'node:crypto';
import { readJsonBody,sendError,sendJson,type Principal } from './app.ts';
import { AdminSettings,AdminError,type Values } from './admin-settings.ts';
import { AdminIdentity } from './admin-identity.ts';
import { Evaluations, type EvaluationBudget } from './admin-evaluations.ts';
import { checkEndpoint,searchTool,parseMcp } from './admin-integrations.ts';
export function sessionToken(req:IncomingMessage){return (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('tao_session='))?.slice(12)||'';}
export function createAdminHandler(deps:{settings:AdminSettings;withSeat?:<T>(tenantId:string,accountId:string|undefined,operation:()=>Promise<T>|T)=>Promise<T>;testSandbox?:(values:Values)=>Promise<unknown>;releaseSandbox?:(p:Principal,id:string)=>Promise<void>;originAllowed?:(req:IncomingMessage)=>boolean;connections?:ConnectionChecks;identity:AdminIdentity;bootstrapToken?:string;authenticate:(req:IncomingMessage)=>Promise<Principal|undefined>;apply:(values:Values)=>()=>void;observability:(p:Principal)=>unknown;trace?:(p:Principal,id:string)=>unknown;evaluations:Evaluations;suspend?:()=>Promise<void>;accountChanged?:(p:Principal,id:string,workspaceId:string)=>Promise<void>;evaluate:(p:Principal,query:string,signal:AbortSignal,budget:EvaluationBudget)=>Promise<{answer:string;taskId:string;status:string;tokens?:number;tools?:string[]}>}){
 const {settings,identity}=deps;const originAllowed=deps.originAllowed??createOriginPolicy();
 const cookie=(req:IncomingMessage,res:ServerResponse,token:string)=>res.setHeader('Set-Cookie',`tao_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token?28800:0}`+(req.headers['x-forwarded-proto']==='https'?'; Secure':''));
 return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
 const path=new URL(req.url||'/','http://local').pathname;let checkedType:ConnectionType|undefined,checkedValues:Values|undefined;
 if(!path.startsWith('/api/control/')&&!path.startsWith('/api/auth/')&&path!=='/api/branding')return false;
 try{
 res.setHeader('Cache-Control','no-store');
 const session=identity.session(sessionToken(req));
 const body=async()=>{const b=await readJsonBody(req);if(!b.ok)throw new AdminError(400,b.reason);return b.value as any;};
 const write=!['GET','HEAD'].includes(req.method||'GET');
 if(write&&!originAllowed(req))throw new AdminError(403,'请求来源无效');
 if(write&&session&&!req.headers.authorization&&path!=='/api/auth/login'&&req.headers['x-csrf-token']!==session.csrf)throw new AdminError(403,'安全校验已失效，请刷新页面');
 if(path==='/api/branding'&&req.method==='GET'){const v=settings.effective("global");sendJson(res,200,{name:v.BRAND_NAME||'Tao Agent',shortName:v.BRAND_SHORT_NAME||'Tao',welcome:v.BRAND_WELCOME,description:v.BRAND_DESCRIPTION,icon:v.BRAND_ICON||'🤖',logo:v.BRAND_LOGO_URL||''});return true;}
 if(path==='/api/control/bootstrap-status'&&req.method==='GET'){sendJson(res,200,{initialized:identity.initialized,claimRequired:!identity.initialized,claimConfigured:!!deps.bootstrapToken});return true;}
 if(path==='/api/control/bootstrap'&&req.method==='POST'){const b=await body(),a=Buffer.from(b.claimToken||''),expected=Buffer.from(deps.bootstrapToken||'');if(!expected.length||a.length!==expected.length||!timingSafeEqual(a,expected))throw new AdminError(403,'初始化凭据无效');await identity.bootstrap(b.claimToken,{...b,username:b.userId});sendJson(res,201,{ok:true});return true;}
 if(path==='/api/auth/login'&&req.method==='POST'){const b=await body();const r=await identity.login(String(b.userId||''),String(b.password||''));cookie(req,res,r.token);sendJson(res,200,{csrf:identity.session(r.token)?.csrf,me:r.principal});return true;}
 if(path==='/api/auth/logout'&&req.method==='POST'){identity.logout(sessionToken(req));if(req.headers.authorization?.startsWith('Bearer '))identity.logout(req.headers.authorization.slice(7));cookie(req,res,'');sendJson(res,200,{ok:true});return true;}
 const p=await deps.authenticate(req);if(!p)throw new AdminError(401,'请先登录');
 if(path==='/api/auth/me'&&req.method==='GET'){sendJson(res,200,{...p,csrf:session?.csrf||null});return true;}
 if(path==='/api/auth/profile'&&req.method==='GET'){sendJson(res,200,identity.profile(p));return true;}
 if(path==='/api/auth/profile'&&req.method==='PATCH'){const result=await identity.updateProfile(p,await body());if(result.reauthenticate){cookie(req,res,'');await deps.accountChanged?.(p,result.account.id,result.account.workspaceId);}sendJson(res,200,result);return true;}
 if(![Role.TenantAdmin,Role.PlatformAdmin].includes(p.role as any))throw new AdminError(403,'需要管理员权限');
 if(path==='/api/control/session'&&req.method==='POST'){const r=identity.exchange(p);cookie(req,res,r.token);sendJson(res,200,{ok:true,csrf:r.csrf});return true;}
 if(write&&session&&!req.headers.authorization&&req.headers['x-csrf-token']!==session.csrf)throw new AdminError(403,'安全校验已失效，请刷新页面');
 // 部署级配置仅限平台管理员，或仅有一个租户的私有化部署所有者。
 const canConfigure=p.role===Role.PlatformAdmin||identity.tenantCount===1;
 if(path==='/api/control/model/suspend'&&req.method==='POST'){if(!canConfigure)throw new AdminError(403,'需要部署管理员');await deps.suspend?.();sendJson(res,200,{ok:true,message:'模型调用已暂停。重新应用配置后恢复。'});return true;}
 if(path==='/api/control/schema'&&req.method==='GET'){sendJson(res,200,{fields:canConfigure?settings.schema().fields:[],canConfigure});return true;}
 if(path==='/api/control/settings'&&req.method==='GET'){if(!canConfigure)throw new AdminError(403,'仅部署管理员可修改全局配置');sendJson(res,200,settings.public("global"));return true;}
 if(path==='/api/control/settings/history'&&req.method==='GET'){if(!canConfigure)throw new AdminError(403,'需要部署管理员');sendJson(res,200,{history:settings.history("global")});return true;}
 if(path.startsWith('/api/control/settings/')&&req.method==='POST'||path==='/api/control/settings/draft'&&req.method==='PUT'){
 if(!canConfigure)throw new AdminError(403,'需要部署管理员');const b=await body();let result;
 if(path.endsWith('/draft'))result=settings.saveDraft("global",{values:b.values,expectedRevision:b.expectedRevision,actor:p.tenant.userId});
 else if(path.endsWith('/rollback')){let install:()=>void=()=>{};result=settings.rollback("global",{targetRevision:b.revision,expectedRevision:b.expectedRevision,actor:p.tenant.userId},v=>{install=deps.apply(v);});install();}
 else if(path.endsWith('/apply')){let install:()=>void=()=>{};result=settings.apply("global",{expectedRevision:b.expectedRevision,actor:p.tenant.userId},v=>{install=deps.apply(v);});install();}
 else throw new AdminError(404,'配置操作不存在');sendJson(res,200,result);return true;}
 if(path==='/api/control/connections'&&req.method==='GET'){if(!canConfigure)throw new AdminError(403,'需要部署管理员');sendJson(res,200,{connections:deps.connections?.status(settings.effective('global'))||[]});return true;}
 if(path==='/api/control/connections/test'&&req.method==='POST'){
 if(!canConfigure)throw new AdminError(403,'需要部署管理员');const b=await body(),v=settings.draftEffective("global");if(!['model','lite','evaluation','embedding','search','mcp','sandbox','model-a','model-b','model-c','vision'].includes(b.type))throw new AdminError(400,'连接类型无效');checkedType=b.type;checkedValues=v;const success=(message:string)=>{deps.connections?.record(b.type,v,true);sendJson(res,200,{ok:true,message});};let response:Response;
 if(b.type==='sandbox'){if(!deps.testSandbox)throw new AdminError(400,'沙箱连接测试不可用');await deps.testSandbox(v);success('沙箱创建、代码执行、浏览器启动与释放成功；外网可达性需用真实任务验证');return true;}
 if(b.type==='mcp'){const servers=parseMcp(v,p.tenant.tenantId,p.tenant.workspaceId);const t=createMcpToolset(servers)[0];if(!t)throw new AdminError(400,'MCP尚未配置');const r=await t.execute({args:{server:servers[0]!.name},tenant:p.tenant,taskId:'connection-test',signal:AbortSignal.timeout(20000),report:()=>{}});if(r.isError)throw new AdminError(502,'MCP连接或工具目录查询失败');const tools=JSON.parse(r.text);if(!tools.length)throw new AdminError(400,'MCP白名单没有匹配的工具');success('MCP连接成功，白名单匹配 '+tools.length+' 个工具');return true;}
 if(b.type==='embedding'){if(!v.EMBEDDING_ENDPOINT||!v.EMBEDDING_MODEL)throw new AdminError(400,'请先配置嵌入服务');const provider=new HttpEmbeddings({endpoint:v.EMBEDDING_ENDPOINT,model:v.EMBEDDING_MODEL,...(v.EMBEDDING_API_KEY?{apiKey:v.EMBEDDING_API_KEY}:{}),...(v.EMBEDDING_DIMENSIONS?{dimensions:Number(v.EMBEDDING_DIMENSIONS)}:{}),fetch:outboundFetch(v.NETWORK_ALLOWED_CIDRS)});const result=await provider.embed(['连接测试'],'query',AbortSignal.timeout(20000));success('嵌入连接成功，向量维度 '+result[0]!.length);return true;}
 if(b.type==='search'){const t=searchTool(v)[0];if(!t)throw new AdminError(400,'搜索尚未配置');const r=await t.execute({args:{query:'Tao Agent connectivity test'},tenant:p.tenant,taskId:'connection-test',signal:AbortSignal.timeout(15000),report:()=>{}});if(r.isError)throw new AdminError(502,r.text);success('搜索连接成功');return true;}
 const prefix: string=({'lite':'MODEL_LITE','evaluation':'EVAL_MODEL','model-a':'MODEL_A','model-b':'MODEL_B','model-c':'MODEL_C','vision':'VISION_MODEL'} as Record<string,string>)[b.type]||'MODEL';
 if(!v[prefix+'_NAME']||!v[prefix+'_BASE_URL']||!v[prefix+'_API_KEY'])throw new AdminError(400,'请完整填写该模型的地址、名称和密钥');
 const url=v[prefix+'_BASE_URL']!.replace(/\/$/,'')+'/chat/completions';checkEndpoint(url);
 response=await outboundFetch(v.NETWORK_ALLOWED_CIDRS,1024*1024)(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+v[prefix+'_API_KEY']},body:JSON.stringify({model:v[prefix+'_NAME'],messages:[{role:'user',content:'请回复OK'}],max_tokens:64,stream:false})});
 if(!response.ok){await response.body?.cancel();throw new AdminError(502,'连接失败，服务返回状态 '+response.status);}
 const result:any=await response.json();if(!Array.isArray(result.choices)||!result.choices[0]?.message||(!result.choices[0].message.content&&!result.choices[0].message.reasoning_content))throw new AdminError(502,'模型未返回有效消息，请检查模型ID与协议');success('模型连接成功');return true;}
 if(path==='/api/control/accounts'){if(req.method==='GET')sendJson(res,200,{accounts:identity.list(p)});else if(req.method==='POST'){const b=await body();const create=()=>identity.create(p,b);sendJson(res,201,deps.withSeat?await deps.withSeat(p.role===Role.PlatformAdmin&&typeof b.tenantId==='string'?b.tenantId:p.tenant.tenantId,undefined,create):await create());}else throw new AdminError(405,'方法不支持');return true;}
 const account=/^\/api\/control\/accounts\/([^/]+)(?:\/(revoke-sessions|reset-credential))?$/.exec(path);
 if(account){if(!['PATCH','POST'].includes(req.method||''))throw new AdminError(405,'方法不支持');const b=await body(),id=decodeURIComponent(account[1]!);const previous=identity.list(p).find(a=>a.id===id);if(!previous)throw new AdminError(404,'账号不存在');const result=account[2]==='revoke-sessions'?identity.revoke(p,id):account[2]==='reset-credential'?await identity.resetPassword(p,id,b.password):await (deps.withSeat&&b.enabled===true?deps.withSeat(previous.tenantId,id,()=>identity.update(p,id,b)):identity.update(p,id,b));await deps.accountChanged?.(p,id,previous.workspaceId);sendJson(res,200,result);return true;}
 const trace=/^\/api\/control\/traces\/([\w-]+)$/.exec(path);if(trace&&req.method==='GET'){sendJson(res,200,deps.trace?.(p,trace[1]!)||{});return true;}
 const sandboxRelease=/^\/api\/control\/sandboxes\/([\w-]+)\/release$/.exec(path);if(sandboxRelease&&req.method==='POST'){if(!canConfigure)throw new AdminError(403,'需要部署管理员');if(!deps.releaseSandbox)throw new AdminError(404,'沙箱管理不可用');await deps.releaseSandbox(p,sandboxRelease[1]!);sendJson(res,200,{ok:true});return true;}
 if(path==='/api/control/observability'&&req.method==='GET'){sendJson(res,200,deps.observability(p));return true;}
 if(path==='/api/control/evaluations'&&req.method==='GET'){sendJson(res,200,deps.evaluations.list(p));return true;}
 if(path==='/api/control/evaluations/compare'&&req.method==='GET'){const query=new URL(req.url!,'http://local').searchParams;sendJson(res,200,deps.evaluations.compare(p,query.get('base')||'',query.get('target')||''));return true;}
 if(path==='/api/control/evaluations/datasets'&&req.method==='POST'){sendJson(res,201,deps.evaluations.dataset(p,await body()));return true;}
 if(path==='/api/control/evaluations/runs'&&req.method==='POST'){const b=await body(),v=settings.effective('global'),prefix=v.EVAL_MODEL_NAME?'EVAL_MODEL':'MODEL',prices=['INPUT_PRICE','OUTPUT_PRICE','CACHE_READ_PRICE'].map(k=>v[prefix+'_'+k]);const price=prices.every(n=>n!==undefined&&n!=='')?Math.max(...prices.map(Number)):undefined;sendJson(res,202,deps.evaluations.start(p,b.datasetId,settings.public('global').activeRevision,Number(v.EVAL_MAX_CASES||20),(q,signal,budget)=>deps.evaluate(p,q,signal,budget),Number(v.EVAL_MAX_TOKENS||100000),Number(v.EVAL_CONCURRENCY||1),v.EVAL_MAX_COST_YUAN===undefined?undefined:Number(v.EVAL_MAX_COST_YUAN),price));return true;}
 const run=/^\/api\/control\/evaluations\/runs\/([\w-]+)\/(cancel|review)$/.exec(path);if(run&&req.method==='POST'){const b=await body();sendJson(res,200,run[2]==='cancel'?deps.evaluations.cancel(p,run[1]!):deps.evaluations.review(p,run[1]!,b.index,b.result));return true;}
 throw new AdminError(404,'管理接口不存在');
 }catch(e){if(checkedType&&checkedValues){try{deps.connections?.record(checkedType,checkedValues,false);}catch{}}sendError(res,e instanceof AdminError?e.status:400,e instanceof AdminError?e.message:'操作失败，请检查输入或连接配置');return true;}
 };
}
