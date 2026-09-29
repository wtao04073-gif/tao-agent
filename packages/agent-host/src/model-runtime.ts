/**
 * 模型 provider 装配
 *
 * 这个文件的存在是**边界检查逼出来的**：M4-2 的服务入口原本直接
 * `import { createModels } from "@earendil-works/pi-ai"`，
 * `check-boundaries.mjs` 拦下了。拦得对 —— provider 装配是内核细节，
 * 放在业务层的后果是将来换推理内核时要改全平台。
 *
 * ── 第一版是错的，被真实启动暴露 ──
 *
 * 第一版手搓了 `{ id, name, contextWindow, maxTokens }` 当模型对象，
 * 并把 `{ baseUrl, apiKey }` 直接塞给 `setProvider`。服务能起来，
 * 但提交任务后立刻 `model_unavailable` ——
 *
 * 原因是内核用 `models.getModel(provider, modelId)` 查注册表，
 * 而 `setProvider` 要的是完整 `Provider`（含 `id` / `getModels()` /
 * `stream()`）。手搓的对象既没注册进任何 provider，也缺 `api` 与
 * `compat` 字段（决定用哪套协议、如何拼请求体）。
 *
 * 这个缺陷只有**真的启动服务并提交一个任务**才会暴露：单测里用
 * `fauxProvider` 全都正常，构建也通过。M4-1 那条 `run_end` 订阅
 * 在这里救了场 —— 否则任务会被报成成功而零产出。
 *
 * 正确做法是用 vendor 的 `createProvider` 工厂。
 */

import { createModels, createProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/** 平台自己的模型接入词汇，不暴露内核类型。 */
export interface ModelEndpoint {
	/**
	 * 服务地址。
	 *
	 * 一期只支持 OpenAI 兼容协议 —— DeepSeek、通义千问、Kimi、豆包，
	 * 以及 vLLM / Ollama 自建服务都走这一套，覆盖目标客户的全部选择。
	 */
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly modelName: string;
	/**
	 * 上下文窗口。影响内核何时触发 compaction。
	 *
	 * 给得过大的后果是内核迟迟不压缩，直到 provider 报「超出上下文」——
	 * 而那个错误对行业用户完全不可读。宁可保守。
	 */
	readonly contextWindow?: number;
	/** 单次输出上限。 */
	readonly maxTokens?: number;
	/**
	 * 单价（元 / 百万 token）。
	 *
	 * 内核用它算 `usage.cost`。**必须给**：`model.cost` 缺失会让内核在
	 * 第一次生成时就崩（`Cannot read properties of undefined (reading 'tiers')`）。
	 *
	 * 平台自己的计量不依赖这个值（见 @tao/core 的 metering），
	 * 但内核要读，所以这里给一份。默认按 DeepSeek 的量级取。
	 */
	readonly inputCostPerMillion?: number;
	readonly outputCostPerMillion?: number;
	readonly cacheReadCostPerMillion?: number;
}

/** 模型档位（M5-5）。词汇与 @tao/core RunnerSpec.tier 对齐。 */
export type ModelTier = "flagship" | "lite";

/** 多端点装配入参：旗舰档必填，轻量档可选（缺省回退到旗舰）。 */
export interface ModelRuntimeOptions {
	readonly flagship: ModelEndpoint;
	readonly lite?: ModelEndpoint;
}

export interface ModelRuntime {
	readonly models: ReturnType<typeof createModels>;
	/** 默认（旗舰）模型，保留旧字段，兼容既有单模型装配。 */
	readonly model: Model<Api>;
	/** 按档位取模型；未配置轻量档时 lite 回落到旗舰。 */
	readonly modelForTier: (tier: ModelTier) => Model<Api>;
}

/** 平台内部的 provider id。两档若 baseUrl/key 不同，必须各用一个 provider。 */
export const SELF_HOSTED_PROVIDER_ID = "tao-openai-compat";
function providerId(tier: ModelTier): string {
	return tier === "lite" ? `${SELF_HOSTED_PROVIDER_ID}-lite` : `${SELF_HOSTED_PROVIDER_ID}-flagship`;
}

/** 由一个端点构造内核模型对象。 */
function buildModelObject(endpoint: ModelEndpoint, tier: ModelTier): Model<Api> {
	return {
		id: endpoint.modelName,
		name: endpoint.modelName,
		// api 与 provider 是内核查表与选协议的依据，缺了就 model_unavailable
		api: "openai-completions",
		provider: providerId(tier),
		baseUrl: endpoint.baseUrl,
		input: ["text"],
		contextWindow: endpoint.contextWindow ?? 32_768,
		maxTokens: endpoint.maxTokens ?? 4096,
		/**
		 * 单价。**不能省** —— 内核在算 usage 成本时直接读 `cost.tiers`，
		 * 字段缺失会让第一次生成就抛 `reading 'tiers'`。
		 * 平台自己的计量另有按名查表的单价表，这里给一份供内核计费。
		 */
		cost: {
			input: endpoint.inputCostPerMillion ?? 2,
			output: endpoint.outputCostPerMillion ?? 8,
			cacheRead: endpoint.cacheReadCostPerMillion ?? 0.5,
			cacheWrite: 0,
		},
		/**
		 * 兼容性开关按**最保守**取值。多数国产模型与自建 vLLM 不支持
		 * store、developer 角色、strict 模式；开着 provider 会报 400。
		 */
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		},
	} as unknown as Model<Api>;
}

