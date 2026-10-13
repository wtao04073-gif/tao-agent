import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLocalRunner, scrubLocalEnv, seatbeltProfile } from '../src/local-control/profile.ts';
import { collectLocalArtifacts, createLocalShellToolset, preflightLocalControl, runLocalProcess } from '../src/local-control/tool.ts';
import type { LocalControlConfig } from '../src/local-control/types.ts';

const directories: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'tao-runtime-test-')); directories.push(path); return path; };
const tenant = { tenantId: 'test', workspaceId: 'test', userId: 'test' };
function config(overrides: Partial<LocalControlConfig> = {}): LocalControlConfig {
  return { enabled: true, singleUser: true, level: 'workspace', roots: [temporary()], mode: 'bwrap', confined: true, os: 'linux', network: false, allowInstall: false, allowDelete: true, allowWriteOutside: false, confirmMode: 'always', sessionGrantTtlMin: 30, timeoutSec: 1, maxOutputKb: 64, allowPatterns: [], denyPatterns: [], protectedPaths: [], policyHash: 'test', owner: tenant, ...overrides };
}
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('本机隔离配置', () => {
  it('仅挂载系统运行目录和授权根，不绑定整个宿主文件系统', () => {
    const cfg = config();
    const { argv, file } = buildLocalRunner({ cfg, cwd: cfg.roots[0]!, home: '/test/home', tmp: '/test/tmp', command: 'pwd' });
    expect(file).toBe('/usr/bin/bwrap');
    expect(argv).toContain('--unshare-all');
    expect(argv).toContain('--clearenv');
    expect(argv).not.toContain('--share-net');
    expect(argv).toContain('--noprofile');
    expect(argv).toContain('--norc');
    expect(argv.some((arg, index) => ['--ro-bind', '--bind'].includes(arg) && argv[index + 1] === '/')).toBe(false);
    expect(argv).not.toContain('/etc');
    expect(argv).not.toContain('--proc');
    expect(argv.some((arg,i)=>arg==='--remount-ro'&&argv[i+1]==='/tmp')).toBe(true);
    expect(argv.some((arg,i)=>arg==='--remount-ro'&&argv[i+1]==='/')).toBe(true);
    expect(argv).toContain(cfg.roots[0]);
  });
  it('只读授权根使用只读挂载，开放联网只改变网络命名空间', () => {
    const cfg = config({ level: 'readonly', network: true });
    const { argv } = buildLocalRunner({ cfg, cwd: cfg.roots[0]!, home: '/home', tmp: '/tmp', command: 'pwd' });
    const rootIndex = argv.indexOf(cfg.roots[0]!);
    expect(argv[rootIndex - 1]).toBe('--ro-bind');
    expect(argv).toContain('--share-net');
  });
  it('Seatbelt 放行进程初始化，仅开放授权根写入并拒绝保护路径', () => {
    const cfg = config({ roots: ['/tmp/space "quoted"'], protectedPaths: ['/tmp/private'], mode: 'seatbelt' });
    const profile = seatbeltProfile(cfg);
    expect(profile).toContain('(allow default)');
    expect(profile).not.toContain('(deny default)');
    expect(profile).toContain('(deny file-write* (subpath "/"))');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain(JSON.stringify(cfg.roots[0]));
    expect(profile).toContain('(deny file-read* file-write* (subpath "/tmp/private"))');
    expect(profile.indexOf('(deny file-write*')).toBeLessThan(profile.indexOf('(allow file-write* (subpath'));
    expect(profile.indexOf('(allow file-write* (subpath')).toBeLessThan(profile.indexOf('(deny file-read* file-write*'));
    expect(profile).toContain('(literal "/dev/tty")');
    expect(profile).toContain('(literal "/dev/stderr")');
    expect(seatbeltProfile({ ...cfg, network: true })).toContain('(allow network*)');
    expect(seatbeltProfile({ ...cfg, level: 'readonly' })).not.toContain('(allow file-write* (subpath');
  });
  it('环境完全独立于宿主凭证与启动脚本变量', () => {
    const env = scrubLocalEnv('/authorized/home', '/authorized/tmp');
    expect(env).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin', OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',OMP_THREAD_LIMIT:'1', HOME: '/authorized/home', TMPDIR: '/authorized/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' });
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
  it('弱隔离或未确认单用户时不注册，无法构造弱隔离运行器', () => {
    const cfg = config();
    const context = { tenant, taskId: 'task', artifactDir: temporary() };
    expect(createLocalShellToolset({ ...cfg, singleUser: false }, context)).toEqual([]);
    expect(createLocalShellToolset({ ...cfg, mode: 'advisory' }, context)).toEqual([]);
    expect(createLocalShellToolset(cfg, { ...context, tenant: { ...tenant, userId: 'other' } })).toEqual([]);
    expect(() => buildLocalRunner({ cfg: { ...cfg, mode: 'advisory' }, cwd: '/', home: '/', tmp: '/', command: 'pwd' })).toThrow();
  });
  it('root 身份预检失败关闭且不会触碰授权目录', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const result = await preflightLocalControl(config());
    expect(result.ok).toBe(false);
    expect(result.confined).toBe(false);
    expect(result.message).toContain('root');
  });
});

