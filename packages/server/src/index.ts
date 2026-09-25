/**
 * @tao/server —— HTTP 服务与 SSE 事件下发
 *
 * **零第三方运行时依赖**，只用 Node 内置 `http`。
 * 依据见 [Spike 7](../../../spikes/07-sse-delivery/)：内置 http 足够支撑
 * SSE 与断线重连，而 M4 的验收门禁是「客户 IT 2 小时内独立装成」——
 * 每多一个依赖就多一处装不上的可能。
 */

export {
	HEARTBEAT_MS,
	parseAnchor,
	SseHub,
	toSseFrame,
} from "./sse.ts";

export {
	checkDisk,
	checkMemory,
	checkModelApi,
	checkNodeVersion,
	checkPort,
	checkWorkspaceWritable,
	formatBytes,
	renderReport,
	REQUIREMENTS,
	summarize,
	type Check,
	type CheckResult,
	type HealthReport,
} from "./health.ts";

export {
	describeConfig,
	loadConfig,
	renderConfigErrors,
	type AppConfig,
	type ConfigError,
} from "./config.ts";

export {
	createApp,
	MAX_BODY_BYTES,
	parseWindow,
	readJsonBody,
	sendError,
	sendJson,
	type AppDeps,
	type Principal,
} from "./app.ts";

/**
 * 角色枚举的再导出。
 *
 * 让调用方不必同时依赖 @tao/core 只为拿一个枚举 ——
 * 服务层的 `Principal.role` 用的就是它。
 */
export { Role } from "@tao/core";
