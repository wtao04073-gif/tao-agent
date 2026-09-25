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

export interface ModelRuntime {
	readonly models: ReturnType<typeof createModels>;
	readonly model: Model<Api>;
}

/** 平台内部的 provider id。用固定值，便于日志与排查时辨认。 */
export const SELF_HOSTED_PROVIDER_ID = "tao-openai-compat";

/**
 * 装配模型运行时。
 *
 * 默认窗口取 32K、输出 4K：国产模型的普遍下限。客户用长上下文模型时
 * 可通过配置调高。
 */
export function createModelRuntime(endpoint: ModelEndpoint): ModelRuntime {
	const model = {
		id: endpoint.modelName,
		name: endpoint.modelName,
		// api 与 provider 是内核查表与选协议的依据，缺了就 model_unavailable
		api: "openai-completions",
		provider: SELF_HOSTED_PROVIDER_ID,
		baseUrl: endpoint.baseUrl,
		input: ["text"],
		contextWindow: endpoint.contextWindow ?? 32_768,
		maxTokens: endpoint.maxTokens ?? 4096,
		/**
		 * 单价。**不能省** —— 内核在算 usage 成本时直接读 `cost.tiers`，
		 * 字段缺失会让第一次生成就抛 `reading 'tiers'`。
		 *
		 * 这是第二处「手搓模型对象缺字段」的缺陷，同样只有真实启动 +
		 * 提交任务才暴露（假 provider 不走这条计费路径）。
		 */
		cost: {
			input: endpoint.inputCostPerMillion ?? 2,
			output: endpoint.outputCostPerMillion ?? 8,
			cacheRead: endpoint.cacheReadCostPerMillion ?? 0.5,
			cacheWrite: 0,
		},
		/**
		 * 兼容性开关按**最保守**取值。
		 *
		 * 多数国产模型与自建 vLLM 不支持 store、developer 角色、strict 模式。
		 * 开着的后果是 provider 报 400，而错误信息通常是英文的协议细节 ——
		 * 客户 IT 看不懂，会当成产品 bug 报过来。
		 */
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		},
	} as unknown as Model<Api>;

	const models = createModels();
	models.setProvider(
		createProvider({
			id: SELF_HOSTED_PROVIDER_ID,
			name: "自建/兼容 OpenAI 协议的模型服务",
			baseUrl: endpoint.baseUrl,
			/**
			 * 凭证直接给定，不走环境变量探测。
			 *
			 * vendor 内置 provider 用 `envApiKeyAuth` 从固定的环境变量名读取
			 * （如 `DEEPSEEK_API_KEY`），但平台的配置项是统一的
			 * `MODEL_API_KEY` —— 让客户按不同服务商改环境变量名
			 * 会直接拖垮「2 小时装成」的目标。
			 */
			auth: {
				apiKey: {
					name: "模型服务 API Key",
					// 平台自己管配置，不需要交互式登录，所以不实现 login
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

	return { models, model };
}
