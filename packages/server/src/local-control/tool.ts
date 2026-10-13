import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, open, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { PlatformTool, TenantContext, ToolOutcome } from '@tao/core';
import { classifyCommand } from './classify.ts';
import { safeJoin } from './config.ts';
import { buildLocalRunner, scrubLocalEnv } from './profile.ts';
import type { LocalControlConfig, LocalExecutionAudit, LocalShellArgs } from './types.ts';

const MAX_OUTPUT = 64 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_DELIVERY = 50 * 1024 * 1024;
const activeRoots = new Set<string>();
const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
const sameTenant = (a: TenantContext, b: TenantContext) => a.tenantId === b.tenantId && a.workspaceId === b.workspaceId && a.userId === b.userId;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export interface LocalShellContext {
  tenant: TenantContext;
  taskId: string;
  artifactDir: string;
  audit?: (event: LocalExecutionAudit) => void | Promise<void>;
}

function checkHardLinks(root:string):void {let count=0;const walk=(dir:string,depth:number)=>{if(depth>24)throw Error('授权目录层级过深');for(const name of readdirSync(dir)){if(++count>20000)throw Error('授权目录文件过多，请缩小授权范围');const path=join(dir,name),s=lstatSync(path);if(s.isSymbolicLink())continue;if(s.isFile()&&s.nlink>1)throw Error('授权目录含硬链接文件，请先移除以保护目录边界');if(s.isDirectory())walk(path,depth+1);}};walk(root,0);}
function assertRuntime(cfg: LocalControlConfig): void {
  if (!cfg.enabled || !cfg.singleUser || cfg.level === 'off' || !cfg.owner) throw new Error('本机执行未启用或身份不匹配');
  if (!process.getuid || process.getuid() === 0) throw new Error('禁止以root身份执行本机命令');
  if (!cfg.confined || cfg.mode === 'advisory') throw new Error('隔离执行不可用，已拒绝执行');
  if ((cfg.mode === 'seatbelt' && process.platform !== 'darwin') || (cfg.mode === 'bwrap' && process.platform !== 'linux')) throw new Error('隔离方式与系统不匹配');
  const binary = cfg.mode === 'seatbelt' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap';
  if (!existsSync(binary)) throw new Error('隔离程序不可用，已拒绝执行');
  if (!cfg.roots.length) throw new Error('缺少授权目录');
  for (const root of cfg.roots) {
    if (root === '/' || realpathSync(root) !== root || !statSync(root).isDirectory()) throw new Error('授权目录已变化');
    checkHardLinks(root);
    if (cfg.protectedPaths.some(path => within(root, path) || within(path, root))) throw new Error('授权目录包含受保护路径');
  }
}

function layout(cfg: LocalControlConfig, index: number) {
  const root = cfg.roots[index];
  if (!root) throw new Error('授权目录编号无效');
  const paths = { root, home: safeJoin(root, 'home'), tmp: safeJoin(root, 'tmp'), out: safeJoin(root, 'out'), work: safeJoin(root, 'work') };
  for (const path of [paths.home, paths.tmp, paths.out, paths.work]) {
    if (cfg.level !== 'readonly') mkdirSync(path, { recursive: true, mode: 0o700 });
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory())) throw new Error('本机工作目录无效');
  }
  return paths;
}

export interface ProcessResult {
  text: string;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}

