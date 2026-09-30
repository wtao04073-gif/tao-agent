/**
 * 工具目录测试
 *
 * 这份目录的作用是把「工具名」从自由字符串变成可校验的集合。
 * 工具名写错不会报错，只会让白名单静默失效 —— 多授权是安全问题，
 * 少授权是能力莫名缺失，两种都难查。
 */

import { describe, expect, it } from "vitest";
import {
	activateableTools,
	availableToolNames,
	findTool,
	isFullyImplemented,
	TOOL_CATALOG,
	ToolStatus,
	unknownTools,
} from "../src/tool-catalog.ts";

describe("工具目录 · 基本查询", () => {
	it("按名字查得到描述", () => {
		expect(findTool("reconcile_tables")?.label).toBe("核对两张表并产出报告");
	});

	it("查不存在的工具返回 undefined", () => {
		expect(findTool("rm_rf")).toBeUndefined();
	});

	it("工具名不重复", () => {
		const names = TOOL_CATALOG.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("M1 交付的表格工具已标为可用", () => {
		for (const name of ["list_sheets", "read_table", "reconcile_tables"]) {
			expect(findTool(name)?.status, name).toBe(ToolStatus.Available);
		}
	});

	it("M3-1 交付的文档工具已标为可用", () => {
		for (const name of ["read_document", "write_document"]) {
			expect(findTool(name)?.status, name).toBe(ToolStatus.Available);
		}
	});

	it("M3-2 交付的知识库工具已标为可用", () => {
		expect(findTool("search_knowledge")?.status).toBe(ToolStatus.Available);
	});

	it("目录里已无待实现工具", () => {
		// M3-1/M3-2 交付后全部工具均已实现。新增 Planned 工具时这条会失败，
		// 提醒同步更新场景卡可跑名单
		expect(TOOL_CATALOG.filter((t) => t.status === ToolStatus.Planned)).toEqual([]);
	});

	it("每个工具都标了读写属性", () => {
		for (const tool of TOOL_CATALOG) {
			expect(["read", "write"], tool.name).toContain(tool.access);
		}
	});
});

describe("工具目录 · 名字校验", () => {
	it("检出拼错的工具名", () => {
		expect(unknownTools(["read_table", "read_tables"])).toEqual(["read_tables"]);
	});

	it("全部合法时返回空", () => {
		expect(unknownTools(["read_table", "write_document"])).toEqual([]);
	});

	it("空列表返回空", () => {
		expect(unknownTools([])).toEqual([]);
	});
});

describe("工具目录 · 实现状态", () => {
	it("已可用工具集合只含 Available 的", () => {
		const available = availableToolNames();
		for (const tool of TOOL_CATALOG) {
			expect(available.has(tool.name), tool.name).toBe(tool.status === ToolStatus.Available);
		}
	});

	it("全部已实现时判为可完整运行", () => {
		expect(
			isFullyImplemented(["read_table", "reconcile_tables", "write_document", "search_knowledge"]),
		).toBe(true);
	});

	it("含未登记工具时判为不可完整运行", () => {
		// 目录里已无 Planned 工具，所以用一个根本不存在的名字验这条路径
		expect(isFullyImplemented(["read_table", "not_a_real_tool"])).toBe(false);
	});

	it("空工具列表算「已实现」", () => {
		// 边界：没有工具需求的场景（纯写作）不该被判成缺能力
		expect(isFullyImplemented([])).toBe(true);
	});
});

describe("工具目录 · 激活交集（防止整个任务失败）", () => {
	it("取声明与已注册的交集", () => {
		expect(
			activateableTools(["read_table", "write_document"], ["read_table", "reconcile_tables"]),
		).toEqual(["read_table"]);
	});

	it("保持声明顺序", () => {
		expect(
			activateableTools(["reconcile_tables", "read_table"], ["read_table", "reconcile_tables"]),
		).toEqual(["reconcile_tables", "read_table"]);
	});

	it("全部未注册时返回空", () => {
		// 内核收到空的 activeToolNames 意味着「无工具可用」，
		// 这比「含未注册工具」好 —— 后者会让整个运行失败
		expect(activateableTools(["write_document"], ["read_table"])).toEqual([]);
	});

	it("结果一定是已注册工具的子集", () => {
		const registered = ["read_table", "list_sheets"];
		const result = activateableTools(
			["read_table", "write_document", "search_knowledge", "list_sheets"],
			registered,
		);
		for (const name of result) expect(registered).toContain(name);
	});
});
