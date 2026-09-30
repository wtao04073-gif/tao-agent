/**
 * vendor/pi 构建脚本
 *
 * 按依赖顺序编译四个 vendor 包。存在的意义有两点：
 *  1. 上游 `ai` 包的 build 会联网拉取模型清单（generate-models），私有化交付不能依赖外网，
 *     这里只跑 build:offline 那一段，数据用已纳入源码树的快照。
 *  2. tsgo 不搬运 JSON，编译后需手工把 providers/data 拷入 dist。
 *
 * 运行：node scripts/build-vendor.mjs
 */

import { execFileSync } from "node:child_process";
import { cpSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 依赖顺序：telemetry 与 chord 无内部依赖，ai 依赖 telemetry，agent 依赖三者
const PACKAGES = ["telemetry", "chord", "ai", "agent"];

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

const tsgo = join(ROOT, "node_modules", ".bin", "tsgo");

/**
 * 校验模型清单完整性。
 *
 * 上游用 `npm run check:model-data` 做这件事，但那个脚本在 ai/scripts/ 下、未纳入 vendor。
 * 这里按 .manifest.json 记录的 sha256 逐个对账，作用等价：
 * 证明从发布包提取的数据既完整也未被篡改。
 */
function checkModelData(dataDir) {
  const manifestPath = join(dataDir, ".manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`缺少 .manifest.json —— 这是隐藏文件，极易在拷贝时漏掉`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expected = manifest.files ?? {};
  const actual = readdirSync(dataDir).filter((f) => f !== ".manifest.json");

  const missing = Object.keys(expected).filter((f) => !actual.includes(f));
  const extra = actual.filter((f) => !(f in expected));
  const corrupt = [];

  for (const file of actual) {
    if (!(file in expected)) continue;
    const hash = createHash("sha256").update(readFileSync(join(dataDir, file))).digest("hex");
    if (hash !== expected[file]) corrupt.push(file);
  }

  if (missing.length || extra.length || corrupt.length) {
    const lines = [];
    if (missing.length) lines.push(`    缺失 ${missing.length} 个: ${missing.join(", ")}`);
    if (extra.length) lines.push(`    多出 ${extra.length} 个: ${extra.join(", ")}`);
    if (corrupt.length) lines.push(`    哈希不符 ${corrupt.length} 个: ${corrupt.join(", ")}`);
    throw new Error(`模型清单校验失败\n${lines.join("\n")}`);
  }

  return { count: actual.length, generatedAt: manifest.generatedAt };
}

console.log("\n  构建 vendor/pi\n  " + "─".repeat(52));

for (const pkg of PACKAGES) {
  const cwd = join(ROOT, "vendor", "pi", pkg);
  console.log(`\n  ▸ ${pkg}`);

  // ai 包先校验数据再编译（对应上游 build:offline 里 check:model-data 在 tsgo 之前）
  if (pkg === "ai") {
    const src = join(cwd, "src", "providers", "data");
    if (!existsSync(src)) {
      console.error(
        `\n  ✗ 缺少模型清单 ${src}\n` +
          `    该目录被上游 .gitignore 排除，需从发布包 @earendil-works/pi-ai 的 dist/providers/data 提取。\n` +
          `    详见 vendor/pi/README.md「vendor 时必须一并纳入的三项」\n`,
      );
      process.exit(1);
    }
    try {
      const { count, generatedAt } = checkModelData(src);
      console.log(`    模型清单校验通过（${count} 个提供方，生成于 ${generatedAt}）`);
    } catch (e) {
      console.error(`\n  ✗ ${e.message}\n`);
      process.exit(1);
    }
  }

  rmSync(join(cwd, "dist"), { recursive: true, force: true });
  run(tsgo, ["-p", "tsconfig.build.json"], cwd);

  // tsgo 不搬运 JSON，需手工拷贝（对应上游 build:offline 的后半段）
  if (pkg === "ai") {
    const src = join(cwd, "src", "providers", "data");
    const dest = join(cwd, "dist", "providers", "data");
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    console.log(`    模型清单已拷入 dist`);
  }
}

console.log("\n  " + "─".repeat(52));
console.log("  构建完成。运行 node scripts/verify-vendor.mjs 验证\n");

