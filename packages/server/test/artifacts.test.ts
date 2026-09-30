/**
 * 任务产物路径解析测试
 *
 * 对应缺陷：同名产物跨任务串档。下载逻辑原来丢弃登记路径、固定在共享工作区
 * 根按 basename 重建，两个任务用相同默认输出名时互相覆盖、下载串到对方文件。
 *
 * 这里直接测纯函数 resolveRegisteredArtifact / taskArtifactDir：
 *  - 两个任务各自子目录下同名文件内容不同，只返回该任务登记的那个；
 *  - 越界 / 未登记 / 路径段 / 符号链接逃逸 / 非文件 一律 undefined；
 *  - taskId 白名单挡住路径穿越。
 */

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSafeTaskId, resolveRegisteredArtifact, taskArtifactDir } from "../src/artifacts.ts";

const roots: string[] = [];
afterEach(() => {
	roots.splice(0);
});

function makeRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "tao-art-"));
	roots.push(dir);
	return dir;
}

describe("taskArtifactDir / isSafeTaskId", () => {
	it("产物目录位于工作区 artifacts/<taskId> 下", () => {
		const root = makeRoot();
		const dir = taskArtifactDir(root, "task-123-456");
		expect(dir).toBe(join(root, "artifacts", "task-123-456"));
	});

	it("含路径分隔符 / 点段的 taskId 被拒", () => {
		const root = makeRoot();
		for (const bad of ["../etc", "a/b", "a\\b", "..", ".", "task;rm", "task 1"]) {
			expect(isSafeTaskId(bad)).toBe(false);
			expect(() => taskArtifactDir(root, bad)).toThrow();
		}
	});

	it("正常 taskId 形态放行", () => {
		for (const good of ["task-1700000000000-123456", "task_x-1", "ABC-123"]) {
			expect(isSafeTaskId(good)).toBe(true);
		}
	});
});

describe("resolveRegisteredArtifact 跨任务不串档", () => {
	it("两个任务同名报告内容不同，各自只取本任务登记路径", () => {
		const root = makeRoot();
		const dirA = taskArtifactDir(root, "task-a");
		const dirB = taskArtifactDir(root, "task-b");
		mkdirSync(dirA, { recursive: true });
		mkdirSync(dirB, { recursive: true });
		const fileA = join(dirA, "报告.xlsx");
		const fileB = join(dirB, "报告.xlsx");
		writeFileSync(fileA, "AAA");
		writeFileSync(fileB, "BBB");

		const gotA = resolveRegisteredArtifact({
			workspaceRoot: root,
			artifacts: [fileA],
			name: "报告.xlsx",
		});
		const gotB = resolveRegisteredArtifact({
			workspaceRoot: root,
			artifacts: [fileB],
			name: "报告.xlsx",
		});
		expect(gotA).toBe(fileA);
		expect(gotB).toBe(fileB);
		// 即便共享根下恰好也有同名文件，也绝不回落到它
		writeFileSync(join(root, "报告.xlsx"), "ROOT-SHARED");
		const stillA = resolveRegisteredArtifact({ workspaceRoot: root, artifacts: [fileA], name: "报告.xlsx" });
		expect(stillA).toBe(fileA);
	});

	it("name 必须是单段 basename 且已登记", () => {
		const root = makeRoot();
		const file = join(root, "artifacts", "task-a", "r.xlsx");
		mkdirSync(join(root, "artifacts", "task-a"), { recursive: true });
		writeFileSync(file, "x");
		expect(resolveRegisteredArtifact({ workspaceRoot: root, artifacts: [file], name: "../r.xlsx" })).toBeUndefined();
		expect(resolveRegisteredArtifact({ workspaceRoot: root, artifacts: [file], name: "other.xlsx" })).toBeUndefined();
		expect(resolveRegisteredArtifact({ workspaceRoot: root, artifacts: [], name: "r.xlsx" })).toBeUndefined();
		expect(resolveRegisteredArtifact({ workspaceRoot: root, artifacts: [file], name: "" })).toBeUndefined();
	});

	it("登记路径越出工作区（词法层）返回 undefined", () => {
		const root = makeRoot();
		expect(
			resolveRegisteredArtifact({
				workspaceRoot: root,
				artifacts: [join(root, "..", "..", "etc", "passwd")],
				name: "passwd",
			}),
		).toBeUndefined();
	});

	it("登记路径是指向工作区外的符号链接时 realpath 边界拒绝", () => {
		const root = makeRoot();
		const dir = taskArtifactDir(root, "task-link");
		mkdirSync(dir, { recursive: true });
		const inside = join(dir, "报告.xlsx");
		const outside = join(tmpdir(), `tao-out-${Date.now()}.txt`);
		writeFileSync(outside, "outside");
		symlinkSync(outside, inside);
		expect(
			resolveRegisteredArtifact({ workspaceRoot: root, artifacts: [inside], name: "报告.xlsx" }),
		).toBeUndefined();
	});

	it("目标是目录而非普通文件时返回 undefined", () => {
		const root = makeRoot();
		const dir = taskArtifactDir(root, "task-dir");
		mkdirSync(join(dir, "报告.xlsx"), { recursive: true });
		expect(
			resolveRegisteredArtifact({ workspaceRoot: root, artifacts: [join(dir, "报告.xlsx")], name: "报告.xlsx" }),
		).toBeUndefined();
	});
});
