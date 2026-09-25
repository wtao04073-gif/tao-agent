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
