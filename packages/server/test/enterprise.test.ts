import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportJWK,generateKeyPair,SignJWT } from 'jose';
import { Role } from '@tao/core';
import { EnterpriseManager,enterpriseClientIp,type EnterpriseAccount } from '../src/enterprise.ts';
import { EnterpriseOidc } from '../src/enterprise-oidc.ts';
import { automationDigest } from '../src/automation.ts';
import type { Principal } from '../src/app.ts';
import type { IncomingMessage } from 'node:http';
const dirs:string[]=[];const directory=()=>{const dir=mkdtempSync(join(tmpdir(),'tao-enterprise-'));dirs.push(dir);return dir;};
const admin:Principal={role:Role.TenantAdmin,tenant:{tenantId:'t1',workspaceId:'w1',userId:'admin'}};
const member:Principal={role:Role.Member,tenant:{tenantId:'t1',workspaceId:'w1',userId:'member'}};
const foreign:Principal={...admin,tenant:{...admin.tenant,tenantId:'t2'}};
const req=(ip:string,xff?:string)=>({socket:{remoteAddress:ip},headers:xff?{'x-forwarded-for':xff}:{}}) as Pick<IncomingMessage,'socket'|'headers'>;
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
describe('企业组织与入口策略',()=>{
  it('部门树持久化、阻止循环与跨组织成员，不扩展账号权限',()=>{
    const dir=directory();const accounts=[{id:'t1/member',tenantId:'t1',userId:'member',enabled:true}];const e=new EnterpriseManager({dir,listAccounts:()=>accounts});
    const a=e.upsertDepartment(admin,{name:'研发',accountIds:['t1/member']});const b=e.upsertDepartment(admin,{name:'平台',parentId:a.id});expect(()=>e.upsertDepartment(admin,{id:a.id,name:'研发',parentId:b.id})).toThrow('循环');expect(()=>e.removeDepartment(admin,a.id)).toThrow('子部门');expect(()=>e.upsertDepartment(admin,{name:'越权',accountIds:['t2/member']})).toThrow('本组织');expect(()=>e.view(member)).toThrow('管理员');expect(()=>e.view(foreign,'t1')).toThrow('管理员');
    expect(new EnterpriseManager({dir,listAccounts:()=>accounts}).view(admin).departments).toHaveLength(2);
  });
  it('不信任伪造XFF，显式代理才从右向左解析，支持IPv4映射地址',()=>{
    expect(enterpriseClientIp(req('203.0.113.9','10.1.1.1'))).toBe('203.0.113.9');
    expect(enterpriseClientIp(req('10.0.0.1','198.51.100.3, 203.0.113.9, 10.0.0.2'),['10.0.0.0/8'])).toBe('203.0.113.9');
    expect(()=>enterpriseClientIp(req('10.0.0.1','invalid'),['10.0.0.0/8'])).toThrow('无效');
    const e=new EnterpriseManager({dir:directory(),listAccounts:()=>[]});e.update(admin,{allowedCidrs:['192.0.2.0/24']});expect(()=>e.assertRequest('t1',req('203.0.113.9','192.0.2.2'))).toThrow('白名单');expect(()=>e.assertRequest('t1',req('::ffff:192.0.2.2'))).not.toThrow();
  });
  it('并发席位预约不会超卖，已有启用账号不额外占位',async()=>{
    const accounts:EnterpriseAccount[]=[{id:'t1/admin',tenantId:'t1',userId:'admin',enabled:true}];const e=new EnterpriseManager({dir:directory(),listAccounts:()=>accounts});e.update(admin,{seatLimit:2});let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const pending=e.withSeat('t1',undefined,async()=>{await gate;accounts.push({id:'t1/member',tenantId:'t1',userId:'member',enabled:true});});
    await expect(e.withSeat('t1',undefined,()=>{})).rejects.toThrow('席位');expect(()=>e.update(admin,{seatLimit:1})).toThrow('正在创建');release();await pending;await expect(e.withSeat('t1','t1/member',()=>true)).resolves.toBe(true);expect(()=>e.assertSeatAvailable('t1')).toThrow('席位');
  });
  it('损坏的组织策略不能退回无限席位和开放IP',()=>{
    const dir=directory();const e=new EnterpriseManager({dir,listAccounts:()=>[]});e.update(admin,{allowedCidrs:['192.0.2.0/24']});writeFileSync(join(dir,'enterprise-policies',automationDigest('t1')+'.json'),'{bad');expect(()=>e.assertRequest('t1',req('203.0.113.9'))).toThrow('损坏');
  });
});
async function oidcFixture(){
  const dir=directory();const now=Date.parse('2026-10-08T00:00:00Z');const {privateKey,publicKey}=await generateKeyPair('ES256');const jwk={...await exportJWK(publicKey),kid:'key1',alg:'ES256'};const login=vi.fn(()=>({token:'session-token',principal:member,csrf:'csrf-token'}));let nonce='',challenge='',enabled=true;let claims:Record<string,unknown>={};let issuer='https://issuer.example';let lastForm:URLSearchParams|undefined;
  const fetcher=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input);
    if(url.endsWith('/.well-known/openid-configuration'))return Response.json({issuer,authorization_endpoint:'https://issuer.example/authorize',token_endpoint:'https://issuer.example/token',jwks_uri:'https://issuer.example/jwks',code_challenge_methods_supported:['S256'],response_types_supported:['code']});
    if(url.endsWith('/jwks'))return Response.json({keys:[jwk]});
    if(url.endsWith('/token')){lastForm=new URLSearchParams(String(init?.body));expect(createHash('sha256').update(lastForm.get('code_verifier')!).digest('base64url')).toBe(challenge);const token=await new SignJWT({nonce,...claims}).setProtectedHeader({alg:'ES256',kid:'key1'}).setIssuer(typeof claims.iss==='string'?claims.iss:'https://issuer.example').setAudience(typeof claims.aud==='string'?claims.aud:'client1').setSubject(typeof claims.sub==='string'?claims.sub:'subject1').setIssuedAt(typeof claims.iat==='number'?claims.iat:now/1000).setExpirationTime(typeof claims.exp==='number'?claims.exp:now/1000+300).sign(privateKey);return Response.json({id_token:token,access_token:'unused'});}
    throw new Error('unexpected URL');
  }) as unknown as typeof fetch;
  const deps={dir,now:()=>now,fetch:fetcher,getAccountPrincipal:(id:string)=>enabled&&id==='t1/member'?member:undefined,loginBoundAccount:login};const oidc=new EnterpriseOidc(deps);const provider=oidc.configure(admin,{name:'企业SSO',issuer:'https://issuer.example',clientId:'client1',redirectUri:'https://tao.example/api/auth/oidc/callback'});oidc.bind(admin,{providerId:provider.id,subject:'subject1',accountId:'t1/member'});
  const begin=async()=>{const start=await oidc.begin(provider.id);const url=new URL(start.authorizationUrl);nonce=url.searchParams.get('nonce')!;challenge=url.searchParams.get('code_challenge')!;return{state:url.searchParams.get('state')!,browserToken:start.browserToken,code:'authorization-code'};};
  return{oidc,deps,provider,login,begin,setClaims:(v:Record<string,unknown>)=>{claims=v;},disable:()=>{enabled=false;},setIssuer:(v:string)=>{issuer=v;},form:()=>lastForm};
}
describe('OIDC标准协议与显式绑定',()=>{
  it('授权码PKCE、浏览器state与nonce、JWT验证后仅登录现有账号，可跨重启回调',async()=>{
    const f=await oidcFixture();const input=await f.begin();const restarted=new EnterpriseOidc(f.deps);await expect(restarted.callback(input)).resolves.toMatchObject({principal:member});expect(f.login).toHaveBeenCalledWith('t1/member');expect(f.form()?.get('grant_type')).toBe('authorization_code');await expect(restarted.callback(input)).rejects.toThrow('失效');
  });
  it('跨浏览器state与nonce不符时拒绝，不按email或角色自动绑定',async()=>{
    const f=await oidcFixture();let input=await f.begin();await expect(f.oidc.callback({...input,browserToken:'wrong'})).rejects.toThrow('浏览器');f.setClaims({nonce:'wrong'});await expect(f.oidc.callback(input)).rejects.toThrow('nonce');
    input=await f.begin();f.setClaims({sub:'unbound',email:'member@example.com',role:'PLATFORM_ADMIN'});await expect(f.oidc.callback(input)).rejects.toThrow('尚未绑定');expect(f.login).not.toHaveBeenCalled();
  });
  it('停用账号、提供商配置变更和issuer混淆均拒绝',async()=>{
    const f=await oidcFixture();let input=await f.begin();f.disable();await expect(f.oidc.callback(input)).rejects.toThrow('尚未绑定');
    input=await f.begin();f.oidc.configure(admin,{...f.provider,name:'已变更'});await expect(f.oidc.callback(input)).rejects.toThrow('配置已变化');
    f.setIssuer('https://evil.example');await expect(f.oidc.begin(f.provider.id)).rejects.toThrow('issuer');
  });
  it('拒绝错误issuer、audience、azp与过期JWT',async()=>{
    const f=await oidcFixture();
    for(const claims of [{iss:'https://evil.example'},{aud:'other-client'},{azp:'other-client'},{exp:1}]){
      f.setClaims(claims);const input=await f.begin();await expect(f.oidc.callback(input)).rejects.toThrow('令牌');
    }
    expect(f.login).not.toHaveBeenCalled();
  });
  it('跨组织绑定和普通成员配置被拒绝，配置响应不回显Client Secret',async()=>{
    const f=await oidcFixture();expect(()=>f.oidc.bind(foreign,{providerId:f.provider.id,subject:'s',accountId:'t1/member'})).toThrow();expect(()=>f.oidc.configure(member,{name:'SSO'})).toThrow('管理员');const p=f.oidc.configure(admin,{...f.provider,clientSecret:'sensitive-secret'});expect(p.hasClientSecret).toBe(true);expect(JSON.stringify(f.oidc.list(admin))).not.toContain('sensitive-secret');
  });
});
