import { afterEach,describe,expect,it } from 'vitest';
import { mkdtempSync,readFileSync,rmSync,statSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AUTOMATION_KEY_FILE,AutomationStore } from '../src/automation-store.ts';
const dirs:string[]=[];const make=()=>{const dir=mkdtempSync(join(tmpdir(),'tao-encrypted-store-'));dirs.push(dir);return dir;};
const item={id:'one',tenant:{tenantId:'t1',workspaceId:'w1',userId:'u1'},secret:'credential-must-not-be-plaintext',verifier:'pkce-verifier',payload:{text:'private result'}};
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
describe('自动化敏感存储加密',()=>{
  it('磁盘不含密钥字段正文，重启可解密并按租户过滤，密钥权限0600',()=>{
    const dir=make();const store=new AutomationStore<typeof item>(dir,'connector-bindings');store.put(item);const disk=readFileSync(join(dir,'connector-bindings','one.json'),'utf8');expect(disk).not.toContain(item.secret);expect(disk).not.toContain(item.verifier);expect(disk).not.toContain('private result');expect(statSync(join(dir,AUTOMATION_KEY_FILE)).mode&0o777).toBe(0o600);
    const restarted=new AutomationStore<typeof item>(dir,'connector-bindings');expect(restarted.get('one')).toEqual(item);expect(restarted.listByTenant('t1','w1')).toEqual([item]);expect(restarted.listByTenant('t2','w1')).toEqual([]);expect(restarted.create(item)).toBe(false);
  });
  it('读取旧明文记录时原子迁移为密文',()=>{
    const dir=make();const store=new AutomationStore<typeof item>(dir,'enterprise-oidc-transactions');writeFileSync(join(dir,'enterprise-oidc-transactions','one.json'),JSON.stringify(item));expect(store.all()).toEqual([item]);expect(readFileSync(join(dir,'enterprise-oidc-transactions','one.json'),'utf8')).not.toContain(item.secret);
  });
  it('密钥丢失、长度损坏、错误密钥均失败关闭',()=>{
    for(const kind of ['missing','short','wrong']){const dir=make();new AutomationStore<typeof item>(dir,'automation-outbox').put(item);const key=join(dir,AUTOMATION_KEY_FILE);if(kind==='missing')rmSync(key);else writeFileSync(key,Buffer.alloc(kind==='short'?8:32));if(kind==='wrong')expect(()=>new AutomationStore<typeof item>(dir,'automation-outbox').get('one')).toThrow('密文');else expect(()=>new AutomationStore<typeof item>(dir,'automation-outbox')).toThrow('密钥');}
  });
  it('篡改租户索引、认证tag或密文不能读取',()=>{
    for(const field of ['tenant','tag','ciphertext']){const dir=make();const store=new AutomationStore<typeof item>(dir,'enterprise-policies');store.put(item);const file=join(dir,'enterprise-policies','one.json');const envelope=JSON.parse(readFileSync(file,'utf8'));if(field==='tenant')envelope.tenant.tenantId='t2';else envelope[field]=Buffer.alloc(field==='tag'?16:48).toString('base64');writeFileSync(file,JSON.stringify(envelope));expect(()=>store.get('one')).toThrow('密文');}
  });
});
