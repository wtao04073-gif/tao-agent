import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { TenantContext } from '@tao/core';
import type { Principal } from './app.ts';
import { AutomationStore } from './automation-store.ts';
import { automationDigest } from './automation.ts';
import { outboundFetch } from './admin-network.ts';
import { WorkspaceError } from './workspace-services.ts';
import { requireEnterpriseAdmin } from './enterprise.ts';

interface OidcProvider { id:string;tenant:TenantContext;name:string;issuer:string;clientId:string;clientSecret?:string;redirectUri:string;tokenAuthMethod:'none'|'client_secret_basic'|'client_secret_post';enabled:boolean;revision:number }
interface OidcBinding { id:string;tenant:TenantContext;providerId:string;subject:string;accountId:string }
interface OidcTransaction { id:string;tenant:TenantContext;providerId:string;revision:number;verifier:string;nonce:string;browserHash:string;expiresAt:number;used:boolean }
interface Discovery { issuer:string;authorization_endpoint:string;token_endpoint:string;jwks_uri:string;code_challenge_methods_supported?:string[];response_types_supported?:string[] }
export interface EnterpriseOidcDeps {
  dir:string; fetch?:typeof fetch; now?:()=>number;
  /** 只读既有启用账号；不创建账号、不使用email猜测映射。 */
  getAccountPrincipal:(accountId:string)=>Principal|undefined;
  /** 仅内部验签后调用；应再次校验账号启用并使用其当前角色。 */
  loginBoundAccount:(accountId:string)=>{token:string;principal:Principal;csrf:string}|Promise<{token:string;principal:Principal;csrf:string}>;
}
const safeEqual=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
function httpsUrl(value:unknown):string{if(typeof value!=='string'||value.length>2048)throw new WorkspaceError(400,'OIDC地址无效');try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error();return value;}catch{throw new WorkspaceError(400,'OIDC地址必须是无凭据的HTTPS地址');}}
export class EnterpriseOidc {
  private readonly providers:AutomationStore<OidcProvider>;
  private readonly bindings:AutomationStore<OidcBinding>;
  private readonly transactions:AutomationStore<OidcTransaction>;
  private readonly now:()=>number;
  private readonly deps:EnterpriseOidcDeps;
  constructor(deps:EnterpriseOidcDeps){this.deps=deps;this.now=deps.now??Date.now;this.providers=new AutomationStore(deps.dir,'enterprise-oidc-providers');this.bindings=new AutomationStore(deps.dir,'enterprise-oidc-bindings');this.transactions=new AutomationStore(deps.dir,'enterprise-oidc-transactions');}
  list(principal:Principal,tenantId=principal.tenant.tenantId){requireEnterpriseAdmin(principal,tenantId);return this.providers.all().filter(p=>p.tenant.tenantId===tenantId).map(({clientSecret,...p})=>({...p,hasClientSecret:!!clientSecret,status:p.enabled?'configured':'disabled'}));}
  configure(principal:Principal,input:unknown,tenantId=principal.tenant.tenantId){
    requireEnterpriseAdmin(principal,tenantId);const v=input as Record<string,unknown>;
    if(!v||typeof v.name!=='string'||!v.name.trim()||v.name.length>120||typeof v.clientId!=='string'||!v.clientId.trim()||v.clientId.length>256)throw new WorkspaceError(400,'OIDC名称与Client ID必填');
    const old=typeof v.id==='string'?this.providers.get(v.id):undefined;if(v.id!==undefined&&(!old||old.tenant.tenantId!==tenantId))throw new WorkspaceError(404,'OIDC提供商不存在');
    if(!old&&this.list(principal,tenantId).length>=10)throw new WorkspaceError(409,'每组织最多10个OIDC提供商');
    const issuer=httpsUrl(v.issuer);if(new URL(issuer).search)throw new WorkspaceError(400,'issuer不能包含查询参数');
    const redirectUri=httpsUrl(v.redirectUri);if(new URL(redirectUri).search)throw new WorkspaceError(400,'回调地址不能包含查询参数');
    const secret=v.clientSecret===undefined?old?.clientSecret:v.clientSecret;if(secret!==undefined&&(typeof secret!=='string'||secret.length>4096))throw new WorkspaceError(400,'Client Secret格式无效');
    const tokenAuthMethod=v.tokenAuthMethod??(secret?'client_secret_basic':'none');if(!['none','client_secret_basic','client_secret_post'].includes(String(tokenAuthMethod))||tokenAuthMethod!=='none'&&!secret)throw new WorkspaceError(400,'OIDC令牌认证方式或密钥不完整');
    const p:OidcProvider={id:old?.id??randomUUID(),tenant:{tenantId,workspaceId:principal.tenant.workspaceId,userId:principal.tenant.userId},name:v.name.trim(),issuer,clientId:v.clientId.trim(),redirectUri,tokenAuthMethod:tokenAuthMethod as OidcProvider['tokenAuthMethod'],enabled:v.enabled!==false,revision:(old?.revision??0)+1,...(secret?{clientSecret:secret as string}:{})};
    this.providers.put(p);return this.list(principal,tenantId).find(item=>item.id===p.id)!;
  }
  remove(principal:Principal,id:string,tenantId=principal.tenant.tenantId){requireEnterpriseAdmin(principal,tenantId);const p=this.providers.get(id);if(!p||p.tenant.tenantId!==tenantId)throw new WorkspaceError(404,'OIDC提供商不存在');this.providers.remove(id);for(const b of this.bindings.all())if(b.providerId===id)this.bindings.remove(b.id);}
  listBindings(principal:Principal,tenantId=principal.tenant.tenantId){requireEnterpriseAdmin(principal,tenantId);return this.bindings.all().filter(b=>b.tenant.tenantId===tenantId);}
  bind(principal:Principal,input:unknown,tenantId=principal.tenant.tenantId){
    requireEnterpriseAdmin(principal,tenantId);const v=input as Record<string,unknown>;if(!v||typeof v.providerId!=='string'||typeof v.subject!=='string'||!v.subject||v.subject.length>512||typeof v.accountId!=='string')throw new WorkspaceError(400,'提供商、外部sub和内部账号必填');
    const p=this.providers.get(v.providerId);const account=this.deps.getAccountPrincipal(v.accountId);if(!p||p.tenant.tenantId!==tenantId||!account||account.tenant.tenantId!==tenantId)throw new WorkspaceError(404,'提供商或启用账号不存在于目标组织');
    const b:OidcBinding={id:automationDigest(JSON.stringify([p.id,p.issuer,v.subject])),tenant:p.tenant,providerId:p.id,subject:v.subject,accountId:v.accountId};this.bindings.put(b);return b;
  }
  unbind(principal:Principal,id:string,tenantId=principal.tenant.tenantId){requireEnterpriseAdmin(principal,tenantId);const b=this.bindings.get(id);if(!b||b.tenant.tenantId!==tenantId)throw new WorkspaceError(404,'OIDC绑定不存在');this.bindings.remove(id);}
  providerTenant(id:string):string{const p=this.providers.get(id);if(!p||!p.enabled)throw new WorkspaceError(404,'OIDC提供商未配置或已停用');return p.tenant.tenantId;}
  transactionTenant(state:string):string{const t=this.transactions.get(automationDigest(state));if(!t||t.used||t.expiresAt<this.now())throw new WorkspaceError(401,'OIDC登录状态已失效');return t.tenant.tenantId;}
  private async json(url:string,init?:RequestInit):Promise<any>{
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
    try{const response=await(this.deps.fetch??outboundFetch('',131072))(httpsUrl(url),{...init,redirect:'error',signal:controller.signal});if(!response.ok)throw new WorkspaceError(502,'OIDC上游请求失败');const text=await response.text();if(Buffer.byteLength(text)>131072)throw new WorkspaceError(502,'OIDC响应过大');const result=JSON.parse(text);if(!result||typeof result!=='object'||Array.isArray(result))throw new Error();return result;}
    catch(error){if(error instanceof WorkspaceError)throw error;throw new WorkspaceError(502,'OIDC上游响应无效或无法连接');}finally{clearTimeout(timer);}
  }
  private async discovery(p:OidcProvider):Promise<Discovery>{const metadata=await this.json(p.issuer.replace(/\/$/,'')+'/.well-known/openid-configuration') as Discovery;if(metadata.issuer!==p.issuer)throw new WorkspaceError(502,'OIDC发现文档issuer不匹配');for(const field of ['authorization_endpoint','token_endpoint','jwks_uri'] as const)httpsUrl(metadata[field]);if(metadata.code_challenge_methods_supported&&!metadata.code_challenge_methods_supported.includes('S256'))throw new WorkspaceError(502,'OIDC提供商未支持PKCE S256');if(metadata.response_types_supported&&!metadata.response_types_supported.includes('code'))throw new WorkspaceError(502,'OIDC提供商未支持授权码流程');return metadata;}
  async begin(providerId:string){
    const p=this.providers.get(providerId);if(!p?.enabled)throw new WorkspaceError(503,'OIDC提供商未配置或已停用');
    for(const t of this.transactions.all())if(t.expiresAt<this.now())this.transactions.remove(t.id);if(this.transactions.all().length>=1000)throw new WorkspaceError(429,'待完成SSO登录过多，请稍后重试');
    const metadata=await this.discovery(p);const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),browserToken=randomBytes(32).toString('base64url');
    this.transactions.put({id:automationDigest(state),tenant:p.tenant,providerId:p.id,revision:p.revision,verifier,nonce,browserHash:automationDigest(browserToken),expiresAt:this.now()+600000,used:false});
    const url=new URL(metadata.authorization_endpoint);url.searchParams.set('response_type','code');url.searchParams.set('client_id',p.clientId);url.searchParams.set('redirect_uri',p.redirectUri);url.searchParams.set('scope','openid profile');url.searchParams.set('state',state);url.searchParams.set('nonce',nonce);url.searchParams.set('code_challenge',createHash('sha256').update(verifier).digest('base64url'));url.searchParams.set('code_challenge_method','S256');
    return{authorizationUrl:url.toString(),browserToken,expiresIn:600};
  }
  async callback(input:{state:string;code:string;browserToken:string;issuer?:string}){
    if(!/^[A-Za-z0-9_-]{43}$/.test(input.state)||typeof input.code!=='string'||!input.code||input.code.length>8192||typeof input.browserToken!=='string'||input.browserToken.length>256)throw new WorkspaceError(401,'OIDC回调参数无效');
    const t=this.transactions.get(automationDigest(input.state));if(!t||t.used||t.expiresAt<this.now()||!safeEqual(t.browserHash,automationDigest(input.browserToken)))throw new WorkspaceError(401,'OIDC登录状态失效或浏览器校验失败');
    const p=this.providers.get(t.providerId);if(!p?.enabled||p.revision!==t.revision||(input.issuer!==undefined&&input.issuer!==p.issuer))throw new WorkspaceError(401,'OIDC提供商配置已变化或issuer不匹配');
    // 发起网络请求之前消费state，阻止并发回调重放。
    this.transactions.put({...t,used:true});
    const metadata=await this.discovery(p);const form=new URLSearchParams({grant_type:'authorization_code',code:input.code,redirect_uri:p.redirectUri,client_id:p.clientId,code_verifier:t.verifier});const headers:Record<string,string>={'content-type':'application/x-www-form-urlencoded'};
    if(p.tokenAuthMethod==='client_secret_basic')headers.authorization='Basic '+Buffer.from(new URLSearchParams({v:p.clientId}).toString().slice(2)+':'+new URLSearchParams({v:p.clientSecret!}).toString().slice(2)).toString('base64');else if(p.tokenAuthMethod==='client_secret_post')form.set('client_secret',p.clientSecret!);
    const tokens=await this.json(metadata.token_endpoint,{method:'POST',headers,body:form.toString()});if(typeof tokens.id_token!=='string'||tokens.id_token.length>32000)throw new WorkspaceError(401,'OIDC响应缺少有效ID Token');
    let subject:string;
    try{
      const jwks=await this.json(metadata.jwks_uri) as JSONWebKeySet;if(!Array.isArray(jwks.keys)||jwks.keys.length>100)throw new Error();
      const {payload}=await jwtVerify(tokens.id_token,createLocalJWKSet(jwks),{issuer:p.issuer,audience:p.clientId,algorithms:['RS256','PS256','ES256'],requiredClaims:['sub','iat','exp','nonce'],maxTokenAge:600,clockTolerance:5,currentDate:new Date(this.now())});
      if(typeof payload.nonce!=='string'||!safeEqual(payload.nonce,t.nonce)||typeof payload.sub!=='string'||!payload.sub||payload.sub.length>512||(Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==p.clientId)||(payload.azp!==undefined&&payload.azp!==p.clientId))throw new Error();subject=payload.sub;
    }catch{throw new WorkspaceError(401,'OIDC令牌签名、issuer、受众或nonce校验失败');}
    const binding=this.bindings.get(automationDigest(JSON.stringify([p.id,p.issuer,subject])));const account=binding?this.deps.getAccountPrincipal(binding.accountId):undefined;
    const current=this.providers.get(p.id);if(!current?.enabled||current.revision!==p.revision||!binding||binding.tenant.tenantId!==p.tenant.tenantId||!account||account.tenant.tenantId!==p.tenant.tenantId)throw new WorkspaceError(403,'外部身份尚未绑定启用的内部账号');
    return this.deps.loginBoundAccount(binding.accountId);
  }
}
