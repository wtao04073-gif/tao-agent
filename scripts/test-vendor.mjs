/**
 * vendor/pi 测试脚本
 *
 * 跑上游自带的测试套件。这是 vendor 相比纯 npm 依赖多出来的安全网 ——
 * 改了内核之后靠它验证没改坏。
 *
 * 为什么需要这个脚本而不直接 `npx vitest`：
 *   ai 包有一批 E2E 测试会真实调用模型厂商 API，它们靠「环境里有没有对应
 *   API Key」决定是否跳过。若环境中恰好存在这些变量但出网被拦，就会产生
 *   一批与代码无关的失败（实测 25 个），极易被误判为 vendor 有问题。
 *   这里显式清空 provider 凭证变量，让门控正确跳过，只跑离线可判定的部分。
 *
 * 运行：node scripts/test-vendor.mjs [包名...]
 */

import { execFileSync, execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALL = ["telemetry", "chord", "ai", "agent"];

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

// cgroup 配额决定并发上限；vitest 默认按宿主核数拉 worker，容器里会超配
function cpuQuota() {
  try {
    const v = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (v[0] !== "max") return Math.max(1, Math.floor(Number(v[0]) / Number(v[1])));
  } catch {
    /* 非 cgroup v2，忽略 */
  }
  return 2;
}
const MAX_WORKERS = Math.max(1, Math.min(4, cpuQuota() - 2));

/**
 * 收集所有 provider 凭证类变量名，置空后传给子进程。
 * 只用到变量「名」，不读取也不输出任何值。
 */
function credentialVarNames(pkgDir) {
  const pattern = String.raw`\b[A-Z][A-Z0-9_]*(API_KEY|AUTH_TOKEN|OAUTH_TOKEN|_TOKEN)\b`;
  const names = new Set();
  for (const sub of ["test", "src"]) {
    const dir = join(pkgDir, sub);
    if (!existsSync(dir)) continue;
    try {
      const out = execSync(`grep -rhoE '${pattern}' ${JSON.stringify(dir)} || true`, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      for (const n of out.split("\n")) if (n.trim()) names.add(n.trim());
    } catch {
      /* grep 无匹配，忽略 */
    }
  }
  // AWS_* 用于 Bedrock，同样会触发 E2E
  return [...names].filter((n) => !/^CHARS_PER_TOKEN$/.test(n));
}

console.log(`\n  vendor/pi 测试（并发上限 ${MAX_WORKERS}）\n  ${"─".repeat(52)}`);

const summary = [];
let anyFailed = false;

for (const pkg of targets) {
  const cwd = join(ROOT, "vendor", "pi", pkg);
  if (!existsSync(join(cwd, "test"))) {
    console.log(`\n  ▸ ${pkg} —— 无 test 目录，跳过`);
    continue;
  }
  console.log(`\n  ▸ ${pkg}`);

  const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" };
  for (const name of credentialVarNames(cwd)) env[name] = "";

  try {
    const out = execFileSync(
      join(ROOT, "node_modules", ".bin", "vitest"),
      ["--run", `--maxWorkers=${MAX_WORKERS}`],
      { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
    const line = out.split("\n").find((l) => l.includes("Tests ")) ?? "";
    console.log(`    ${line.trim()}`);
    summary.push({ pkg, ok: true, line: line.trim() });
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const line = out.split("\n").find((l) => l.includes("Tests ")) ?? "(无法解析结果)";
    console.log(`    ✗ ${line.trim()}`);
    console.log(out.split("\n").filter((l) => l.includes("FAIL")).slice(0, 10).join("\n"));
    summary.push({ pkg, ok: false, line: line.trim() });
    anyFailed = true;
  }
}

console.log(`\n  ${"─".repeat(52)}`);
for (const s of summary) console.log(`  ${s.ok ? "✓" : "✗"} ${s.pkg.padEnd(10)} ${s.line}`);
console.log("");
process.exit(anyFailed ? 1 : 0);