/**
 * 装配模型运行时（支持旗舰 / 轻量双档）。
 *
 * 两档 baseUrl 或 apiKey 不同时必须用两个 provider：provider 的 auth/baseUrl
 * 是 provider 级、且按 model.provider 解析，单一 provider 无法为两档给不同
 * 凭证与地址。轻量档省略时，两档位都解析到旗舰端点（仅注册一个 provider）。
 */
export function createModelRuntime(options: ModelEndpoint | ModelRuntimeOptions): ModelRuntime {
	// 兼容旧签名：直接传单端点 = 仅旗舰档
	const opts: ModelRuntimeOptions =
		"flagship" in options ? options : { flagship: options as ModelEndpoint };

	const models = createModels();
	const tiers: ReadonlyArray<{ tier: ModelTier; endpoint: ModelEndpoint }> = [
		{ tier: "flagship", endpoint: opts.flagship },
		{ tier: "lite", endpoint: opts.lite ?? opts.flagship },
	];
	const byTier = new Map<ModelTier, Model<Api>>();

	// 出网前配额闸不在这里包 provider：内核把 AssistantMessageEventStream
	// 仅以类型导出，宿主无法自行构造终止流。闸落在 Runner.prompt() 第一次模型
	// 调用之前（见 in-process-runner.preflightModel），同样零字节出网，且拿得到
	// 租户与档位，是更干净的接缝。
	for (const { tier, endpoint } of tiers) {
		const model = buildModelObject(endpoint, tier);
		byTier.set(tier, model);
		models.setProvider(
			createProvider({
				id: providerId(tier),
				name:
					tier === "lite"
						? "轻量档 · 兼容 OpenAI 协议的模型服务"
						: "旗舰档 · 兼容 OpenAI 协议的模型服务",
				baseUrl: endpoint.baseUrl,
				/**
				 * 凭证直接给定，不走环境变量探测 —— 平台配置项统一为
				 * 各档自己的 API Key，不让客户按服务商改环境变量名。
				 */
				auth: {
					apiKey: {
						name: "模型服务 API Key",
						resolve: async () => ({
							auth: { apiKey: endpoint.apiKey },
							source: "MODEL_API_KEY",
						}),
					},
				},
				models: [model],
				api: openAICompletionsApi(),
			}) as never,
		);
	}

	const flagship = byTier.get("flagship") as Model<Api>;
	return {
		models,
		model: flagship,
		modelForTier: (tier) => byTier.get(tier) ?? flagship,
	};
}
