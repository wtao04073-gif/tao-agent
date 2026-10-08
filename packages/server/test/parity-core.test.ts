import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {zipSync,strToU8} from 'fflate';
import {SkillPackages} from '../src/skill-packages.ts';
import {BrowserSessions} from '../src/sandbox/browser-sessions.ts';
import {imageAttachments} from '../src/multimodal.ts';
import {modelProfiles,extraModelEndpoints} from '../src/model-profiles.ts';
const paths:string[]=[];const root=()=>{const p=mkdtempSync(join(tmpdir(),'tao-parity-'));paths.push(p);return p;};const tenant={tenantId:'t',workspaceId:'w',userId:'u'};
afterEach(()=>{for(const p of paths.splice(0))rmSync(p,{recursive:true,force:true});});
const archive=(extra:Record<string,Uint8Array>={})=>Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: sample-skill\ndescription: Run a sample data calculation\n---\nUse scripts/main.py'), 'scripts/main.py':strToU8('print(1+1)'),...extra})).toString('base64');
describe('技能包与浏览器登录态',()=>{
 it('导入标准元数据与脚本，元数据列表不泄漏脚本源码',()=>{const store=new SkillPackages(root()),item=store.import(tenant,archive());expect(item.scripts).toEqual([{path:'scripts/main.py',language:'python'}]);expect(JSON.stringify(store.list(tenant))).not.toContain('print(1+1)');expect(store.get({...tenant,userId:'other'},item.id)).toBeUndefined();store.update(tenant,item.id,false);expect(store.list(tenant)[0]?.enabled).toBe(false);});
 it('压缩包路径逃逸与膨胀超限拒绝',()=>{const s=new SkillPackages(root());expect(()=>s.import(tenant,archive({'../escape.py':strToU8('pass')}))).toThrow();expect(()=>s.import(tenant,archive({'large.txt':new Uint8Array(6*1024*1024)}))).toThrow('超限');});
 it('没有SKILL元数据或多入口不会静默导入',()=>{const s=new SkillPackages(root());expect(()=>s.import(tenant,Buffer.from(zipSync({'SKILL.md':strToU8('# no metadata')})).toString('base64'))).toThrow('YAML');expect(()=>s.import(tenant,archive({'other/SKILL.md':strToU8('---')}))).toThrow('唯一');});
 it('禁用技能不能用于新任务',()=>{const s=new SkillPackages(root()),p=s.import(tenant,archive());s.update(tenant,p.id,false);expect(()=>s.tool(tenant,'t',root(),p.id,{} as any)).toThrow('停用');});
 it('浏览器登录态加密保存、按用户隔离、过期和撤销',()=>{const dir=root(),s=new BrowserSessions(dir),secret='private-cookie-value';s.save(tenant,'session',{cookies:[{value:secret}]});expect(s.load(tenant,'session')).toEqual({cookies:[{value:secret}]});expect(s.list({...tenant,userId:'other'})).toEqual([]);expect(()=>s.load({...tenant,userId:'other'},'session')).toThrow();expect(()=>s.save(tenant,'../bad',{})).toThrow();expect(new BrowserSessions(dir).load(tenant,'session')).toEqual({cookies:[{value:secret}]});s.remove(tenant,'session');expect(()=>s.load(tenant,'session')).toThrow();});
});
describe('模型配置与图片输入',()=>{
 it('支持独立供应商配置且公开目录无密钥',()=>{const v={MODEL_A_NAME:'some-model',MODEL_A_BASE_URL:'https://example.com/v1',MODEL_A_API_KEY:'private-placeholder',MODEL_A_VISION:'true'};expect(extraModelEndpoints(v)['model-a']?.vision).toBe(true);expect(modelProfiles(v).find(x=>x.id==='model-a')?.available).toBe(true);expect(JSON.stringify(modelProfiles(v))).not.toContain(v.MODEL_A_API_KEY);expect(()=>extraModelEndpoints({MODEL_A_NAME:'incomplete'})).toThrow('完整');});
 it('图片转为原生image块，假图片与超大图片拒绝',()=>{const dir=root(),p=join(dir,'image.png');writeFileSync(p,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yQAAAABJRU5ErkJggg==','base64'));expect(imageAttachments([p])[0]).toMatchObject({type:'image',mimeType:'image/png'});writeFileSync(p,'not an image');expect(()=>imageAttachments([p])).toThrow('格式');writeFileSync(p,Buffer.alloc(6*1024*1024));expect(()=>imageAttachments([p])).toThrow('5MB');});
});
