/**
 * 任务产物的落盘目录与下载路径解析
 *
 * 历史缺陷：产物登记的是绝对路径，但下载时只拿请求 basename 去任务产物列表
 * 里做成员校验，随后丢弃登记路径、固定在共享工作区根下按 basename 重建文件。
 * 同工作区两个任务用相同默认输出名（如「对账差异报告.xlsx」）时：
 *  - 工具都把产物写到共享根，后者覆盖前者；
 *  - 下载永远打开共享根那一个文件，跨任务串档。
 *
 * 修法两层：
 *  1. 每个任务的产物写到任务专属目录 `<租户工作区>/artifacts/<taskId>/`；
 *  2. 下载时取任务产物列表里**登记的完整路径**，做 realpath 边界校验后直接
 *     返回它，绝不丢路径后到共享根重建。
 */

import { realpathSync, statSync } from "node:fs";
import { basename, join, normalize, resolve, sep } from "node:path";

/**
 * taskId 白名单。生产 id 形如 `task-<毫秒>-<随机数>`，只放行安全单段字符，
 * 从源头杜绝用 taskId 拼目录时的路径穿越。
 */
export function isSafeTaskId(taskId: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(taskId);
}

/**
 * 任务专属产物目录（不做磁盘 IO，仅纯路径计算 + 边界断言）。
 *
 * taskId 不合法或解析结果越出租户工作区时抛错 —— 调用方绝不能据此 mkdir。
 */
export function taskArtifactDir(workspaceRoot: string, taskId: string): string {
	if (!isSafeTaskId(taskId)) {
		throw new Error(`任务标识含非法字符，拒绝拼产物目录：${taskId}`);
	}
	const base = resolve(workspaceRoot);
	const target = resolve(base, "artifacts", taskId);
	if (target !== base && !target.startsWith(`${base}${sep}`)) {
		throw new Error(`任务产物目录越界：${taskId}`);
	}
	return target;
}

/** 词法判定 candidate 是否落在 root 之内（相等也算）。 */
function within(candidate: string, root: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * 从任务已登记的产物路径中解析出要下载的那个文件的**真实绝对路径**。
 *
 * @returns 校验通过的文件绝对路径；名称非法 / 未登记 / 越界 / 非普通文件
 *          一律返回 undefined（路由层统一 404，不区分存在与否）。
 */
export function resolveRegisteredArtifact(input: {
	/** 租户工作区根（共享上传根）；产物真实路径必须仍在其之内。 */
	readonly workspaceRoot: string;
	/** 任务登记的产物完整路径（artifact 事件累积，通常在任务产物子目录下）。 */
	readonly artifacts: readonly string[];
	/** 请求下载的文件名。只接受单段 basename。 */
	readonly name: string;
}): string | undefined {
	const { workspaceRoot, artifacts, name } = input;
	// 只接受单段文件名，拒绝任何路径分隔符 / 点段
	const base = basename(name);
	if (base !== name || name === "" || name === "." || name === "..") return undefined;

	// 取登记的完整路径，而不是用 basename 到共享根重建 —— 这是不串档的关键
	const registered = artifacts.find((p) => basename(p) === base);
	if (registered === undefined) return undefined;

	const root = resolve(workspaceRoot);
	const lexical = normalize(resolve(registered));
	if (!within(lexical, root)) return undefined;

	// 文件系统层复核：登记路径可能已被替换成指向工作区外的符号链接。
	// 两端都 realpath 后再比，边界建立在 inode 上而不是字面量上。
	let realRoot: string;
	let realTarget: string;
	try {
		realRoot = realpathSync(root);
		realTarget = realpathSync(lexical);
	} catch {
		return undefined;
	}
	if (!within(realTarget, realRoot)) return undefined;
	try {
		if (!statSync(realTarget).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return realTarget;
}
