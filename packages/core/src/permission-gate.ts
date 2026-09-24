/**
 * 权限门
 *
 * 实现[安全策略](../../../docs/security-policy.md)的「默认拒绝 + 白名单放行」。
 *
 * 设计要点：
 *
 *  - **默认拒绝。** 未在白名单里的工具一律拒绝。新增工具必须显式登记，
 *    这样「忘记加权限判断」的后果是不可用，而不是不受控。
 *  - **不吞异常。** 本模块可以抛异常 —— [M0 Spike 3](../../../spikes/README.md) 验证过内核
 *    在 `before_tool` 抛异常时 fail-closed（拒绝执行）。自己 try/catch
 *    反而可能把拒绝变成放行。
 *  - **路径参数逐个查。** 工具声明哪些参数是路径，门按 D 级黑名单校验。
 */

import { checkPath } from "./path-policy.ts";
import type { PermissionGate, ToolDecision } from "./runner.ts";

/** 一个工具的权限规则。 */
export interface ToolPolicy {
	/** 工具名。 */
	readonly tool: string;
	/**
	 * 需要按路径策略校验的参数名。
	 *
	 * 值可以是字符串或字符串数组（如「多个输入文件」）。
	 */
	readonly pathParams?: readonly string[];
	/**
	 * 是否属于高危动作，需用户逐次确认。
	 *
	 * 对应验收要求「高危动作（对外发送、批量修改、删除）必须经用户确认」。
	 */
	readonly requiresConfirm?: boolean;
	/** 确认卡片上展示的说明。requiresConfirm 为真时必填。 */
	readonly confirmReason?: string;
}

export interface GateConfig {
	/** 白名单。不在其中的工具一律拒绝。 */
	readonly policies: readonly ToolPolicy[];
	/** 任务工作区绝对路径。 */
	readonly workspace: string;
	/** 用户或管理员显式授权的目录。 */
	readonly grantedDirs?: readonly string[];
	/** 审计回调。**每一次**决策都会调用，不只是拒绝。 */
	readonly audit?: (entry: AuditEntry) => void | Promise<void>;
}

export interface AuditEntry {
	readonly tool: string;
	readonly decision: "allowed" | "blocked" | "await_confirm";
	readonly reason?: string;
	/** 命中的路径规则类别，便于把「探测行为」与「误操作」分开告警。 */
	readonly rule?: string;
	readonly args: unknown;
}

/** 从参数里取出路径值，兼容单个字符串与字符串数组两种形态。 */
function extractPaths(args: unknown, paramNames: readonly string[]): string[] {
	if (typeof args !== "object" || args === null) return [];
	const record = args as Record<string, unknown>;
	const paths: string[] = [];
	for (const name of paramNames) {
		const value = record[name];
		if (typeof value === "string") paths.push(value);
		else if (Array.isArray(value)) {
			for (const item of value) if (typeof item === "string") paths.push(item);
		}
	}
	return paths;
}

/**
 * 构造一个权限门。
 *
 * 返回的函数可直接交给 `RunnerSpec.gate`。
 */
export function createPermissionGate(config: GateConfig): PermissionGate {
	const byTool = new Map(config.policies.map((p) => [p.tool, p]));

	return async (request): Promise<ToolDecision> => {
		const audit = async (decision: ToolDecision, rule?: string): Promise<ToolDecision> => {
			await config.audit?.({
				tool: request.toolName,
				decision:
					decision.kind === "allow"
						? "allowed"
						: decision.kind === "block"
							? "blocked"
							: "await_confirm",
				...(decision.kind === "allow" ? {} : { reason: decision.reason }),
				...(rule === undefined ? {} : { rule }),
				args: request.args,
			});
			return decision;
		};

		// 默认拒绝：未登记的工具一律不放行
		const policy = byTool.get(request.toolName);
		if (policy === undefined) {
			return audit({
				kind: "block",
				reason: `工具 ${request.toolName} 未被授权使用`,
			});
		}

		// 路径参数逐个按 D 级黑名单校验
		for (const path of extractPaths(request.args, policy.pathParams ?? [])) {
			const verdict = checkPath(path, config.workspace, config.grantedDirs ?? []);
			if (!verdict.allowed) {
				return audit(
					{ kind: "block", reason: verdict.reason ?? `路径不可访问：${path}` },
					verdict.rule,
				);
			}
		}

		// 高危动作转确认
		if (policy.requiresConfirm === true) {
			return audit({
				kind: "confirm",
				reason: policy.confirmReason ?? `${request.toolName} 属于高危操作，请确认后继续`,
			});
		}

		return audit({ kind: "allow" });
	};
}

/**
 * 按场景卡的工具白名单收窄权限策略。
 *
 * 场景卡的 `tools` 是**模型侧**的白名单（通过 `activeToolNames` 让工具不可见）。
 * 但模型侧不可见不等于执行侧不可达 —— 上下文污染、越狱提示或内核缺陷都可能
 * 让模型调用一个「看不见」的工具。所以执行侧也要按同一份白名单收窄。
 *
 * 这里刻意用**过滤策略表**而非在门内加一个 `allowTool` 回调：
 * 不在策略表里的工具会走已有的默认拒绝分支，不引入第二条判断路径 ——
 * 权限逻辑每多一个分支就多一处可能写错的地方。
 */
export function restrictPolicies(
	policies: readonly ToolPolicy[],
	allowedTools: readonly string[],
): ToolPolicy[] {
	const allowed = new Set(allowedTools);
	return policies.filter((p) => allowed.has(p.tool));
}
