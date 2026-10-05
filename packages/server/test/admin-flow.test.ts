import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';import {afterEach,expect,it} from 'vitest';
import {AdminSettings} from '../src/admin-settings.ts';import {AdminIdentity} from '../src/admin-identity.ts';import {createAdminHandler,sessionToken} from '../src/admin-api.ts';import {Evaluations} from '../src/admin-evaluations.ts';
const clean:(()=>Promise<void>|void)[]=[];afterEach(async()=>{for(const fn of clean.splice(0))await fn();});
it('HTTP初始化、Cookie登录、CSRF、草稿发布、账号禁用形成闭环',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tao-admin-http-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
 const settings=new AdminSettings({directory:join(root,'settings')}),identity=new AdminIdentity(root,{accounts:[]},'claim-test-only-1234');let applied=false;
 const handler=createAdminHandler({settings,identity,bootstrapToken:'claim-test-only-1234',authenticate:async req=>identity.session(sessionToken(req))?.principal,apply:()=>()=>{applied=true;},observability:()=>({}),evaluations:new Evaluations(root),evaluate:async()=>({answer:'OK',taskId:'t',status:'SUCCEEDED'})});
 const server=createServer((req,res)=>{void handler(req,res);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));clean.unshift(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const base='http://127.0.0.1:'+(server.address() as any).port;let cookie='',csrf='';
 async function call(path:string,method='GET',body?:unknown,secure=true){return fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...(secure?{'X-CSRF-Token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});}
 expect((await call('/api/control/settings')).status).toBe(401);
 expect((await call('/api/control/bootstrap','POST',{claimToken:'claim-test-only-1234',userId:'owner',password:'safe-test-password'})).status).toBe(201);
 const login=await call('/api/auth/login','POST',{userId:'owner',password:'safe-test-password'});expect(login.status).toBe(200);cookie=login.headers.get('set-cookie')!.split(';')[0]!;csrf=(await login.json()).csrf;expect(csrf).toBeTruthy();
 let current=await (await call('/api/control/settings')).json();
 expect((await call('/api/control/settings/draft','PUT',{expectedRevision:current.revision,values:{BRAND_NAME:'测试平台'}},false)).status).toBe(403);
 const saved=await call('/api/control/settings/draft','PUT',{expectedRevision:current.revision,values:{BRAND_NAME:'测试平台',MODEL_API_KEY:'private-test-key'}});expect(saved.status).toBe(200);current=await saved.json();expect(JSON.stringify(current)).not.toContain('private-test-key');
 expect((await call('/api/control/settings/apply','POST',{expectedRevision:current.revision})).status).toBe(200);expect(applied).toBe(true);expect((await (await call('/api/branding')).json()).name).toBe('测试平台');
 const user=await (await call('/api/control/accounts','POST',{username:'member',password:'safe-member-password',role:'MEMBER'})).json();expect(user.id).toBeTruthy();
 expect((await call('/api/control/accounts/'+encodeURIComponent(user.id),'PATCH',{enabled:false})).status).toBe(200);
 const list=await (await call('/api/control/accounts')).json();expect(list.accounts.find((a:any)=>a.id===user.id).enabled).toBe(false);
});
