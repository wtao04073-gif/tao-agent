import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 自有包的测试。与 vendor 测试分开跑 —— vendor 的测试属于上游，
// 我们的断言属于自己，混在一起会让「谁坏了」变得不清楚。
const v = (p: string) => fileURLToPath(new URL(`./vendor/pi/${p}`, import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		include: ["packages/*/test/**/*.test.ts"],
		testTimeout: 30000,
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: v("telemetry/src/index.ts") },
			{ find: /^@earendil-works\/chord$/, replacement: v("chord/src/index.ts") },
			{ find: /^@earendil-works\/chord\/context$/, replacement: v("chord/src/context/index.ts") },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: v("agent/src/index.ts") },
			{ find: /^@earendil-works\/pi-ai$/, replacement: v("ai/src/index.ts") },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: v("ai/src/compat.ts") },
			{ find: /^@tao\/orchestrator$/, replacement: fileURLToPath(new URL("./packages/orchestrator/src/index.ts", import.meta.url)) },
			{ find: /^@tao\/office$/, replacement: fileURLToPath(new URL("./packages/office/src/index.ts", import.meta.url)) },
			{ find: /^@tao\/core$/, replacement: fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
