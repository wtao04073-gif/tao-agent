import { defineConfig } from "vitest/config";

// [TAO-PATCH] 上游此包无 vitest 配置，靠默认行为发现 test/。
// 但本仓库根目录有 vitest.config.ts（自有包与 e2e 用），vitest 会向上查找
// 并继承它，导致本包去找 packages/*/test/ 而报「No test files found」。
// 补一份最小配置以隔离根配置，不改变上游的测试行为。
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
});
