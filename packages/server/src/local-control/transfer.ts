import { createHash } from 'node:crypto';
import { constants, realpathSync, statSync } from 'node:fs';
import { open, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PlatformTool } from '@tao/core';
import { safeJoin } from './config.ts';
import { collectLocalArtifacts, assertLocalRuntime, reserveLocalRoots } from './tool.ts';
import type { LocalShellContext } from './tool.ts';
import type { LocalControlConfig } from './types.ts';

export interface LocalInputReference { readonly fileId: string; readonly name: string; readonly path: string; readonly sha256: string; }
export interface LocalTransferArgs { fileId?: string; rootIndex?: number; relativePath?: string; }
const MAX_INPUT = 50 * 1024 * 1024;

export function transferTarget(cfg: LocalControlConfig, args: LocalTransferArgs, staging: boolean): string {
  const index = args.rootIndex ?? 0;
  if (!Number.isSafeInteger(index) || index < 0 || index >= cfg.roots.length) throw Error('授权目录编号无效');
  if (!staging) return safeJoin(cfg.roots[index]!, 'out');
  if (cfg.level === 'readonly') throw Error('只读档位禁止复制附件到本机');
  if (typeof args.fileId !== 'string' || !args.fileId || typeof args.relativePath !== 'string' || !args.relativePath.trim()) throw Error('请选择本任务附件并填写目标相对文件路径');
  const target = safeJoin(cfg.roots[index]!, args.relativePath);
  if (target === cfg.roots[index] || !statSync(dirname(target)).isDirectory()) throw Error('目标父目录必须已存在');
  return target;
}

/** 只桥接本任务的私有输入副本；不接受模型提供的宿主路径，不覆盖现有文件。 */
export function createLocalTransferTools(cfg: LocalControlConfig, context: LocalShellContext, sources: readonly LocalInputReference[]): PlatformTool[] {
  const validContext = (tenant: typeof context.tenant, taskId: string) => {
    assertLocalRuntime(cfg);
    if (!cfg.owner || ['tenantId','workspaceId','userId'].some(k=>cfg.owner![k as keyof typeof context.tenant]!==tenant[k as keyof typeof tenant]) || taskId !== context.taskId || ['tenantId', 'workspaceId', 'userId'].some(k => tenant[k as keyof typeof tenant] !== context.tenant[k as keyof typeof tenant])) throw Error('本机文件传输身份不匹配');
  };
  return [{
    name: 'stage_to_local', label: '复制任务附件到本机', replay: 'never',
    description: '把本任务已引用的上传附件复制到本机授权根内。仅使用下列fileId，目标relativePath必须是授权根内的相对文件路径，父目录需已存在，且不覆盖已有文件。复制后local_shell可直接处理：' + JSON.stringify(sources.map(({fileId,name}) => ({fileId,name}))),
    parameters: { type: 'object', properties: { fileId: { type: 'string' }, rootIndex: { type: 'integer', minimum: 0 }, relativePath: { type: 'string' } }, required: ['fileId', 'relativePath'], additionalProperties: false },
    async execute({args, tenant, taskId, signal}) {
      let created: string | undefined;
      let releaseRoots: (() => void) | undefined;
      const started = Date.now();
      try {
        validContext(tenant,taskId);
        releaseRoots = reserveLocalRoots(cfg.roots);
        const input = args as LocalTransferArgs;
        const source = sources.find(s => s.fileId === input.fileId);
        if (!source) throw Error('附件未被本任务引用');
        const inputRoot = realpathSync(join(context.artifactDir, '.inputs'));
        if (dirname(source.path) !== inputRoot || await realpath(source.path) !== source.path) throw Error('任务输入路径无效');
        const target = transferTarget(cfg,input,true);
        const file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes: Buffer;
        try {
          const before = await file.stat();
          if (!before.isFile() || before.nlink !== 1 || before.size > MAX_INPUT) throw Error('附件类型或大小不满足传输条件');
          bytes = Buffer.alloc(before.size);
          let offset = 0;
          while (offset < bytes.length) { const r = await file.read(bytes,offset,bytes.length-offset,offset); if (!r.bytesRead) break; offset += r.bytesRead; }
          const after = await file.stat();
          if (offset !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.nlink !== 1 || createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw Error('附件版本已变化，拒绝复制');
        } finally { await file.close(); }
        if (signal.aborted) throw Error('复制已取消');
        // 写前再校验路径；wx 保证不会覆盖同名用户文件或跟随目标软链接。
        if (transferTarget(cfg,input,true) !== target) throw Error('目标路径已变化');
        const destination = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = target;
        try {
          if ((await destination.stat()).nlink !== 1 || await realpath(target) !== target) throw Error('目标路径已变化');
          await destination.writeFile(bytes);
          await destination.sync();
          const info = await destination.stat();
          if (info.nlink !== 1 || await realpath(target) !== target) throw Error('目标文件已变化');
        } finally { await destination.close(); }
        await context.audit?.({tenant,taskId,tool:'stage_to_local',decision:'executed',command:`复制附件 ${source.name}`,cwd:target,durationMs:Date.now()-started});
        created = undefined;
        return {text:`上传附件已放入授权目录：${target}。可使用 local_shell 在根内继续处理。`,details:{localPath:target,fileId:source.fileId}};
      } catch (e) {
        if (created) await unlink(created).catch(() => {});
        await context.audit?.({tenant:context.tenant,taskId:context.taskId,tool:'stage_to_local',decision:'failed',durationMs:Date.now()-started});
        return {isError:true,text:e instanceof Error && !('code' in e) ? e.message : '复制失败：请检查目标目录及同名文件'};
      } finally { releaseRoots?.(); }
    },
  }, {
    name:'collect_from_local',label:'收集本机交付物',replay:'never',
    description:'将所选本机授权根的 out 子目录内普通文件复制到任务交付物面板；只收集 out，不接受任意宿主源路径。',
    parameters:{type:'object',properties:{rootIndex:{type:'integer',minimum:0}},additionalProperties:false},
    async execute({args,tenant,taskId,signal}) {
      let releaseRoots: (() => void) | undefined;
      try {
        validContext(tenant,taskId); releaseRoots=reserveLocalRoots(cfg.roots); if(signal.aborted) throw Error('收集已取消');
        const out=transferTarget(cfg,args as LocalTransferArgs,false);
        const outputPaths=await collectLocalArtifacts(out,context.artifactDir,new Map());
        await context.audit?.({tenant,taskId,tool:'collect_from_local',decision:'executed',cwd:out});
        return {text:`已收集 ${outputPaths.length} 个本机交付物`,details:{outputPaths}};
      } catch(e) { return {isError:true,text:e instanceof Error && !('code' in e) ? e.message : '本机交付物收集失败'}; } finally { releaseRoots?.(); }
    },
  }];
}