describe('本机执行生命周期', () => {
  function run(code: string, overrides: Partial<Parameters<typeof runLocalProcess>[1]> = {}) {
    const directory = temporary();
    return runLocalProcess({ file: process.execPath, argv: ['-e', code] }, { cwd: directory, env: scrubLocalEnv(directory, directory), timeoutMs: 2000, maxBytes: 64 * 1024, signal: new AbortController().signal, report: () => {}, ...overrides });
  }
  it('合并输出保留64KB尾部，大量输出不会逐块推送', async () => {
    const report = vi.fn();
    const result = await run("process.stdout.write('a'.repeat(200000)); process.stdout.write('tail-marker')", { report });
    expect(result.code).toBe(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(64 * 1024);
    expect(result.text.endsWith('tail-marker')).toBe(true);
    expect(report.mock.calls.length).toBeLessThan(5);
  });
  it('非零退出码不会被转换成成功', async () => {
    const result = await run("process.stderr.write('failure'); process.exitCode=7");
    expect(result.code).toBe(7);
    expect(result.text).toContain('failure');
  });
  it('UTF-8 字符截断后的编码大小仍在限额内', async () => {
    const result = await run("process.stdout.write('中'.repeat(30000))");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(64 * 1024);
  });
  it('主进程退出后也会终止同组后台子进程', async () => {
    const marker = join(temporary(), 'late-write.txt');
    const childCode = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),300)`;
    const result = await run(`const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});c.unref()`);
    expect(result.code).toBe(0);
    await new Promise(resolveWait => setTimeout(resolveWait, 450));
    expect(existsSync(marker)).toBe(false);
  });
  it('超时结束进程并返回明确状态', async () => {
    const result = await run('setInterval(()=>{},1000)', { timeoutMs: 80 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });
  it('取消信号结束进程；提前取消不启动进程', async () => {
    const controller = new AbortController();
    const running = run('setInterval(()=>{},1000)', { signal: controller.signal });
    setTimeout(() => controller.abort(), 60);
    expect((await running).aborted).toBe(true);
    expect((await run('process.exit(0)', { signal: controller.signal })).aborted).toBe(true);
  });
});

describe('本机产物复制', () => {
  it('只交付普通文件，软链接和硬链接都不会交付', async () => {
    const out = temporary(), artifacts = temporary(), outside = temporary();
    writeFileSync(join(out, 'report.txt'), 'report');
    writeFileSync(join(outside, 'private.txt'), 'private fixture');
    symlinkSync(join(outside, 'private.txt'), join(out, 'symlink.txt'));
    linkSync(join(outside, 'private.txt'), join(out, 'hardlink.txt'));
    mkdirSync(join(out, 'nested'));
    writeFileSync(join(out, 'nested', 'second.txt'), 'second');
    const paths = await collectLocalArtifacts(out, artifacts, new Map());
    expect(paths).toHaveLength(2);
    expect(paths.every(path => path.startsWith(artifacts + '/'))).toBe(true);
    expect(paths.map(path => readFileSync(path, 'utf8')).sort()).toEqual(['report', 'second']);
  });
  it('不重复交付未改变文件，复制目标不覆盖已有用户文件', async () => {
    const out = temporary(), artifacts = temporary(), path = join(out, 'same.txt');
    writeFileSync(path, 'original');
    const info = statSync(path);
    const before = new Map([[path, `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`]]);
    writeFileSync(join(artifacts, 'same.txt'), 'existing');
    expect(await collectLocalArtifacts(out, artifacts, before)).toEqual([]);
    writeFileSync(path, 'changed');
    const paths = await collectLocalArtifacts(out, artifacts, before);
    expect(paths).toHaveLength(1);
    expect(readFileSync(paths[0]!, 'utf8')).toBe('changed');
    expect(readFileSync(join(artifacts, 'same.txt'), 'utf8')).toBe('existing');
  });
  it('替换out目录为软链接时拒绝扫描', async () => {
    const parent = temporary(), outside = temporary();
    symlinkSync(outside, join(parent, 'out'));
    await expect(collectLocalArtifacts(join(parent, 'out'), temporary(), new Map())).rejects.toThrow('符号链接');
  });
});