/** Bounded merged tail; one process group is killed on every terminal path. */
export function runLocalProcess(
  runner: { file: string; argv: string[] },
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number; signal: AbortSignal; report: (text: string) => void },
): Promise<ProcessResult> {
  const maxBytes = Math.max(1, Math.min(MAX_OUTPUT, options.maxBytes));
  if (options.signal.aborted) return Promise.resolve({ text: '命令已取消', code: null, timedOut: false, aborted: true, truncated: false });
  return new Promise((resolveResult, reject) => {
    const child = spawn(runner.file, runner.argv, { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = Buffer.alloc(0), dirty = false, truncated = false, timedOut = false, aborted = false, done = false;
    let killFallback: ReturnType<typeof setTimeout> | undefined;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } } } };
    const tailText = () => {
      let value = tail.toString('utf8');
      // Replacement characters at a truncated UTF-8 boundary can add bytes.
      while (Buffer.byteLength(value) > maxBytes) value = value.slice(1);
      return value.replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g,'<REDACTED>').replace(/(Bearer\s+)[^\s]+/gi,'$1<REDACTED>');
    };
    const flush = () => { if (dirty) { dirty = false; try { options.report(tailText()); } catch { /* reporting must not orphan the child */ } } };
    const collect = (chunk: Buffer) => {
      if (tail.length + chunk.length > maxBytes) truncated = true;
      tail = chunk.length >= maxBytes ? Buffer.from(chunk.subarray(chunk.length - maxBytes)) : Buffer.concat([tail.subarray(Math.max(0, tail.length + chunk.length - maxBytes)), chunk]);
      dirty = true;
    };
    const cleanup = () => { clearTimeout(timeout); clearInterval(ticker); if (killFallback) clearTimeout(killFallback); options.signal.removeEventListener('abort', abort); };
    const finish = (code: number | null) => {
      if (done) return;
      done = true; kill(); cleanup(); flush();
      resolveResult({ text: tailText(), code, timedOut, aborted, truncated });
    };
    const terminate = () => {
      kill();
      // Detached grandchildren must not retain our output pipes forever.
      killFallback ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null); }, 1000);
    };
    const abort = () => { aborted = true; terminate(); };
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
    const ticker = setInterval(flush, 500);
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', () => { if (done) return; done = true; kill(); cleanup(); reject(new Error('隔离进程启动失败')); });
    child.once('exit', () => { kill(); killFallback ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(child.exitCode); }, 1000); });
    child.once('close', finish);
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
  });
}

