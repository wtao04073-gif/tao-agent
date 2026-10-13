import { basename, isAbsolute, normalize, sep } from 'node:path';
import { HIGH_RISK_CAPABILITIES, localCapabilities } from './policy.ts';
import type { CommandRisk, LocalCapability, LocalControlConfig } from './types.ts';

const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
const hardCommands = new Set(['sudo', 'su', 'doas', 'eval', 'source', 'exec', 'mkfs', 'fdisk', 'diskutil', 'dd', 'mount', 'umount', 'chroot', 'nsenter', 'unshare', 'killall', 'pkill', 'reboot', 'shutdown', 'launchctl']);
const networkCommands = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'ftp', 'ping', 'telnet', 'rsync']);
const installers = new Set(['npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'uv', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'apk', 'gem', 'cargo', 'go']);

/** A deliberately small lexer, never a claim to parse or prove arbitrary shell scripts. */
function words(command: string): string[] | null {
  const result: string[] = [];
  let current = '', quote = '', started = false;
  for (const ch of command) {
    if (ch === '\\' || ch === '`' || ch === '$' || ch === '\0') return null;
    if (quote) {
      if (ch === quote) quote = ''; else current += ch;
      started = true;
    } else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) result.push(current); current = ''; started = false; }
    else if (/[;&|<>(){}]/.test(ch)) { if (started) result.push(current); result.push(ch); current = ''; started = false; }
    else { current += ch; started = true; }
  }
  if (quote) return null;
  if (started) result.push(current);
  return result;
}

/** Only literal argv with a narrow set of non-executing options qualifies as read-only. */
function readOnly(argv: string[]): boolean {
  const [name, ...args] = argv;
  if (!name) return false;
  if (name === 'pwd') return args.every(a => a === '-P' || a === '-L');
  const flags: Record<string, RegExp> = {
    ls: /^-(?:[alhtrSd1]+|-[a-z]+)$/, cat: /^-[nbsETvA]+$/,
    head: /^-[0-9]+$/, tail: /^-[0-9]+$/, wc: /^-[clwmL]+$/,
    stat: /^-[Lt]+$/, file: /^-[bikL]+$/,
  };
  if (name === 'find') {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (['-maxdepth', '-mindepth'].includes(arg)) { if (!/^\d{1,3}$/.test(args[++i] ?? '')) return false; }
      else if (arg === '-type') { if (!/^[fdl]$/.test(args[++i] ?? '')) return false; }
      else if (arg === '-name' || arg === '-iname') { if (!args[++i]) return false; }
      else if (arg === '-print' || arg === '-print0') continue;
      else if (arg.startsWith('-')) return false;
    }
    return true;
  }
  const flagPattern = flags[name];
  if (!flagPattern) return false;
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { ended = true; continue; }
    if (!ended && ['head', 'tail'].includes(name) && ['-n', '-c'].includes(arg)) {
      if (!/^\d{1,8}$/.test(args[++i] ?? '')) return false;
    } else if (!ended && arg.startsWith('-') && !flagPattern.test(arg)) return false;
    // ls long options can alter behavior; admit an explicit inert subset only.
    if (!ended && name === 'ls' && arg.startsWith('--') && !['--all', '--almost-all', '--directory', '--human-readable', '--reverse', '--size'].includes(arg)) return false;
  }
  return true;
}

