import {expect,it,afterEach} from 'vitest';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Evaluations} from '../src/admin-evaluations.ts';import {Role} from '@tao/core';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const p={name:'管理员',role:Role.TenantAdmin,tenant:{tenantId:'t',workspaceId:'w',userId:'u'}};
function setup(){const root=mkdtempSync(join(tmpdir(),'tao-eval-'));dirs.push(root);const service=new Evaluations(root);const d=service.dataset(p,{name:'基础',cases:[{query:'第一条',expected:['OK']},{query:'第二条',expected:['OK']}]});return {root,service,d};}
async function finish(s:Evaluations){for(let i=0;i<100&&s.busy;i++)await new Promise(r=>setTimeout(r,5));expect(s.busy).toBe(false);}
it('共享预算在第二个请求前阻断，失败预留仍记账',async()=>{const {service,d}=setup();let calls=0;const r=service.start(p,d.id,1,10,async(_q,_s,b)=>{b.reserve(60);calls++;return {answer:'OK',taskId:String(calls),status:'SUCCEEDED'};},100,2);await finish(service);expect(calls).toBe(1);expect(r.status).toBe('budget_exceeded');expect(r.tokens).toBe(60);});
it('取消传递到在途执行，未执行用例不判通过',async()=>{const {service,d}=setup();const r=service.start(p,d.id,1,10,async(_q,s)=>{await new Promise<void>(resolve=>s.addEventListener('abort',()=>resolve(),{once:true}));return {answer:'',taskId:'cancel',status:'CANCELLED'};});service.cancel(p,r.id);await finish(service);expect(r.status).toBe('cancelled');expect(r.results).toHaveLength(1);expect(r.results[0]!.passed).toBe(false);});
it('费用预算未配置单价不能执行，跨租户不可查看',()=>{const {service,d}=setup();expect(()=>service.start(p,d.id,1,10,async()=>({answer:'',taskId:'',status:''}),100,1,1)).toThrow('单价');expect(service.list({...p,tenant:{...p.tenant,tenantId:'other'}}).datasets).toEqual([]);});
it('评分依据和标签持久化，跨版本按用例ID对比',async()=>{
 const {service}=setup();const d=service.dataset(p,{name:'结构与工具',cases:[{query:'检查',expected:[],jsonKeys:['answer'],tools:['read_table'],tags:['表格']}]});
 const a=service.start(p,d.id,1,10,async()=>({answer:'普通文本',taskId:'a',status:'SUCCEEDED',tools:[]}));await finish(service);
 const b=service.start(p,d.id,2,10,async()=>({answer:'{"answer":"ok"}',taskId:'b',status:'SUCCEEDED',tools:['read_table']}));await finish(service);
 expect(a.results[0]!.passed).toBe(false);expect(b.results[0]!.passed).toBe(true);const diff=service.compare(p,a.id,b.id);expect(diff.cases[0]!.change).toBe('improved');expect(diff.cases[0]!.tags).toEqual(['表格']);
 expect(()=>service.compare({...p,tenant:{...p.tenant,tenantId:'other'}},a.id,b.id)).toThrow('不存在');
});
it('单条执行抛错仍记录失败并继续后续用例',async()=>{const {service,d}=setup();let calls=0;const r=service.start(p,d.id,1,10,async()=>{if(calls++===0)throw Error('private');return {answer:'OK',taskId:'ok',status:'SUCCEEDED'};});await finish(service);expect(r.results).toHaveLength(2);expect(r.results[0]!.status).toBe('FAILED');expect(r.results[1]!.passed).toBe(true);expect(JSON.stringify(r)).not.toContain('private');});
