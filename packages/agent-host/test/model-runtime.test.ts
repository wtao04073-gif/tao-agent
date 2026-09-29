/**
 * M5-5 双档模型装配测试
 *
 * 不真正出网：只验证运行时把旗舰 / 轻量两档注册成不同 provider、按档位取到
 * 正确的模型 id（计量模型名必须跟着档位走，否则按错单价收费），以及轻量档
 * 缺省时回落旗舰。
 */

import { describe, expect, it } from "vitest";
import { createModelRuntime } from "../src/model-runtime.ts";

describe("M5-5 双档模型运行时", () => {
	it("配置两档时 modelForTier 取到各自模型 id 与 provider", () => {
		const rt = createModelRuntime({
			flagship: { baseUrl: "https://flag.example/v1", apiKey: "k1", modelName: "flag-model" },
			lite: { baseUrl: "https://lite.example/v1", apiKey: "k2", modelName: "lite-model" },
		});
		expect(rt.modelForTier("flagship").id).toBe("flag-model");
		expect(rt.modelForTier("lite").id).toBe("lite-model");
		// provider 不同（两档不同 baseUrl/key，必须各用一个 provider）
		expect(rt.modelForTier("flagship").provider).not.toBe(rt.modelForTier("lite").provider);
		// 默认 model 即旗舰
		expect(rt.model.id).toBe("flag-model");
	});

	it("不配轻量档时 lite 回落到旗舰（单模型私有化形态不破）", () => {
		const rt = createModelRuntime({
			baseUrl: "https://only.example/v1",
			apiKey: "k",
			modelName: "only-model",
		});
		expect(rt.modelForTier("flagship").id).toBe("only-model");
		expect(rt.modelForTier("lite").id).toBe("only-model");
	});

	it("两档模型都带内核计费所需的 cost 字段（缺了首请求即崩）", () => {
		const rt = createModelRuntime({
			flagship: { baseUrl: "https://f/v1", apiKey: "k", modelName: "f" },
			lite: { baseUrl: "https://l/v1", apiKey: "k", modelName: "l" },
		});
		for (const tier of ["flagship", "lite"] as const) {
			const cost = (rt.modelForTier(tier) as unknown as { cost: { input: number; output: number } }).cost;
			expect(typeof cost.input).toBe("number");
			expect(typeof cost.output).toBe("number");
		}
	});
});
