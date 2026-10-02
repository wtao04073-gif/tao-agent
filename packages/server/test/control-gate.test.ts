import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {afterEach,describe,it,expect} from 'vitest';
import {Role} from '@tao/core';
import {handleControlGate} from '../src/control-gate.ts';

describe('管控端隔离',()=>{
 it('未登录401、成员403、管理员可取页面，编码别名仍受保护',async()=>{
 const root=mkdtempSync(join(tmpdir(),'control-gate-'));mkdirSync(join(root,'control'));writeFileSync(join(root,'control/index.html'),'control page');
 const server=createServer((req,res)=>{void handleControlGate(req,res,{webDir:root,authenticate:async r=>r.headers.authorization?{tenant:{tenantId:'t',workspaceId:'w',userId:'u'},role:r.headers.authorization==='admin'?Role.TenantAdmin:Role.Member}:undefined}).then(done=>{if(!done){res.writeHead(404);res.end();}});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('no address');
 try{for(const path of ['/control/','/%63ontrol/index.html','/desktop/admin.html']){
  expect((await fetch(`http://127.0.0.1:${address.port}${path}`,{redirect:'manual'})).status).toBe(401);
  expect((await fetch(`http://127.0.0.1:${address.port}${path}`,{headers:{Authorization:'member'},redirect:'manual'})).status).toBe(403);
 }
 expect((await fetch(`http://127.0.0.1:${address.port}/control/`,{headers:{Authorization:'admin'}})).status).toBe(200);
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
 });
});
