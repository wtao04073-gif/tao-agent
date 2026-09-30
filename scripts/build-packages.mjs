/**
 * 自有包构建
 *
 * 按依赖顺序编译 packages/ 下的包。与 build-vendor.mjs 分开 ——
 * vendor 是第三方代码、季度才动一次；自有包每天都在改。
 *
 * 运行：node scripts/build-packages.mjs [包名...]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(ROOT, "packages");

// 依赖顺序：core 无依赖，其余依赖 core
const ORDER = ["core", "office", "knowledge", "agent-host", "orchestrator", "server"];

const available = existsSync(PACKAGES)
	? readdirSync(PACKAGES, { withFileTypes: true })
			.filter((e) => e.isDirectory() && existsSync(join(PACKAGES, e.name, "tsconfig.build.json")))
			.map((e) => e.name)
	: [];

const requested = process.argv.slice(2);
// 按 ORDER 排序；不在 ORDER 里的包排在最后（新增包忘记登记也不会静默跳过）
const targets = (requested.length ? requested : available).sort((a, b) => {
	const ia = ORDER.indexOf(a);
	const ib = ORDER.indexOf(b);
	return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib);
});

const tsgo = join(ROOT, "node_modules", ".bin", "tsgo");

console.log(`\n  构建自有包\n  ${"─".repeat(52)}`);

for (const pkg of targets) {
	const cwd = join(PACKAGES, pkg);
	if (!existsSync(join(cwd, "tsconfig.build.json"))) {
		console.log(`  ⊘ ${pkg} —— 无 tsconfig.build.json，跳过`);
		continue;
	}
	if (!ORDER.includes(pkg)) {
		console.log(`  ⚠ ${pkg} 未登记在构建顺序里，已排到末尾 —— 若它被其他包依赖，请更新 scripts/build-packages.mjs`);
	}
	console.log(`\n  ▸ ${pkg}`);
	rmSync(join(cwd, "dist"), { recursive: true, force: true });
	execFileSync(tsgo, ["-p", "tsconfig.build.json"], { cwd, stdio: "inherit" });
}

console.log(`\n  ${"─".repeat(52)}`);
console.log(`  构建完成（${targets.length} 个包）\n`);
