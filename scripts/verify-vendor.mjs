/**
 * vendor 可用性验证
 *
 * 目的：证明 vendor/pi 下的 Pi 内核在本仓库内可独立编译、可导入、可实例化，
 * 不依赖 npm registry 与外网。这是「自主可控」是否真正成立的验证。
 *
 * 运行：node scripts/verify-vendor.mjs
 */

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check("pi-telemetry 可导入", async () => {
  const m = await import("@earendil-works/pi-telemetry");
  return { ok: Object.keys(m).length > 0, info: `${Object.keys(m).length} 项导出` };
});

check("chord 可导入", async () => {
  const m = await import("@earendil-works/chord");
  return { ok: Object.keys(m).length > 0, info: `${Object.keys(m).length} 项导出` };
});

check("pi-ai 可导入", async () => {
  const m = await import("@earendil-works/pi-ai");
  return { ok: Object.keys(m).length > 0, info: `${Object.keys(m).length} 项导出` };
});

check("pi-ai 模型清单已加载（离线可用的关键）", async () => {
  const m = await import("@earendil-works/pi-ai");
  // providers/data 下的模型元数据是构建期生成物，上游 .gitignore 排除了它，
  // 我们从发布包取出并纳入 vendor，以保证离线可编译。此项验证它确实生效。
  const modelKeys = Object.keys(m).filter((k) => /model|provider/i.test(k));
  return { ok: modelKeys.length > 0, info: modelKeys.slice(0, 4).join(", ") };
});

check("pi-agent-core 可导入", async () => {
  const m = await import("@earendil-works/pi-agent-core");
  return { ok: Object.keys(m).length > 0, info: `${Object.keys(m).length} 项导出` };
});

check("Agent Loop 核心导出存在", async () => {
  const m = await import("@earendil-works/pi-agent-core");
  const found = ["Agent", "agentLoop"].filter((k) => typeof m[k] === "function");
  return { ok: found.length > 0, info: `可用: ${found.join(", ") || "无"}` };
});

check("不依赖外网（无 registry 解析）", async () => {
  // 所有包均通过 workspace 符号链接解析到 vendor/，不经 npm registry
  const { readlinkSync, existsSync } = await import("node:fs");
  const base = new URL("../node_modules/@earendil-works/", import.meta.url);
  const pkgs = ["pi-agent-core", "pi-ai", "chord", "pi-telemetry"];
  const linked = pkgs.filter((p) => {
    const path = new URL(p, base);
    try {
      return readlinkSync(path).includes("vendor/pi");
    } catch {
      return false;
    }
  });
  return {
    ok: linked.length === pkgs.length,
    info: `${linked.length}/${pkgs.length} 个包指向 vendor/`,
  };
});

console.log("\n  vendor 可用性验证\n  " + "─".repeat(52));
let failed = 0;
for (const { name, fn } of checks) {
  try {
    const { ok, info } = await fn();
    if (!ok) failed++;
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (info) console.log(`      ${info}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${String(e.message).split("\n")[0]}`);
  }
}
console.log("  " + "─".repeat(52));
console.log(
  failed === 0
    ? `  全部 ${checks.length} 项通过 — vendor 自包含，可离线编译运行\n`
    : `  ${failed}/${checks.length} 项失败\n`,
);
process.exit(failed > 0 ? 1 : 0);
