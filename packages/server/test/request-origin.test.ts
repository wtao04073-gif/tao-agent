import {expect,it} from 'vitest';
import type {IncomingMessage} from 'node:http';
import {createOriginPolicy} from '../src/request-origin.ts';
function request(origin?:string,host='127.0.0.1:8277',forwarded?:string){return {headers:{host,...(origin===undefined?{}:{origin}),...(forwarded?{'x-forwarded-host':forwarded}:{})},socket:{}} as IncomingMessage;}
it('公开HTTPS来源可通过改写Host的代理，未知来源仍拒绝',()=>{const allowed=createOriginPolicy('https://agent.example.com');expect(allowed(request('https://agent.example.com'))).toBe(true);expect(allowed(request('https://evil.example.com'))).toBe(false);expect(allowed(request('http://agent.example.com'))).toBe(false);expect(allowed(request('https://agent.example.com:444'))).toBe(false);});
it('不信任伪造转发头、不接受null或含路径的来源',()=>{const allowed=createOriginPolicy();for(const value of ['null','https://evil.example.com','http://127.0.0.1:8277/path','not a url'])expect(allowed(request(value,'127.0.0.1:8277','evil.example.com'))).toBe(false);});
it('保留直连同源与无Origin令牌客户端，校验配置',()=>{const allowed=createOriginPolicy();expect(allowed(request('http://127.0.0.1:8277'))).toBe(true);expect(allowed(request())).toBe(true);for(const value of ['https://*.test','https://a.test/path','https://user:password@a.test','null'])expect(()=>createOriginPolicy(value)).toThrow();});
