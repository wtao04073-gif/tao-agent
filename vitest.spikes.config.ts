import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 复用 vendor 各包的 alias，使 spike 直接跑 src 源码而非 dist，
// 与上游自身测试的解析方式保持一致（见 vendor/pi/agent/vitest.config.ts）。
const v = (p: string) => fileURLToPath(new URL(`./vendor/pi/${p}`, import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		include: ["spikes/**/*.spike.ts"],
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
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
