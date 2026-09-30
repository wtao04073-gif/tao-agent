/**
 * 架构边界检查
 *
 * 技术方案定的纪律：**业务代码不直接 import vendor，一律经由 RunnerAdapter 适配层**。
 * 这条纪律决定了「将来能否换掉内核而不动业务代码」，但靠人自觉必然失守 ——
 * 一次赶工时的 import 就会把内核类型泄漏到平台层。所以做成可执行检查。
 *
 * 规则：
 *   1. @tao/core 不得引用任何 vendor 包（它是全平台共享词汇表，污染面最大）
 *   2. 除 agent-host 外的业务包不得引用 vendor（agent-host 是唯一的适配层）
 *
 * 运行：node scripts/check-boundaries.mjs
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(ROOT, "packages");

/** 唯一允许接触 vendor 的包 —— 适配层本身。 */
const ADAPTER_PACKAGES = new Set(["agent-host"]);

const VENDOR_SPECIFIER = /@earendil-works\/|vendor\/pi\//;

function tsFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : tsFiles(full);
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

/** 提取 import / export-from 的模块说明符，避免把注释里的字符串误判为引用。 */
function importSpecifiers(source) {
	const specifiers = [];
	// 去掉注释后再匹配，否则本文件这类「在注释里写包名」的情况会误报
	const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
	const pattern = /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of withoutComments.matchAll(pattern)) {
		specifiers.push(match[1] ?? match[2]);
	}
	return specifiers.filter(Boolean);
}

const violations = [];
const checked = { packages: 0, files: 0 };

const packageDirs = existsSync(PACKAGES)
	? readdirSync(PACKAGES, { withFileTypes: true }).filter((e) => e.isDirectory())
	: [];

for (const entry of packageDirs) {
	const pkg = entry.name;
	if (ADAPTER_PACKAGES.has(pkg)) continue;
	checked.packages++;

	for (const file of tsFiles(join(PACKAGES, pkg))) {
		checked.files++;
		for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
			if (VENDOR_SPECIFIER.test(specifier)) {
				violations.push({ file: relative(ROOT, file), specifier, pkg });
			}
		}
	}
}

console.log(`\n  架构边界检查\n  ${"─".repeat(52)}`);
console.log(`  已检查 ${checked.packages} 个业务包、${checked.files} 个文件`);
console.log(`  豁免（适配层）：${[...ADAPTER_PACKAGES].join(", ") || "无"}`);

if (violations.length === 0) {
	console.log(`\n  ✓ 无越界引用 —— 业务代码与内核保持解耦\n`);
	process.exit(0);
}

console.log(`\n  ✗ 发现 ${violations.length} 处越界引用：\n`);
for (const v of violations) {
	console.log(`    ${v.file}`);
	console.log(`      → ${v.specifier}`);
}
console.log(`
  业务代码必须经由 @tao/core 的 RunnerAdapter 接口使用内核能力。
  若确需新增适配层包，把包名加入本脚本的 ADAPTER_PACKAGES。
`);
process.exit(1);