interface OutputFile { path: string; stamp: string; }
async function outputFiles(out: string): Promise<OutputFile[]> {
  if (!existsSync(out)) return [];
  if (lstatSync(out).isSymbolicLink() || await realpath(out) !== out) throw new Error('产物目录不得是符号链接');
  const files: OutputFile[] = [];
  let visited = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 8 || ++visited > 1000) throw new Error('产物目录数量超出限制');
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) continue;
      if (await realpath(path) !== path || !within(out, path)) throw new Error('产物目录已变化');
      if (item.isDirectory()) await walk(path, depth + 1);
      else if (item.isFile()) {
        const info = await stat(path);
        if (info.nlink !== 1 || info.size > MAX_FILE) continue;
        files.push({ path, stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` });
        if (files.length > 100) throw new Error('产物文件数量超出限制');
      }
    }
  }
  await walk(out, 0);
  return files;
}

/** Copy only changed, private regular files. Never hand local paths to downloads. */
export async function collectLocalArtifacts(out: string, artifactDir: string, before: ReadonlyMap<string, string>): Promise<string[]> {
  const files = await outputFiles(out);
  const outputPaths: string[] = [];
  let total = 0;
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  if (realpathSync(artifactDir) !== resolve(artifactDir)) throw new Error('任务产物目录不得经过符号链接');
  for (const file of files) {
    if (before.get(file.path) === file.stamp) continue;
    if (await realpath(file.path) !== file.path) throw new Error('产物文件已变化');
    const source = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await source.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE || total + info.size > MAX_DELIVERY) continue;
      if (`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` !== file.stamp) throw new Error('产物在打开前发生变化');
      // Read a fixed bound even if another process appends to the source.
      const bytes = Buffer.alloc(info.size);
      let position = 0;
      while (position < bytes.length) { const read = await source.read(bytes, position, bytes.length - position, position); if (!read.bytesRead) break; position += read.bytesRead; }
      const after = await source.stat();
      if (position !== bytes.length || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.nlink !== 1 || await realpath(file.path) !== file.path) throw new Error('产物在复制期间发生变化');
      const target = join(artifactDir, `local-${randomUUID().slice(0, 8)}-${basename(file.path)}`);
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      total += bytes.length; outputPaths.push(target);
    } finally { await source.close(); }
  }
  return outputPaths;
}

export function createLocalShellToolset(cfg: LocalControlConfig, context: LocalShellContext): PlatformTool[] {
  if (!cfg.enabled || !cfg.singleUser || cfg.level === 'off' || !cfg.confined || cfg.mode === 'advisory' || !cfg.owner || !sameTenant(cfg.owner, context.tenant)) return [];
  return [{
    name: 'local_shell', label: '本机命令执行', replay: 'never',
    description: '在当前服务所在电脑的授权目录内执行命令；默认工作目录为 work。交付文件应写入所选授权根的 out 子目录，可设置 cwd 为 . 后使用 out/...；系统会复制到任务结果面板。受管理员权限和用户确认约束。',
    parameters: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 32768 }, cwd: { type: 'string', description: '相对所选授权根目录的路径' }, rootIndex: { type: 'integer', minimum: 0 }, timeoutSec: { type: 'number', minimum: 1, maximum: cfg.timeoutSec } }, required: ['command'], additionalProperties: false },
    async execute({ args, tenant, taskId, signal, report }): Promise<ToolOutcome> {
      const started = Date.now();
      let locked = false;
      let audit: LocalExecutionAudit = { tenant: context.tenant, taskId: context.taskId, decision: 'blocked' };
      try {
        assertRuntime(cfg);
        if (!sameTenant(tenant, context.tenant) || taskId !== context.taskId || !sameTenant(tenant, cfg.owner!)) throw new Error('本机执行身份不匹配');
        if (cfg.roots.some(root => within(root, resolve(context.artifactDir)))) throw new Error('任务产物目录不得位于本机授权目录内');
        const input = args as LocalShellArgs;
        if (!input || typeof input.command !== 'string' || !input.command.trim() || input.command.length > 32768 || input.command.includes('\0')) throw new Error('命令参数无效');
        if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new Error('工作目录参数无效');
        const index = input.rootIndex ?? 0;
        if (!Number.isSafeInteger(index) || index < 0 || index >= cfg.roots.length) throw new Error('授权目录编号无效');
        const seconds = input.timeoutSec ?? cfg.timeoutSec;
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > cfg.timeoutSec) throw new Error('执行超时参数无效');
        const risk = classifyCommand(input.command, cfg);
        audit = { ...audit, risk: risk.reason, capabilities: risk.capabilities };
        if (risk.kind === 'block') throw new Error(`命令被安全策略拒绝：${risk.reason}`);
        if (cfg.roots.some(root => activeRoots.has(root))) throw new Error('授权目录有命令正在运行，请稍后重试');
        cfg.roots.forEach(root => activeRoots.add(root)); locked = true;
        const paths = layout(cfg, index);
        const cwd = safeJoin(paths.root, input.cwd ?? '.');
        if (!statSync(cwd).isDirectory()) throw new Error('工作目录不存在');
        const before = new Map((await outputFiles(paths.out)).map(file => [file.path, file.stamp]));
        if (signal.aborted) throw new Error('命令已取消');
        audit = { ...audit, decision: 'started' };
        await context.audit?.(audit);
        const result = await runLocalProcess(buildLocalRunner({ cfg, ...paths, cwd, command: input.command }), { cwd, env: scrubLocalEnv(paths.home, paths.tmp), timeoutMs: seconds * 1000, maxBytes: Math.min(MAX_OUTPUT, cfg.maxOutputKb * 1024), signal, report });
        const isError = result.code !== 0 || result.timedOut || result.aborted;
        const outputPaths = isError ? [] : await collectLocalArtifacts(paths.out, context.artifactDir, before);
        audit = { ...audit, decision: isError ? 'failed' : 'executed', code: result.code };
        const note = result.aborted ? '命令已取消' : result.timedOut ? '命令执行超时' : `退出码：${result.code}`;
        return { text: `${note}${result.truncated ? '（仅保留末尾64KB以内输出）' : ''}\n${result.text}`, isError, details: { code: result.code, timedOut: result.timedOut, aborted: result.aborted, truncated: result.truncated, outputPaths } };
      } catch (error) {
        return { isError: true, text: error instanceof Error && !('code' in error) ? error.message : '本机执行失败，请检查授权目录和隔离程序', details: { outputPaths: [] } };
      } finally {
        if (locked) cfg.roots.forEach(root => activeRoots.delete(root));
        await context.audit?.({ ...audit, durationMs: Date.now() - started });
      }
    },
  }];
}

/** Probe only temporary fixtures; unavailable isolation never falls back to a shell. */
export async function preflightLocalControl(cfg: LocalControlConfig): Promise<{ ok: boolean; confined: boolean; message: string; checks: string[] }> {
  let temporary: string | undefined;
  const probeDirs: string[] = [];
  const checks: string[] = [];
  const server = createServer(socket => { socket.destroy(); });
  try {
    assertRuntime(cfg);
    temporary = await mkdtemp(join(tmpdir(), 'tao-local-probe-'));
    await writeFile(join(temporary, 'private'), 'probe', { mode: 0o600 });
    const protectedProbe = join(temporary, 'protected');
    mkdirSync(protectedProbe, { mode: 0o700 });
    await writeFile(join(protectedProbe, 'private'), 'probe', { mode: 0o600 });
    const probeConfig = { ...cfg, protectedPaths: [...cfg.protectedPaths, await realpath(protectedProbe)] };
    await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen()); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('网络边界预检无法启动');
    // Seatbelt 按 protectedPaths 限制读取；bwrap 仍不暴露授权根外的普通文件。
    const tests = [
      cfg.mode === 'seatbelt' ? `test -r ${quote(join(temporary, 'private'))} || exit 40` : `test ! -r ${quote(join(temporary, 'private'))} || exit 40`,
      `if ( : > ${quote(join(temporary, 'escape'))} ) 2>/dev/null; then exit 41; fi`,
      `if cat ${quote(join(protectedProbe, 'private'))} >/dev/null 2>&1; then exit 44; fi`,
      `if ( : > ${quote(join(protectedProbe, 'write'))} ) 2>/dev/null; then exit 47; fi`,
    ];
    for (const root of cfg.roots) {
      const probe = await mkdtemp(join(root, '.tao-probe-')); probeDirs.push(probe);
      tests.push(cfg.level === 'readonly' ? `if ( : > ${quote(join(probe, 'write'))} ) 2>/dev/null; then exit 42; fi` : `: > ${quote(join(probe, 'write'))} || exit 43`);
    }
    for (const path of cfg.protectedPaths.filter(existsSync)) tests.push(`test ! -r ${quote(path)} || exit 44`);
    const connection = `( : > /dev/tcp/127.0.0.1/${address.port} ) 2>/dev/null`;
    tests.push(cfg.network ? `${connection} || exit 45` : `if ${connection}; then exit 46; fi`);
    const root = cfg.roots[0]!;
    const result = await runLocalProcess(buildLocalRunner({ cfg: probeConfig, cwd: root, home: join(root, 'home'), tmp: join(root, 'tmp'), command: tests.join('\n') + '\nexit 0' }), { cwd: root, env: scrubLocalEnv(join(root, 'home'), join(root, 'tmp')), timeoutMs: 5000, maxBytes: 4096, signal: new AbortController().signal, report: () => {} });
    if (result.code !== 0 || result.timedOut) throw new Error('实际隔离执行或目录/网络边界预检未通过');
    checks.push('隔离进程可运行', cfg.level === 'readonly' ? '授权目录只读' : '授权目录可写', cfg.mode === 'seatbelt' ? '授权范围外不可写；普通文件读取开放' : '授权范围外不可读写', '受保护路径不可读写', cfg.network ? '联网已开放' : '网络隔离生效');
    return { ok: true, confined: true, message: '本机隔离预检通过', checks };
  } catch (error) {
    return { ok: false, confined: false, message: error instanceof Error && !('code' in error) ? error.message : '本机隔离预检失败', checks };
  } finally {
    server.close();
    for (const directory of probeDirs) await rm(directory, { recursive: true, force: true });
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
