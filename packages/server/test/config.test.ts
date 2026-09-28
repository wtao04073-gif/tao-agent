/**
 * 配置读取测试
 *
 * 断言重点有两条，都来自 M4 的验收门禁（客户 IT 2 小时内独立装成）：
 *
 *  1. **错误一次报全，且建议可操作。** 只说「配置错误」会让客户 IT 打电话。
 *  2. **「配了却不生效」的组合必须被拦成启动错误。** 这类缺陷比漏配更贵 ——
 *     漏配会立刻失败，而「配了不生效」在账面上完全正常，超卖到什么程度都看不出来。
 */

import { describe, expect, it } from "vitest";
import { describeConfig, loadConfig, renderConfigErrors } from "../src/index.ts";

/** 能让 loadConfig 无错通过的最小一组环境变量。 */
const BASE = {
	MODEL_BASE_URL: "https://api.deepseek.com",
	MODEL_API_KEY: "local",
	MODEL_NAME: "deepseek-chat",
} as const;

function load(extra: Record<string, string | undefined> = {}) {
	return loadConfig({ ...BASE, ...extra });
}

/** 取某个 key 上的错误。key 可能是「A / B」这种合并形式，用 includes 匹配。 */
function errorFor(errors: readonly { key: string; reason: string; advice: string }[], key: string) {
	return errors.find((e) => e.key.includes(key));
}

describe("模型单价解析", () => {
	it("留空时为 undefined —— 与填 0 的「不计费」语义不同", () => {
		const { config, errors } = load();
		expect(errors).toEqual([]);
		expect(config.modelInputPriceYuan).toBeUndefined();
		expect(config.modelOutputPriceYuan).toBeUndefined();
		expect(config.modelCacheReadPriceYuan).toBeUndefined();
	});

	it("整数单价按原值解析", () => {
		const { config, errors } = load({ MODEL_INPUT_PRICE: "2", MODEL_OUTPUT_PRICE: "8" });
		expect(errors).toEqual([]);
		expect(config.modelInputPriceYuan).toBe(2);
		expect(config.modelOutputPriceYuan).toBe(8);
	});

	it("小数单价不被取整 —— 国产模型低到 0.5 元/百万 token", () => {
		// 取整会把 0.5 抹成 0（等于免费）或 1（虚高一倍），
		// 两种都会让账目系统性偏差
		const { config, errors } = load({
			MODEL_INPUT_PRICE: "0.5",
			MODEL_OUTPUT_PRICE: "1.5",
			MODEL_CACHE_READ_PRICE: "0.1",
		});
		expect(errors).toEqual([]);
		expect(config.modelInputPriceYuan).toBe(0.5);
		expect(config.modelOutputPriceYuan).toBe(1.5);
		expect(config.modelCacheReadPriceYuan).toBe(0.1);
	});

	it("填 0 是合法的，表示这一项不计费", () => {
		// 自建推理服务的成本已在别处计，输出不单独计费是真实场景
		const { config, errors } = load({ MODEL_INPUT_PRICE: "0", MODEL_OUTPUT_PRICE: "0" });
		expect(errors).toEqual([]);
		expect(config.modelInputPriceYuan).toBe(0);
		expect(config.modelOutputPriceYuan).toBe(0);
	});

	it("空串按留空处理，不报错", () => {
		const { config, errors } = load({ MODEL_INPUT_PRICE: "   " });
		expect(errors).toEqual([]);
		expect(config.modelInputPriceYuan).toBeUndefined();
	});

	it("负数报错并指向服务商价格页", () => {
		const { errors } = load({ MODEL_INPUT_PRICE: "-1" });
		const error = errorFor(errors, "MODEL_INPUT_PRICE");
		expect(error?.reason).toContain("-1");
		expect(error?.advice).toContain("元 / 百万 token");
	});

	it("非数字报错而不是退回默认值", () => {
		// 退回默认值会让客户以为配上了，而金额一直算不对
		const { errors } = load({ MODEL_OUTPUT_PRICE: "八块" });
		expect(errorFor(errors, "MODEL_OUTPUT_PRICE")).toBeDefined();
	});
});

