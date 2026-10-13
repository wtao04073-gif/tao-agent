import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildLocalRunner, scrubLocalEnv } from '../packages/server/src/local-control/profile.ts';
import { preflightLocalControl, runLocalProcess } from '../packages/server/src/local-control/tool.ts';
import type { LocalControlConfig } from '../packages/server/src/local-control/types.ts';

assert.equal(process.platform, 'darwin', '真实 Seatbelt 回归必须运行在 macOS');
assert.notEqual(process.getuid?.(), 0, '回归不得以 root 执行');
const version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
if (process.argv[2]) assert.equal(version.split('.')[0], process.argv[2], '系统版本必须匹配回归目标');
const base = realpathSync(mkdtempSync(join(homedir(), 'tao-seatbelt-test-')));
const root = join(base, 'authorized space "quoted"');
const protectedRoot = join(base, 'protected');
const outside = join(base, 'outside');
const server = createServer(socket => socket.destroy());
for (const path of [root, protectedRoot, outside, ...['home', 'tmp', 'out', 'work'].map(name => join(root, name))]) mkdirSync(path, { mode: 0o700 });
writeFileSync(join(outside, 'plain.txt'), 'ordinary');
writeFileSync(join(protectedRoot, 'private.txt'), 'protected fixture');
writeFileSync(join(root, 'work', 'source.txt'), 'hello');
symlinkSync(join(protectedRoot, 'private.txt'), join(root, 'work', 'protected-link'));
symlinkSync(outside, join(root, 'work', 'outside-link'));
const cfg: LocalControlConfig = {
  enabled: true, singleUser: true, level: 'workspace', roots: [root], mode: 'seatbelt', confined: true,
  os: 'darwin', network: false, allowInstall: false, allowDelete: true, allowWriteOutside: false,
  confirmMode: 'always', sessionGrantTtlMin: 30, timeoutSec: 15, maxOutputKb: 64,
  allowPatterns: [], denyPatterns: [], protectedPaths: [protectedRoot], policyHash: 'regression',
  owner: { tenantId: 'test', workspaceId: 'test', userId: 'test' },
};
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
let passed = 0;
async function run(name: string, command: string, config = cfg) {
  const paths = { cwd: join(root, 'work'), home: join(root, 'home'), tmp: join(root, 'tmp') };
  const result = await runLocalProcess(buildLocalRunner({ cfg: config, ...paths, command }), {
    cwd: paths.cwd, env: scrubLocalEnv(paths.home, paths.tmp), timeoutMs: 15000, maxBytes: 4096,
    signal: new AbortController().signal, report: () => {},
  });
  assert.equal(result.timedOut, false, name);
  assert.equal(result.code, 0, `${name}: ${result.text}`);
  passed++;
  console.log(`通过：${name}`);
}
try {
  console.log(`真实回归：macOS ${version} ${process.arch}`);
  for (const config of [cfg, { ...cfg, level: 'readonly' as const }, { ...cfg, level: 'extended' as const, network: true }]) {
    const result = await preflightLocalControl(config);
    assert.equal(result.ok, true, `${config.level} 预检：${result.message}`);
    assert.equal(result.confined, true);
    assert(result.checks.includes('受保护路径不可读写'));
    assert(result.checks.includes('授权范围外不可写；普通文件读取开放'));
    passed++;
    console.log(`通过：真实 preflightLocalControl ${config.level}`);
  }
  await run('bash 初始化', 'echo OK');
  await run('ls 和 cat', 'ls -la . && test "$(cat source.txt)" = hello');
  await run('mkdir 和 cp', 'mkdir copied && cp source.txt copied/result.txt && cmp source.txt copied/result.txt');
  await run('管道及重定向', 'cat source.txt | tr a-z A-Z > pipeline.txt && test "$(cat pipeline.txt)" = HELLO');
  await run('zip', 'zip -q archive.zip source.txt && unzip -p archive.zip source.txt | cmp - source.txt');
  writeFileSync(join(root, 'work', 'check.py'), 'import os, tempfile\nfrom pathlib import Path\np = Path(tempfile.gettempdir())\nassert p == Path(os.environ["TMPDIR"])\nwith tempfile.NamedTemporaryFile() as f:\n    assert Path(f.name).parent == p\nPath("python.txt").write_text("python-ok")\n');
  await run('python3 与 TMPDIR', 'python3 check.py');
  assert.equal(readFileSync(join(root, 'work', 'python.txt'), 'utf8'), 'python-ok');
  await run('设备重定向', 'echo ignored >/dev/null; echo stderr-ok >/dev/stderr');
  await run('根外普通文件可读', `test "$(cat ${quote(join(outside, 'plain.txt'))})" = ordinary`);
  await run('根外写入拒绝', `if (echo escape > ${quote(join(outside, 'escape'))}) 2>/dev/null; then exit 1; fi`);
  await run('受保护文件不可读写', `if cat ${quote(join(protectedRoot, 'private.txt'))} >/dev/null 2>&1; then exit 1; fi\nif (echo escape > ${quote(join(protectedRoot, 'private.txt'))}) 2>/dev/null; then exit 2; fi`);
  await run('符号链接不可越过边界', 'if cat protected-link >/dev/null 2>&1; then exit 1; fi\nif (echo escape > outside-link/escape) 2>/dev/null; then exit 2; fi');
  await run('只读根禁止写入', 'cat source.txt >/dev/null\nif (echo denied > readonly.txt) 2>/dev/null; then exit 1; fi', { ...cfg, level: 'readonly' });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await run('禁网', `if ( : > /dev/tcp/127.0.0.1/${address.port} ) 2>/dev/null; then exit 1; fi`);
  await run('显式启用网络', `: > /dev/tcp/127.0.0.1/${address.port}`, { ...cfg, level: 'extended', network: true });
  console.log(`全部通过：${passed} 项`);
} finally {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
}
