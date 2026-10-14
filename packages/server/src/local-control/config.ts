import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { AdminError } from '../admin-settings.ts';
import type { LocalControlConfig, LocalEnvironment } from './types.ts';

const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);

/** Canonicalize the existing prefix without creating directories. */
function canonical(path: string): string {
  try { lstatSync(path); return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink must never be accepted as a future directory.
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('符号链接无效'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonical(parent), path.slice(parent.length));
  }
}

/** cwd must be relative, remain in its root, and contain no symlink components. */
export function safeJoin(root: string, relative: string): string {
  if (!isAbsolute(root) || typeof relative !== 'string' || isAbsolute(relative) || relative.includes('\0') || relative.includes('\\'))
    throw new Error('工作目录必须是授权目录内的相对路径');
  if (relative.split('/').includes('..')) throw new Error('工作目录不能包含上级目录');
  const base = realpathSync(root);
  if (base !== resolve(root)) throw new Error('授权根目录已变化');
  const target = resolve(base, relative || '.');
  if (!inside(base, target)) throw new Error('工作目录超出授权范围');
  let part = base;
  for (const segment of target.slice(base.length).split(sep).filter(Boolean)) {
    part = join(part, segment);
    try { if (lstatSync(part).isSymbolicLink()) throw new Error('工作目录不得经过符号链接'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!inside(base, canonical(target))) throw new Error('工作目录超出授权范围');
  return target;
}

export function localControlConfig(values: Record<string, string | number | boolean | undefined>, env: LocalEnvironment): LocalControlConfig {
  const errors: string[] = [];
  const str = (key: string, fallback = '') => String(values['LOCAL_CONTROL_' + key] ?? fallback);
  const flag = (key: string, fallback = false) => {
    const raw = str(key, String(fallback));
    if (!['true', 'false'].includes(raw)) errors.push(`${key}必须是布尔值`);
    return raw === 'true';
  };
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const n = Number(str(key, String(fallback)));
    if (!Number.isSafeInteger(n) || n < min || n > max) errors.push(`${key}超出范围`);
    return n;
  };
  const choice = <T extends string>(key: string, choices: readonly T[], fallback: T): T => {
    const value = str(key, fallback);
    if (!choices.includes(value as T)) errors.push(`${key}选项无效`);
    return value as T;
  };
  const patterns = (key: string) => {
    const result = str(key).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (result.length > 32) errors.push(`${key}最多32条`);
    for (const pattern of result) {
      // Restrict administrator expressions to a small, linear practical subset.
      if (pattern.length > 256 || /[(){}|]/.test(pattern)) errors.push(`${key}不支持分组、重复计数或分支表达式`);
      try { new RegExp(pattern); } catch { errors.push(`${key}正则无效`); }
    }
    return result;
  };
  const os = env.platform ?? process.platform;
  const home = resolve(env.home ?? homedir());
  const selectedMode = choice('MODE', ['auto', 'seatbelt', 'bwrap', 'advisory'] as const, 'auto');
  const mode = selectedMode === 'auto' ? (os === 'darwin' ? 'seatbelt' : 'bwrap') : selectedMode;
  const cfg: LocalControlConfig = {
    enabled: flag('ENABLED'), singleUser: flag('SINGLE_USER_ACK'),
    level: choice('LEVEL', ['off', 'readonly', 'workspace', 'extended', 'full'] as const, 'off'),
    roots: str('ROOTS', join(home, 'tao-data/local')).split(',').map(x => x.trim()).filter(Boolean).map(x=>x==='~/tao-data/local'?join(home,'tao-data/local'):x),
    mode, confined: false, os, trustedAutoRun: flag('TRUSTED_AUTO_RUN'), network: flag('NETWORK'), allowInstall: flag('ALLOW_INSTALL'),
    allowDelete: flag('ALLOW_DELETE', true), allowWriteOutside: flag('ALLOW_WRITE_OUTSIDE'),
    confirmMode: choice('CONFIRM_MODE', ['always', 'risk', 'session', 'never'] as const, 'always'),
    sessionGrantTtlMin: integer('SESSION_GRANT_TTL_MIN', 30, 5, 480),
    timeoutSec: integer('TIMEOUT_SEC', 60, 1, 1800), maxOutputKb: integer('MAX_OUTPUT_KB', 64, 1, 4096),
    allowPatterns: patterns('ALLOW_PATTERNS'), denyPatterns: patterns('DENY_PATTERNS'),
    protectedPaths: [env.workspace, env.repository, ...['.ssh', '.aws', '.gnupg', '.config', '.kube'].map(p => join(home, p))].map(p => canonical(resolve(p))),
    policyHash: '',
  };
  if (cfg.trustedAutoRun && (!cfg.enabled || !cfg.singleUser)) errors.push('可信模式必须启用本机控制并确认单机单用户');
  if (cfg.enabled) {
    if (!cfg.singleUser) errors.push('启用前必须确认仅单机单用户');
    if (env.accounts.length !== 1 || ![env.accounts[0]?.tenantId, env.accounts[0]?.workspaceId, env.accounts[0]?.userId].every(v => typeof v === 'string' && v.trim())) errors.push('实际有效身份必须且只能有一个');
    else cfg.owner = { ...env.accounts[0]! };
    if ((env.uid ?? process.getuid?.() ?? 0) === 0) errors.push('禁止以root身份执行本机命令');
    if (cfg.level === 'off') errors.push('启用时必须选择有效权限档位');
    if (cfg.trustedAutoRun && (cfg.level === 'readonly' || !flag('TRUSTED_AUTO_RUN_ACK'))) errors.push('可信模式仅L2以上允许，且必须勾选可信执行风险确认');
    const extended = cfg.level === 'extended' || cfg.level === 'full';
    if (extended && !flag('DANGER_ACK')) errors.push('L3/L4需要高危能力风险确认');
    if (cfg.level === 'full' && str('FULL_DISCLAIMER') !== '我已知晓风险') errors.push('L4免责声明不匹配');
    if ((cfg.network || cfg.allowInstall) && !extended) errors.push('联网与安装仅L3/L4允许');
    if (cfg.allowWriteOutside && cfg.level !== 'full') errors.push('扩展写权限仅L4允许');
    if (cfg.confirmMode === 'never' && cfg.level !== 'full') errors.push('免确认仅L4允许');
    if (cfg.confirmMode === 'session' && cfg.level === 'readonly') errors.push('会话放行仅L2以上允许');
    if (mode === 'advisory') errors.push('弱隔离执行当前不受支持');
    const binary = mode === 'seatbelt' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap';
    if ((mode === 'seatbelt' && os !== 'darwin') || (mode === 'bwrap' && os !== 'linux')) errors.push('隔离模式与操作系统不匹配');
    if (!(env.exists ?? existsSync)(binary)) errors.push('所选隔离程序不可用');
    if (!cfg.roots.length) errors.push('至少配置一个授权目录');
    if (cfg.roots.length > 1 && !extended) errors.push('多个授权目录仅L3/L4允许');
    const system = ['/bin', '/sbin', '/usr', '/etc', '/dev', '/proc', '/sys', '/boot', '/System', '/Library', '/Applications', '/private/etc', '/private/var', '/var'];
    cfg.roots = cfg.roots.map((root, i) => {
      try {
        if (!isAbsolute(root) || root.includes('\0')) throw new Error('必须是绝对路径');
        const normalized = realpathSync(root);
        if (!statSync(normalized).isDirectory()) throw new Error('必须是已存在目录');
        if (normalized === '/' || inside(normalized, home) || /^\/(?:Users|home)\/[^/]+$/.test(normalized) || ['/Users', '/home', '/root', '/tmp', '/private/tmp', '/mnt', '/media', '/opt', '/run'].includes(normalized)) throw new Error('不得授权系统或整个家目录');
        if (system.some(p => overlaps(normalized, canonical(p)))) throw new Error('不得授权系统目录');
        if (cfg.protectedPaths.some(p => overlaps(normalized, p))) throw new Error('不得授权源码、产品数据或凭据目录');
        return normalized;
      } catch { errors.push(`授权目录${i + 1}无效或包含受保护路径`); return root; }
    });
    if (cfg.roots.some((a, i) => cfg.roots.slice(i + 1).some(b => overlaps(a, b)))) errors.push('授权目录不能重复或互相包含');
    cfg.confined = errors.length === 0;
  }
  if (errors.length) throw new AdminError(400, errors.join('；'));
  cfg.policyHash = createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
  return cfg;
}