export function classifyCommand(command: string, cfg: LocalControlConfig): CommandRisk {
  const capabilities = new Set<LocalCapability>(['read']);
  const blocked = (reason: string): CommandRisk => ({ kind: 'block', reason, capabilities: [...capabilities], highRisk: true });
  if (!cfg.enabled || !cfg.singleUser || !cfg.confined || cfg.mode === 'advisory') return blocked('本机命令能力未开放或隔离不可用');
  if (typeof command !== 'string' || !command.trim() || command.length > 16384 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) return blocked('命令为空、过长或包含控制字符');
  for (const pattern of cfg.denyPatterns) {
    try { if (new RegExp(pattern).test(command)) return blocked('命中管理员禁止规则'); }
    catch { return blocked('管理员规则无效'); }
  }
  // Dynamic shell syntax can hide both paths and executable names. Refuse it,
  // rather than presenting a misleading category/confirmation to the user.
  const argv = words(command);
  if (!argv?.length) return blocked('动态展开、转义或未闭合引号不受支持，请使用本地脚本文件');
  if (argv.some(w => hardCommands.has(basename(w)) || /^mkfs\./.test(basename(w)))) return blocked('命中不可覆盖的高危命令限制');
  if (argv.some(w => /(?:^|\/)\.\.(?:\/|$)/.test(w) || w.startsWith('~'))) return blocked('不得使用上级路径或宿主家目录');
  if (argv.some(w => /^(?:accounts\.json|master\.key|\.admin-config)$/.test(basename(w)))) return blocked('不得访问产品凭据文件');
  const paths = argv.flatMap(w => [w, ...(w.includes('=') ? [w.slice(w.indexOf('=') + 1)] : [])]);
  for (const path of paths) {
    if (!isAbsolute(path)) continue;
    const normalized = normalize(path);
    if (cfg.protectedPaths.some(p => within(p, normalized) || within(normalized, p))) return blocked('不得访问产品数据、源码或凭据目录');
    if (!cfg.roots.some(root => within(root, normalized))) return blocked('命令路径超出授权目录集合');
  }
  if (argv.includes('|') && argv.some(w => ['sh', 'bash', 'zsh'].includes(basename(w)))) return blocked('禁止管道执行Shell');
  if (argv.some(w => ['sh', 'bash', 'zsh', 'python', 'python3', 'node', 'perl', 'ruby'].includes(basename(w))) && argv.some(w => /^-(?:[a-z]*c|e)$/.test(w) || w === '--eval')) return blocked('内联解释器代码不能可靠分级，请使用授权目录内脚本文件');
  const simple = !/[;&|<>\n(){}*?\[\]#]/.test(command);
  const literalRead = simple && readOnly(argv);
  if (!literalRead) {
    capabilities.add('write_in_root');
    const name = argv[0]!;
    if (!simple || !['cp', 'mkdir', 'touch', 'mv', 'rm', 'rmdir'].includes(name)) {
      // Interpreters and arbitrary programs may write and delete, regardless of
      // what their source text appears to say. OS isolation remains mandatory.
      capabilities.add('execute_local'); capabilities.add('delete');
      // If the sandbox exposes high-risk powers, arbitrary programs inherit
      // them too and must not obtain low-risk session or never-mode approval.
      if (cfg.network) capabilities.add('network');
      if (cfg.allowInstall) capabilities.add('install_pkg');
    }
    if (['rm', 'rmdir', 'mv'].includes(name)) capabilities.add('delete');
    if (name === 'cp' && argv.includes('--remove-destination')) capabilities.add('delete');
  }
  if (argv.some(w => networkCommands.has(basename(w))) || argv.includes('git') && argv.some(w => ['clone', 'fetch', 'pull', 'push', 'ls-remote'].includes(w))) capabilities.add('network');
  if (argv.some(w => installers.has(basename(w)))) {
    capabilities.add('install_pkg');
    // Package managers may resolve or fetch even when a package looks local.
    capabilities.add('network');
  }
  if (argv.some(w => ['chmod', 'chown', 'kill'].includes(basename(w)))) capabilities.add('system_maintenance');
  const allowed = localCapabilities(cfg);
  for (const capability of capabilities) if (!allowed[capability]) return blocked(`管理员未开放能力：${capability}`);
  const highRisk = [...capabilities].some(c => HIGH_RISK_CAPABILITIES.includes(c));
  // Patterns never remove categories, mandatory confirmations or hard floors.
  // They only document administrator intent; read-only risk mode is already automatic.
  const explicitlyAllowed=literalRead&&cfg.allowPatterns.some(pattern=>{try{return new RegExp(pattern).test(command);}catch{return false;}});
  const automatic = !highRisk && (cfg.confirmMode === 'never' || cfg.confirmMode === 'risk' && literalRead || explicitlyAllowed);
  return { kind: automatic ? 'allow' : 'confirm', reason: highRisk ? '高危能力需要逐次确认' : literalRead ? '只读命令' : '命令可能修改授权目录，需要确认', capabilities: [...capabilities], highRisk };
}