describe("金额配额与单价的联动校验", () => {
	it("配了金额上限但没配单价时报配置错误", () => {
		// 这是本项校验的全部理由：缺单价时折算出来的金额恒为 0，
		// 金额熔断永远触不到，客户以为限住了实际没限
		const { errors } = load({ QUOTA_MAX_COST_YUAN: "10" });
		const error = errorFor(errors, "MODEL_INPUT_PRICE");
		expect(error).toBeDefined();
		expect(error?.key).toContain("MODEL_OUTPUT_PRICE");
		expect(error?.reason).toContain("熔断");
	});

	it("联动错误的建议给出两条可执行的路", () => {
		// 只说「缺单价」不够：客户要么去配价，要么本来就不想按金额限量，
		// 两条路都得写出来，否则会再来一轮问答
		const { errors } = load({ QUOTA_MAX_COST_YUAN: "10" });
		const advice = errorFor(errors, "MODEL_INPUT_PRICE")?.advice ?? "";
		// 路一：把价配上
		expect(advice).toContain("MODEL_INPUT_PRICE");
		// 路二：改用 token 限量
		expect(advice).toContain("QUOTA_MAX_TOKENS");
	});

	it("只配了输入价、缺输出价时也拦住，且只点名缺的那一项", () => {
		const { errors } = load({ QUOTA_MAX_COST_YUAN: "10", MODEL_INPUT_PRICE: "2" });
		const error = errorFor(errors, "MODEL_OUTPUT_PRICE");
		expect(error).toBeDefined();
		expect(error?.key).not.toContain("MODEL_INPUT_PRICE");
	});

	it("单价配齐后金额上限正常通过，并折算成微元", () => {
		const { config, errors } = load({
			QUOTA_MAX_COST_YUAN: "10",
			MODEL_INPUT_PRICE: "2",
			MODEL_OUTPUT_PRICE: "8",
		});
		expect(errors).toEqual([]);
		// 配置里填「元」，内部用微元
		expect(config.quotaMaxCostMicroYuan).toBe(10_000_000);
	});

	it("QUOTA_MAX_COST_YUAN=0 同样要求单价 —— 0 是禁用而非无限制", () => {
		// 填 0 的语义是「一分钱都不许花」，这依然要靠折算才能判定
		const { errors } = load({ QUOTA_MAX_COST_YUAN: "0" });
		expect(errorFor(errors, "MODEL_INPUT_PRICE")).toBeDefined();
	});

	it("只按 token 或任务数限量时不要求单价", () => {
		// 私有化部署用自有推理服务，本就没有单价可填
		const { errors } = load({ QUOTA_MAX_TOKENS: "100000", QUOTA_MAX_TASKS: "50" });
		expect(errors).toEqual([]);
	});

	it("金额上限留空时不要求单价", () => {
		const { errors } = load();
		expect(errors).toEqual([]);
	});

	it("联动错误会与其它配置错误一起报全，不在第一个错误处停下", () => {
		const { errors } = loadConfig({ QUOTA_MAX_COST_YUAN: "10" });
		// 三项模型配置缺失 + 单价联动，客户一次就能看到全部
		expect(errorFor(errors, "MODEL_BASE_URL")).toBeDefined();
		expect(errorFor(errors, "MODEL_API_KEY")).toBeDefined();
		expect(errorFor(errors, "MODEL_NAME")).toBeDefined();
		expect(errorFor(errors, "MODEL_INPUT_PRICE")).toBeDefined();
	});

	it("渲染出来的提示里带上单价配置项名，可直接照着改 .env", () => {
		const { errors } = load({ QUOTA_MAX_COST_YUAN: "10" });
		const text = renderConfigErrors(errors);
		expect(text).toContain("MODEL_INPUT_PRICE");
		expect(text).toContain("修改 .env");
	});
});

describe("配置摘要里的单价", () => {
	it("未配价时写明金额会显示为 0，避免被当成真实消费", () => {
		const text = describeConfig(load().config);
		expect(text).toContain("未配置");
		expect(text).toContain("0");
	});

	it("配了价时列出三档单价与单位", () => {
		const text = describeConfig(
			load({ MODEL_INPUT_PRICE: "2", MODEL_OUTPUT_PRICE: "8", MODEL_CACHE_READ_PRICE: "0.5" })
				.config,
		);
		expect(text).toContain("2");
		expect(text).toContain("8");
		expect(text).toContain("0.5");
		expect(text).toContain("元/百万 token");
	});

	it("缓存读价留空时显示「同输入」而非「未配」", () => {
		// 它确实参与计费（按输入价算），写成未配会让人以为这部分没算
		const text = describeConfig(
			load({ MODEL_INPUT_PRICE: "2", MODEL_OUTPUT_PRICE: "8" }).config,
		);
		expect(text).toContain("同输入");
	});

	it("摘要绝不回显 API Key —— 启动日志常被贴到工单里", () => {
		const text = describeConfig(load({ MODEL_API_KEY: "sk-abcdef123456" }).config);
		expect(text).not.toContain("sk-abcdef123456");
		expect(text).toContain("已配置");
	});
});
