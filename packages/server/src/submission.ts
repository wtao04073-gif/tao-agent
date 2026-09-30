/**
 * 任务提交的服务端表单校验
 *
 * 前端校验只是体验优化，可以被直接调 API 绕过 —— 必填缺失、数字越界、
 * 枚举非法的字段若进入 compilePrompt，会原样拼进提示词，让 Agent 拿着
 * 错误参数执行。因此服务端必须在 resolveCard 之后、compilePrompt 之前
 * 用 @tao/core 的 validateSubmission 独立校验一遍（与前端同一套规则）。
 *
 * 单独成模块而非内联在 main.ts：main.ts 是启动入口（import 即监听端口），
 * 无法被单测直接加载；校验是纯函数，放在这里可被直接测试。
 */

import { validateSubmission, type ScenarioCard } from "@tao/core";

/**
 * 校验提交字段；不通过时抛 Error（路由层统一转成 400）。
 *
 * 错误话术合并所有字段的问题并面向用户，不回显内部字段名以外的细节。
 * 抛出意味着调用方必须在此中止 —— 不得继续创建任务。
 */
export function assertSubmissionValid(
	card: ScenarioCard,
	fields: Readonly<Record<string, unknown>>,
): void {
	const outcome = validateSubmission(card, fields);
	if (outcome.valid) return;
	throw new Error(`提交内容有误：${outcome.errors.map((e) => e.message).join("；")}`);
}
