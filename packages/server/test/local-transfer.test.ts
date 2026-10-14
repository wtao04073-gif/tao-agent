import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalTransferTools, transferTarget } from '../src/local-control/transfer.ts';
import type { LocalControlConfig } from '../src/local-control/types.ts';
const dirs:string[]=[];
afterEach(()=>{vi.restoreAllMocks();dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});
function setup(){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'local-transfer-')));dirs.push(dir);
 const root=join(dir,'allowed'),artifactDir=join(dir,'data','task');
 for(const p of [root,join(root,'out'),join(artifactDir,'.inputs')])mkdirSync(p,{recursive:true});
 const tenant={tenantId:'t',workspaceId:'w',userId:'u'},source=join(artifactDir,'.inputs','input.pdf');writeFileSync(source,'pdf fixture');
 const cfg:LocalControlConfig={enabled:true,singleUser:true,level:'workspace',roots:[root],mode:'bwrap',confined:true,os:'linux',network:false,allowInstall:false,allowDelete:true,allowWriteOutside:false,confirmMode:'always',sessionGrantTtlMin:30,timeoutSec:5,maxOutputKb:64,allowPatterns:[],denyPatterns:[],protectedPaths:[join(dir,'data')],policyHash:'p',owner:tenant};
 const sources=[{fileId:'input-id',path:source,name:'input.pdf',sha256:createHash('sha256').update('pdf fixture').digest('hex')}];
 const audit=vi.fn(),tools=createLocalTransferTools(cfg,{tenant,taskId:'task',artifactDir,audit},sources);
 // 仅用模拟uid满足宿主身份门；不将此测试当作真实OS沙箱回归。
 vi.spyOn(process,'getuid').mockReturnValue(1000);
 const execute=(index:number,args:unknown,extra={})=>tools[index]!.execute({args,tenant,taskId:'task',signal:new AbortController().signal,report:()=>{},...extra});
 return {dir,root,artifactDir,source,cfg,sources,audit,execute};
}
describe('任务附件与本机授权目录桥接',()=>{
 it('复制仅限本任务输入副本，内容一致且执行审计记录完整',async()=>{const s=setup();const result=await s.execute(0,{fileId:'input-id',relativePath:'copy.pdf'});expect(result.isError).not.toBe(true);expect(readFileSync(join(s.root,'copy.pdf'),'utf8')).toBe('pdf fixture');expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({tool:'stage_to_local',decision:'executed',taskId:'task'}));});
 it('拒绝未引用文件、内容版本变化、不同任务及身份',async()=>{const s=setup();expect((await s.execute(0,{fileId:'other',relativePath:'copy.pdf'})).isError).toBe(true);expect((await s.execute(0,{fileId:'input-id',relativePath:'copy.pdf'},{taskId:'other'})).isError).toBe(true);writeFileSync(s.source,'changed');expect((await s.execute(0,{fileId:'input-id',relativePath:'copy.pdf'})).text).toContain('版本已变化');});
 it('目标不覆盖同名文件并拒绝绝对路径、上级路径及软链接',async()=>{const s=setup();writeFileSync(join(s.root,'copy.pdf'),'existing');expect((await s.execute(0,{fileId:'input-id',relativePath:'copy.pdf'})).isError).toBe(true);expect(readFileSync(join(s.root,'copy.pdf'),'utf8')).toBe('existing');symlinkSync(s.artifactDir,join(s.root,'escape'));for(const relativePath of ['../data/file','/tmp/file','escape/file'])expect(()=>transferTarget(s.cfg,{fileId:'input-id',relativePath},true)).toThrow();});
 it('只读档位拒绝写入，rootIndex校验且任务out可反向下载',async()=>{const s=setup();expect(()=>transferTarget({...s.cfg,level:'readonly'},{fileId:'input-id',relativePath:'copy.pdf'},true)).toThrow('只读');expect(()=>transferTarget(s.cfg,{rootIndex:1},false)).toThrow();writeFileSync(join(s.root,'out','result.txt'),'result');const result=await s.execute(1,{});expect(result.isError).not.toBe(true);const paths=(result.details as {outputPaths:string[]}).outputPaths;expect(paths).toHaveLength(1);expect(paths[0]).toContain(s.artifactDir);expect(readFileSync(paths[0]!,'utf8')).toBe('result');});
});
