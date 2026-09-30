/**
 * 平台工具目录
 *
 * 场景卡用工具名声明白名单，但名字是字符串 —— 打错一个字母不会报错，
 * 只会让白名单静默失效（多授权或少授权），这是权限系统里最难查的一类缺陷。
 * 这份目录把「工具名」变成可校验的集合。
 *
 * 目录同时记录**实现状态**。场景卡的设计先于工具实现落地，
 * 让「卡片引用了还没实现的工具」成为一条可断言的事实，
 * 比等到运行时才发现工具不存在要好。
 */

/** 工具的实现状态。 */
export const ToolStatus = {
	/** 已实现可用。 */
	Available: "available",
	/** 已设计、待实现。引用它的场景卡可以提交，但跑不到产出。 */
	Planned: "planned",
} as const;

export type ToolStatus = (typeof ToolStatus)[keyof typeof ToolStatus];

export interface ToolDescriptor {
	readonly name: string;
	readonly label: string;
	readonly status: ToolStatus;
	/** 读还是写。权限门按此区分只读与写入路径。 */
	readonly access: "read" | "write";
}

export const TOOL_CATALOG: readonly ToolDescriptor[] = [
	// ── 表格（M1 已交付）──
	{ name: "list_sheets", label: "查看表格结构", status: ToolStatus.Available, access: "read" },
	{ name: "read_table", label: "读取表格", status: ToolStatus.Available, access: "read" },
	{ name: "reconcile_tables", label: "核对两张表并产出报告", status: ToolStatus.Available, access: "write" },

	// ── 文档（M3-1 已交付）──
	{ name: "read_document", label: "读取文档", status: ToolStatus.Available, access: "read" },
	{ name: "write_document", label: "生成文档", status: ToolStatus.Available, access: "write" },

	// ── 知识库（M3-2 已交付）──
	{ name: "search_knowledge", label: "检索知识库", status: ToolStatus.Available, access: "read" },
];

const BY_NAME = new Map(TOOL_CATALOG.map((t) => [t.name, t]));

export function findTool(name: string): ToolDescriptor | undefined {
	return BY_NAME.get(name);
}

/** 已实现的工具名集合。用于判断一个场景卡当前能否真正跑到产出。 */
export function availableToolNames(): Set<string> {
	return new Set(TOOL_CATALOG.filter((t) => t.status === ToolStatus.Available).map((t) => t.name));
}

/**
 * 校验一组工具名。
 *
 * 返回目录里不存在的名字 —— 非空即说明有拼写错误或引用了未登记的工具。
 */
export function unknownTools(names: readonly string[]): string[] {
	return names.filter((n) => !BY_NAME.has(n));
}

/** 判断一个场景卡声明的工具是否全部已实现。 */
export function isFullyImplemented(toolNames: readonly string[]): boolean {
	const available = availableToolNames();
	return toolNames.every((n) => available.has(n));
}

/**
 * 求场景卡声明的工具与运行时实际注册的工具的交集。
 *
 * 为什么需要这一步：场景卡的设计先于工具实现（10 张卡在 M2 落地，
 * 文档与知识库工具排在 M3）。把卡片声明的工具名原样交给内核的
 * `activeToolNames` 会导致**整个任务在生成阶段失败** —— 内核要求
 * activeToolNames 必须全部已注册，未注册即 `configured_tools_unavailable`。
 *
 * 取交集的效果：卡片能跑通它已有工具支持的那部分，缺的工具只是能力受限，
 * 而不是整张卡不可用。这也让「M3 补上工具」成为纯增量改动 ——
 * 无需回头改场景卡定义。
 */
export function activateableTools(
	declared: readonly string[],
	registered: readonly string[],
): string[] {
	const present = new Set(registered);
	return declared.filter((n) => present.has(n));
}
