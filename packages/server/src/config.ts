/**
 * 配置读取
 *
 * 集中在一处而非散落在各模块，理由是 M4 的验收门禁（客户 IT 2 小时内
 * 装成）要求**配置错误能被一次性报全**。散落的 `process.env.X` 会让
 * 客户修一个跑一次，修三轮就超时了。
 */

/** 一条配置错误。 */
export interface ConfigError {
	readonly key: string;
	readonly reason: string;
	readonly advice: string;
}

export interface AppConfig {
	readonly port: number;
	readonly workspaceDir: string;
	readonly modelBaseUrl: string;
	readonly modelApiKey: string;
	readonly modelName: string;
	/**
	 * 模型单价，单位「元 / 百万 token」，与各家官网价格页口径一致。
	 * `undefined` 表示没配 —— 此时用量会被记为「未配价」而不是 0 元。
	 *
	 * 金额配额靠它折算。没有单价，`QUOTA_MAX_COST_YUAN` 就是个
	 * 永远触不到的上限（见 loadConfig 末尾的联动校验）。
	 */
	readonly modelInputPriceYuan: number | undefined;
	readonly modelOutputPriceYuan: number | undefined;
	/** 缓存命中的输入单价。留空时按输入价计。 */
	readonly modelCacheReadPriceYuan: number | undefined;
	readonly maxConcurrentTasks: number;
	readonly maxSubtaskConcurrency: number;
	readonly logLevel: "debug" | "info" | "warn" | "error";
	/**
	 * 配额上限。`undefined` 表示无限制。
	 *
	 * **留空与填 0 的语义不同**：留空是无限制，0 是禁用。
	 * 这个区分在 .env.example 里有显式说明。
	 */
	readonly quotaMaxTokens: number | undefined;
	readonly quotaMaxCostMicroYuan: number | undefined;
	readonly quotaMaxTasks: number | undefined;
}

/**
 * 解析一个正整数配置项。
 *
 * 空值与非法值分开处理：空值用默认值，非法值报错。
 * 把非法值也退回默认值会掩盖配置错误 —— 客户填了 `PORT=80 80`
 * 却发现服务在 8080 上，排查起来很费时间。
 */
function parseInteger(
	key: string,
	raw: string | undefined,
	fallback: number,
	errors: ConfigError[],
	options: { min?: number; max?: number; advice?: string } = {},
): number {
	if (raw === undefined || raw.trim() === "") return fallback;

	const value = Number(raw.trim());
	if (!Number.isInteger(value)) {
		errors.push({
			key,
			reason: `不是整数：${raw}`,
			advice: options.advice ?? `填一个整数，或删掉这一行用默认值 ${fallback}`,
		});
		return fallback;
	}
	const min = options.min ?? 1;
	if (value < min) {
		errors.push({
			key,
			reason: `不能小于 ${min}：${value}`,
			advice: options.advice ?? `填 ${min} 或更大的值`,
		});
		return fallback;
	}
	if (options.max !== undefined && value > options.max) {
		errors.push({
			key,
			reason: `不能大于 ${options.max}：${value}`,
			advice: options.advice ?? `填 ${options.max} 或更小的值`,
		});
		return fallback;
	}
	return value;
}

/**
 * 解析可选的配额上限。
 *
 * 留空 → `undefined`（无限制）；填 0 → `0`（禁用）。
 * 这两者绝不能混：把 0 当成无限制会让「欠费停机」变成「无限量使用」。
 */
function parseOptionalQuota(
	key: string,
	raw: string | undefined,
	errors: ConfigError[],
): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw.trim());
	if (!Number.isInteger(value) || value < 0) {
		errors.push({
			key,
			reason: `不是非负整数：${raw}`,
			advice: `填一个非负整数，或删掉这一行表示无限制。注意 0 表示禁用而非无限制`,
		});
		return undefined;
	}
	return value;
}

/**
 * 解析可选的模型单价（元 / 百万 token）。
 *
 * 这里**不能限制成整数**：国产模型的单价低到 0.5 元/百万 token，
 * 取整会把它抹成 0 或 1，前者等于免费、后者虚高一倍。
 *
 * 填 0 是合法的（自建推理服务成本已另计），语义是「这一项不计费」，
 * 与留空的「没配价」不同 —— 后者会让金额配额失效。
 */
function parseOptionalPrice(
	key: string,
	raw: string | undefined,
	errors: ConfigError[],
): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw.trim());
	if (!Number.isFinite(value) || value < 0) {
		errors.push({
			key,
			reason: `不是非负数：${raw}`,
			advice:
				"填服务商价格页上的单价，单位是「元 / 百万 token」，" +
				"可带小数（如 0.5）。不清楚就查服务商的计费说明",
		});
		return undefined;
	}
	return value;
}

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

