import type { IncomingMessage,ServerResponse } from 'node:http';
import { readJsonBody,sendJson,type AppDeps } from './app.ts';
import { EnterpriseManager } from './enterprise.ts';
import { EnterpriseOidc } from './enterprise-oidc.ts';
import { WorkspaceError } from './workspace-services.ts';

export const ENTERPRISE_FORM_FIELDS = {
  organization:['name','seatLimit','allowedCidrs'],
  department:['id','name','parentId','accountIds'],
  oidcProvider:['id','name','issuer','clientId','clientSecret','redirectUri','tokenAuthMethod','enabled'],
  oidcBinding:['providerId','subject','accountId'],
};
/** 管理接口交宿主authenticate统一完成CSRF；SSO callback使用浏览器绑定state。 */
export function createEnterpriseHandler(deps:{authenticate:AppDeps['authenticate'];enterprise:EnterpriseManager;oidc:EnterpriseOidc}){
  const attempts=new Map<string,{count:number;until:number}>();
  const rate=(key:string,max:number)=>{const now=Date.now();for(const [key,value]of attempts)if(value.until<=now)attempts.delete(key);if(attempts.size>=2000&&!attempts.has(key))throw new WorkspaceError(429,'SSO请求过多');const value=attempts.get(key)??{count:0,until:now+60000};value.count++;attempts.set(key,value);if(value.count>max)throw new WorkspaceError(429,'SSO请求过于频繁');};
  return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    const url=new URL(req.url??'/','http://localhost');const p=url.pathname.split('/').filter(Boolean);const auth=p[0]==='api'&&p[1]==='auth'&&p[2]==='oidc';const admin=p[0]==='api'&&p[1]==='admin'&&p[2]==='enterprise';if(!auth&&!admin)return false;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    try{
      const method=req.method??'GET';
      if(auth){
        rate('global',100);rate('ip:'+req.socket.remoteAddress,15);
        if(method==='GET'&&p[3]==='start'&&p.length===4){const id=url.searchParams.get('providerId')??'';deps.enterprise.assertRequest(deps.oidc.providerTenant(id),req);const result=await deps.oidc.begin(id);res.setHeader('Set-Cookie',`tao_oidc=${result.browserToken}; Path=/api/auth/oidc; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);res.writeHead(302,{Location:result.authorizationUrl});res.end();return true;}
        if(method==='GET'&&p[3]==='callback'&&p.length===4){
          const state=url.searchParams.get('state')??'';deps.enterprise.assertRequest(deps.oidc.transactionTenant(state),req);
          const browserToken=(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('tao_oidc='))?.slice(9)??'';
          const issuer=url.searchParams.get('iss');const result=await deps.oidc.callback({state,code:url.searchParams.get('code')??'',browserToken,...(issuer?{issuer}:{})});
          res.setHeader('Set-Cookie',[`tao_session=${result.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`,'tao_oidc=; Path=/api/auth/oidc; HttpOnly; Secure; SameSite=Lax; Max-Age=0']);res.writeHead(303,{Location:'/chat.html'});res.end();return true;
        }
        throw new WorkspaceError(404,'SSO接口不存在');
      }
      const principal=await deps.authenticate(req);if(!principal)throw new WorkspaceError(401,'请先登录');const tenantId=url.searchParams.get('tenantId')??principal.tenant.tenantId;
      deps.enterprise.assertRequest(principal.tenant.tenantId,req);
      let body:Record<string,unknown>={};if(method==='POST'||method==='PATCH'){const parsed=await readJsonBody(req);if(!parsed.ok||!parsed.value||typeof parsed.value!=='object'||Array.isArray(parsed.value))throw new WorkspaceError(400,'参数须为JSON对象');body=parsed.value as Record<string,unknown>;}
      if(p.length===3&&method==='GET')sendJson(res,200,{organization:deps.enterprise.view(principal,tenantId),fields:ENTERPRISE_FORM_FIELDS});
      else if(p.length===3&&method==='PATCH')sendJson(res,200,{organization:deps.enterprise.update(principal,body,tenantId)});
      else if(p[3]==='departments'&&p.length===4&&method==='POST')sendJson(res,201,{department:deps.enterprise.upsertDepartment(principal,body,tenantId)});
      else if(p[3]==='departments'&&p.length===5&&method==='DELETE'){deps.enterprise.removeDepartment(principal,p[4]!,tenantId);sendJson(res,200,{ok:true});}
      else if(p[3]==='oidc'&&p[4]==='providers'&&p.length===5&&method==='GET')sendJson(res,200,{providers:deps.oidc.list(principal,tenantId)});
      else if(p[3]==='oidc'&&p[4]==='providers'&&p.length===5&&method==='POST')sendJson(res,201,{provider:deps.oidc.configure(principal,body,tenantId)});
      else if(p[3]==='oidc'&&p[4]==='providers'&&p.length===6&&method==='DELETE'){deps.oidc.remove(principal,p[5]!,tenantId);sendJson(res,200,{ok:true});}
      else if(p[3]==='oidc'&&p[4]==='bindings'&&p.length===5&&method==='GET')sendJson(res,200,{bindings:deps.oidc.listBindings(principal,tenantId)});
      else if(p[3]==='oidc'&&p[4]==='bindings'&&p.length===5&&method==='POST')sendJson(res,201,{binding:deps.oidc.bind(principal,body,tenantId)});
      else if(p[3]==='oidc'&&p[4]==='bindings'&&p.length===6&&method==='DELETE'){deps.oidc.unbind(principal,p[5]!,tenantId);sendJson(res,200,{ok:true});}
      else throw new WorkspaceError(404,'企业管理接口不存在');
    }catch(error){const status=error instanceof WorkspaceError?error.status:500;if(status===429)res.setHeader('Retry-After','60');if(!res.headersSent)sendJson(res,status,{error:error instanceof WorkspaceError?error.message:'企业服务暂不可用',code:status===401?'UNAUTHORIZED':status===403?'FORBIDDEN':status===429?'RATE_LIMITED':status>=500?'UNAVAILABLE':'INVALID_REQUEST'});}
    return true;
  };
}
