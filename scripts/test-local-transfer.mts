import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalTransferTools } from '../packages/server/src/local-control/transfer.ts';
import { createLocalShellToolset } from '../packages/server/src/local-control/tool.ts';
import type { LocalControlConfig } from '../packages/server/src/local-control/types.ts';

assert.notEqual(process.getuid?.(),0,'真实本机链路必须以非root运行');
assert(['linux','darwin'].includes(process.platform),'仅支持Linux/macOS');
const base=realpathSync(mkdtempSync(join(tmpdir(),'tao-transfer-e2e-'))),root=join(base,'authorized'),artifactDir=join(base,'data','task');
for(const dir of [root,join(root,'out'),join(artifactDir,'.inputs')])mkdirSync(dir,{recursive:true,mode:0o700});
const tenant={tenantId:'test',workspaceId:'test',userId:'test'},path=join(artifactDir,'.inputs','input.txt'),contents='附件处理链路';writeFileSync(path,contents);
const cfg:LocalControlConfig={enabled:true,singleUser:true,level:'workspace',roots:[root],mode:process.platform==='darwin'?'seatbelt':'bwrap',confined:true,os:process.platform,network:false,allowInstall:false,allowDelete:true,allowWriteOutside:false,confirmMode:'always',sessionGrantTtlMin:30,timeoutSec:5,maxOutputKb:64,allowPatterns:[],denyPatterns:[],protectedPaths:[join(base,'data')],policyHash:'e2e',owner:tenant};
const context={tenant,taskId:'task',artifactDir},[stage,collect]=createLocalTransferTools(cfg,context,[{fileId:'input',name:'input.txt',path,sha256:createHash('sha256').update(contents).digest('hex')}]);
const [shell]=createLocalShellToolset(cfg,context),call=(args:unknown)=>({args,tenant,taskId:'task',signal:new AbortController().signal,report:()=>{}});
try{
 const staged=await stage!.execute(call({fileId:'input',relativePath:'copy.txt'}));assert.notEqual(staged.isError,true,staged.text);assert.equal(readFileSync(join(root,'copy.txt'),'utf8'),contents);
 const executed=await shell!.execute(call({command:'cat copy.txt > out/result.txt',cwd:'.'}));assert.notEqual(executed.isError,true,executed.text);assert.equal(readFileSync(join(root,'out','result.txt'),'utf8'),contents);
 const result=await collect!.execute(call({}));assert.notEqual(result.isError,true,result.text);const paths=(result.details as {outputPaths:string[]}).outputPaths;assert.equal(paths.length,1);assert.equal(readFileSync(paths[0]!,'utf8'),contents);
 console.log('通过：真实附件 stage → 隔离 shell → collect，交付内容一致');
}finally{rmSync(base,{recursive:true,force:true});}