/**
 * 从环境变量解析配置。
 *
 * **把全部错误一起返回**，不在第一个错误处抛出 —— 见文件头说明。
 */
export function loadConfig(env: Record<string, string | undefined>): {
	config: AppConfig;
	errors: readonly ConfigError[];
} {
	const errors: ConfigError[] = [];

	const modelBaseUrl = (env.MODEL_BASE_URL ?? "").trim();
	if (modelBaseUrl === "") {
		errors.push({
			key: "MODEL_BASE_URL",
			reason: "未配置",
			advice:
				"在 .env 里填模型服务地址。公有云填服务商的 API 地址，" +
				"内网自建推理服务填该服务地址。参考 .env.example",
		});
	} else {
		try {
			new URL(modelBaseUrl);
		} catch {
			errors.push({
				key: "MODEL_BASE_URL",
				reason: `不是合法的 URL：${modelBaseUrl}`,
				advice: "要带协议头，如 https://api.deepseek.com 或 http://192.168.1.100:8000/v1",
			});
		}
	}

	const modelApiKey = (env.MODEL_API_KEY ?? "").trim();
	if (modelApiKey === "") {
		errors.push({
			key: "MODEL_API_KEY",
			reason: "未配置",
			// 不回显任何值 —— 报错信息可能被截图发群
			advice:
				"在 .env 里填 API Key。内网自建推理服务多数不校验，" +
				"填任意非空值即可（如 local）",
		});
	}

	const modelName = (env.MODEL_NAME ?? "").trim();
	if (modelName === "") {
		errors.push({
			key: "MODEL_NAME",
			reason: "未配置",
			advice: "填模型名，如 deepseek-chat、qwen-plus。按服务商的模型清单填写",
		});
	}

	const logLevelRaw = (env.LOG_LEVEL ?? "info").trim();
	if (!LOG_LEVELS.has(logLevelRaw)) {
		errors.push({
			key: "LOG_LEVEL",
			reason: `不是有效级别：${logLevelRaw}`,
			advice: "填 debug、info、warn 或 error 之一",
		});
	}

	const workspaceDir = (env.WORKSPACE_DIR ?? "/data/workspace").trim();

	const config: AppConfig = {
		port: parseInteger("PORT", env.PORT, 8080, errors, {
			min: 1,
			max: 65535,
			advice: "填 1-65535 之间的端口号。1024 以下的端口需要 root 权限",
		}),
		workspaceDir,
		modelBaseUrl,
		modelApiKey,
		modelName,
		modelInputPriceYuan: parseOptionalPrice("MODEL_INPUT_PRICE", env.MODEL_INPUT_PRICE, errors),
		modelOutputPriceYuan: parseOptionalPrice("MODEL_OUTPUT_PRICE", env.MODEL_OUTPUT_PRICE, errors),
		modelCacheReadPriceYuan: parseOptionalPrice(
			"MODEL_CACHE_READ_PRICE",
			env.MODEL_CACHE_READ_PRICE,
			errors,
		),
		maxConcurrentTasks: parseInteger("MAX_CONCURRENT_TASKS", env.MAX_CONCURRENT_TASKS, 3, errors, {
			min: 1,
			advice:
				"填 1 或更大。建议 min(CPU 核数 - 1, 可用内存GB)。" +
				"填太高会撞模型服务的速率限制，或被 OOM kill",
		}),
		maxSubtaskConcurrency: parseInteger(
			"MAX_SUBTASK_CONCURRENCY",
			env.MAX_SUBTASK_CONCURRENCY,
			3,
			errors,
			{
				min: 1,
				advice:
					"填 1 或更大。它与 MAX_CONCURRENT_TASKS 相乘才是真实的模型并发数，别都填大",
			},
		),
		logLevel: (LOG_LEVELS.has(logLevelRaw) ? logLevelRaw : "info") as AppConfig["logLevel"],
		quotaMaxTokens: parseOptionalQuota("QUOTA_MAX_TOKENS", env.QUOTA_MAX_TOKENS, errors),
		quotaMaxCostMicroYuan: (() => {
			// 配置里用「元」，内部用微元 —— 让客户填 10 而不是 10000000
			const yuan = parseOptionalQuota("QUOTA_MAX_COST_YUAN", env.QUOTA_MAX_COST_YUAN, errors);
			return yuan === undefined ? undefined : yuan * 1_000_000;
		})(),
		quotaMaxTasks: parseOptionalQuota("QUOTA_MAX_TASKS", env.QUOTA_MAX_TASKS, errors),
	};

	/**
	 * 金额上限与模型单价必须成对出现。
	 *
	 * 缺单价时折算出来的金额恒为 0（用量被记成「未配价」），金额熔断
	 * 就永远触不到 —— 看板上还是一笔笔正常的用量，超卖到什么程度都看不出来。
	 * 这种「配了却不生效」的形态比没配更危险，所以宁可起不来。
	 */
	if (config.quotaMaxCostMicroYuan !== undefined) {
		const missing = [
			config.modelInputPriceYuan === undefined ? "MODEL_INPUT_PRICE" : undefined,
			config.modelOutputPriceYuan === undefined ? "MODEL_OUTPUT_PRICE" : undefined,
		].filter((key) => key !== undefined);
		if (missing.length > 0) {
			errors.push({
				key: missing.join(" / "),
				reason: "配了 QUOTA_MAX_COST_YUAN 但没配模型单价，金额熔断不会生效",
				advice:
					`在 .env 里按服务商价格页填 ${missing.join(" 与 ")}，单位「元 / 百万 token」；` +
					"不想按金额限量就删掉 QUOTA_MAX_COST_YUAN，改用 QUOTA_MAX_TOKENS 限 token 数",
			});
		}
	}

	return { config, errors };
}

