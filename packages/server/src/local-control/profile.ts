import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import type { LocalControlConfig } from './types.ts';

export interface LocalRunnerInput {
  cfg: LocalControlConfig;
  cwd: string;
  home: string;
  tmp: string;
  command: string;
}

const SYSTEM_READS = ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/share', '/usr/local/bin', '/usr/local/lib', '/opt/homebrew/bin', '/opt/homebrew/lib', '/opt/homebrew/opt', '/opt/homebrew/Cellar', '/bin', '/sbin', '/lib', '/lib64'];
const MAC_READS = ['/System', '/Library/Apple', '/private/var/db/dyld'];
const schemeString = (value: string) => JSON.stringify(value);

/** No inherited credentials, shell hooks, search paths, or runtime loader options. */
export function scrubLocalEnv(home: string, tmp: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin', HOME: home, TMPDIR: tmp,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb',
    OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',OMP_THREAD_LIMIT:'1',PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
  };
}

export function seatbeltProfile(cfg: LocalControlConfig): string {
  const read = [...SYSTEM_READS, ...MAC_READS, ...cfg.roots];
  return [
    '(version 1)', '(deny default)',
    '(allow process-exec process-fork)', '(allow sysctl-read)',
    '(allow signal (target same-sandbox))',
    ...read.map(path => `(allow file-read* (subpath ${schemeString(path)}))`),
    '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/localtime"))',
    '(allow file-write* (literal "/dev/null"))',
    ...(cfg.level === 'readonly' ? [] : cfg.roots.map(path => `(allow file-write* (subpath ${schemeString(path)}))`)),
    ...(cfg.network ? ['(allow network*)', '(allow file-read* (literal "/private/etc/resolv.conf") (subpath "/private/etc/ssl"))'] : ['(deny network*)']),
    ...cfg.protectedPaths.map(path => `(deny file-read* file-write* (subpath ${schemeString(path)}))`),
  ].join('\n');
}

/** Mount a minimal operating-system view. Never expose the host root or host /proc. */
export function buildLocalRunner(input: LocalRunnerInput): { file: string; argv: string[] } {
  const { cfg, cwd, home, tmp, command } = input;
  const shell = ['/bin/bash', '--noprofile', '--norc', '-c', command];
  if (cfg.mode === 'advisory' || !cfg.confined) throw new Error('隔离执行不可用，已拒绝执行');
  if (cfg.mode === 'seatbelt') return { file: '/usr/bin/sandbox-exec', argv: ['-p', seatbeltProfile(cfg), ...shell] };
  const argv = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL'];
  if (process.getuid && process.getgid) argv.push('--uid', String(process.getuid()), '--gid', String(process.getgid()));
  if (cfg.network) argv.push('--share-net');
  for (const path of SYSTEM_READS) if (existsSync(path)) {
    // Preserve merged-/usr aliases, otherwise masking /usr/bin/private could
    // leave a second, unmasked mount at /bin/private.
    argv.push(...(lstatSync(path).isSymbolicLink() ? ['--symlink', readlinkSync(path), path] : ['--ro-bind', path, path]));
  }
  // 不挂宿主或新proc；基础Shell/文本处理无需进程文件系统。
  argv.push('--dir', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const path of ['/etc/ld.so.cache', '/etc/localtime', ...(cfg.network ? ['/etc/resolv.conf', '/etc/ssl/certs'] : [])]) {
    if (existsSync(path)) argv.push('--ro-bind', path, path);
  }
  for (const root of cfg.roots) argv.push(cfg.level === 'readonly' ? '--ro-bind' : '--bind', root, root);
  // Protected data normally lives outside the mounted roots. Also mask it if a
  // deployment keeps its source under /usr or another runtime tree.
  for (const path of cfg.protectedPaths) {
    if (existsSync(path)) {
      const resolved = realpathSync(path);
      if (SYSTEM_READS.some(base => resolved === base || resolved.startsWith(base + '/'))) {
        argv.push(...(statSync(resolved).isDirectory() ? ['--tmpfs', resolved] : ['--ro-bind', '/dev/null', resolved]));
      }
    }
  }
  argv.push('--remount-ro', '/tmp');
  argv.push('--clearenv');
  for (const [key, value] of Object.entries(scrubLocalEnv(home, tmp))) argv.push('--setenv', key, value!);
  argv.push('--remount-ro', '/', '--chdir', cwd, '--', ...shell);
  return { file: '/usr/bin/bwrap', argv };
}
