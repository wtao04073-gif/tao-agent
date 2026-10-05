import {expect,it,afterEach} from 'vitest';
import {createServer} from 'node:http';
import {outboundFetch,networkPolicy} from '../src/admin-network.ts';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanup.splice(0))await f();});
async function serve(handler:Parameters<typeof createServer>[0]){const s=createServer(handler);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));cleanup.push(async()=>{s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));});return 'http://127.0.0.1:'+(s.address() as any).port;}
it('私网默认拒绝，显式网段允许；元数据和IPv6映射不能绕过',()=>{expect(()=>networkPolicy()('127.0.0.1')).toThrow();expect(()=>networkPolicy('127.0.0.1/32')('127.0.0.1')).not.toThrow();for(const ip of ['169.254.169.254','::ffff:169.254.169.254','fe80::1','0.0.0.0'])expect(()=>networkPolicy('0.0.0.0/0,::/0')(ip)).toThrow();});
it('固定目标IP的真实HTTP请求可读取流式响应',async()=>{const base=await serve((_q,r)=>{r.write('第一段');setTimeout(()=>r.end('第二段'),10);});const response=await outboundFetch('127.0.0.1/32')(base,{signal:AbortSignal.timeout(1000)});expect(await response.text()).toBe('第一段第二段');});
it('不会跟随重定向转发密钥',async()=>{let calls=0;const base=await serve((_q,r)=>{calls++;r.writeHead(302,{Location:'/target'});r.end();});await expect(outboundFetch('127.0.0.1/32')(base,{headers:{Authorization:'Bearer test-only'},signal:AbortSignal.timeout(1000)})).rejects.toThrow('重定向');expect(calls).toBe(1);});
it('过大的响应在流式读取时终止',async()=>{const base=await serve((_q,r)=>r.end('123456789'));const response=await outboundFetch('127.0.0.1/32',5)(base);await expect(response.text()).rejects.toThrow('大小限制');});

it('域名解析后连接已校验的IP',async()=>{const base=await serve((_q,r)=>r.end('ok'));const response=await outboundFetch('127.0.0.1/32,::1/128')(base.replace('127.0.0.1','localhost'),{signal:AbortSignal.timeout(1000)});expect(await response.text()).toBe('ok');});