/** 把配置错误渲染成可操作的提示。 */
export function renderConfigErrors(errors: readonly ConfigError[]): string {
	if (errors.length === 0) return "";
	const lines = ["", `配置有 ${errors.length} 处问题：`, "─".repeat(48)];
	for (const error of errors) {
		lines.push(`  ✗ ${error.key}：${error.reason}`);
		// 建议紧跟问题，不集中到末尾
		lines.push(`      → ${error.advice}`);
	}
	lines.push("─".repeat(48), "  修改 .env 后重新启动。", "");
	return lines.join("\n");
}

/**
 * 脱敏后的配置摘要，用于启动日志。
 *
 * **绝不输出 API Key**，连长度都不输出 —— 启动日志常被贴到工单里。
 */
export function describeConfig(config: AppConfig): string {
	return [
		"", "服务配置", "─".repeat(48),
		`  端口          ${config.port}`,
		`  工作区        ${config.workspaceDir}`,
		`  模型服务      ${config.modelBaseUrl}`,
		`  模型          ${config.modelName}`,
		`  API Key       ${config.modelApiKey === "" ? "未配置" : "已配置"}`,
		`  模型单价      ${describePrices(config)}`,
		`  任务并发上限   ${config.maxConcurrentTasks}`,
		`  子任务并发上限 ${config.maxSubtaskConcurrency}`,
		`  配额          ${describeQuota(config)}`,
		`  日志级别      ${config.logLevel}`,
		"─".repeat(48), "",
	].join("\n");
}

function describeQuota(config: AppConfig): string {
	const parts: string[] = [];
	if (config.quotaMaxTokens !== undefined) parts.push(`${config.quotaMaxTokens} token`);
	if (config.quotaMaxCostMicroYuan !== undefined) {
		parts.push(`${(config.quotaMaxCostMicroYuan / 1_000_000).toFixed(2)} 元`);
	}
	if (config.quotaMaxTasks !== undefined) parts.push(`${config.quotaMaxTasks} 个任务`);
	return parts.length === 0 ? "无限制" : parts.join(" / ");
}

/**
 * 单价摘要。
 *
 * 写进启动日志是为了让运维一眼看出「金额统计是否有依据」——
 * 未配价时看板上的金额会是 0，不说明就会被当成真实消费。
 */
function describePrices(config: AppConfig): string {
	if (config.modelInputPriceYuan === undefined && config.modelOutputPriceYuan === undefined) {
		return "未配置（用量只按 token 统计，金额显示为 0）";
	}
	const show = (value: number | undefined): string => (value === undefined ? "未配" : `${value}`);
	const parts = [
		`输入 ${show(config.modelInputPriceYuan)}`,
		`输出 ${show(config.modelOutputPriceYuan)}`,
	];
	// 缓存读价留空时按输入价计，显示成「同输入」避免被误读为没算
	parts.push(
		`缓存读 ${config.modelCacheReadPriceYuan === undefined ? "同输入" : config.modelCacheReadPriceYuan}`,
	);
	return `${parts.join(" / ")}（元/百万 token）`;
}
