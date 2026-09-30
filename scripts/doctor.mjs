#!/usr/bin/env node
/**
 * 部署自检
 *
 * 客户 IT 人员装完执行 `npm run doctor`（或容器内 `node scripts/doctor.mjs`）。
 * M4 的验收门禁是「2 小时内独立装成」，而达不到这个目标的首要原因
 * 不是步骤复杂，而是**出错时不知道错在哪**。
 *
 * 所以这个脚本的产出是**可操作的修复建议**，不是堆栈或错误码。
 * 判定逻辑在 @tao/server 的 health 模块里（有测试覆盖），
 * 这里只做真实环境的探测与串联。
 */

import { createServer } from "node:http";
import {
	accessSync,
	constants,
	mkdirSync,
	readFileSync,
	statfsSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import {
	checkDisk,
	checkMemory,
	checkModelApi,
	checkNodeVersion,
	checkPort,
	checkWorkspaceWritable,
	renderReport,
	summarize,
} from "../packages/server/dist/index.js";

/** 探测端口是否被占用。 */
async function probePort(port) {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", (error) => {
			resolve(error.code === "EADDRINUSE");
		});
		server.once("listening", () => {
			server.close(() => resolve(false));
		});
		server.listen(port, "0.0.0.0");
	});
}

/**
 * 探测容器内存上限。
 *
 * **优先读 cgroup 配额而非 `os.totalmem()`**：容器里 totalmem 报的是
 * 宿主机内存，而进程实际能用的是 cgroup 限额。按宿主机内存判定会让
 * 「宿主 64G、容器限 2G」这种常见配置通过自检，然后运行时被 OOM kill。
 */
function probeMemory() {
	for (const path of [
		"/sys/fs/cgroup/memory.max", // cgroup v2
		"/sys/fs/cgroup/memory/memory.limit_in_bytes", // cgroup v1
	]) {
		try {
			const raw = readFileSyncSafe(path);
			if (raw === undefined) continue;
			const text = raw.trim();
			// cgroup v2 用 "max" 表示无限制
			if (text === "max") continue;
			const value = Number.parseInt(text, 10);
			// v1 无限制时是一个极大值（接近 2^63），按无限制处理
			if (Number.isFinite(value) && value > 0 && value < 2 ** 53) return value;
		} catch {
			// 读不到就退回宿主机内存 —— 非容器环境走这条路
		}
	}
	return totalmem();
}

/** 读文件，读不到返回 undefined。cgroup 路径在非容器环境不存在。 */
function readFileSyncSafe(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** 探测可用磁盘。 */
function probeDisk(path) {
	try {
		const stat = statfsSync(path);
		return stat.bavail * stat.bsize;
	} catch {
		return undefined;
	}
}

/** 探测工作区可写 —— 真的写一个文件，不只看权限位。 */
function probeWorkspace(path) {
	try {
		mkdirSync(path, { recursive: true });
		accessSync(path, constants.W_OK);
		/**
		 * 真的写一次。只查权限位不够：只读挂载、磁盘满、SELinux 限制
		 * 都会让权限位看起来正常而写入失败。
		 */
		const probe = join(path, ".doctor-probe");
		writeFileSync(probe, "ok");
		unlinkSync(probe);
		return { writable: true, path };
	} catch (error) {
		return { writable: false, path, error: error.code ?? error.message };
	}
}

/** 探测模型 API 连通性。 */
async function probeModelApi(baseUrl, apiKey) {
	// 「没配」与「配了但连不上」分开报 —— 排查方向完全不同
	if (baseUrl === undefined || baseUrl === "") {
		return { reachable: false, unconfigured: true };
	}

	let host;
	try {
		host = new URL(baseUrl).host;
	} catch {
		return { reachable: false, error: `MODEL_BASE_URL 不是合法的 URL：${baseUrl}` };
	}

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8000);
		const res = await fetch(new URL("/v1/models", baseUrl), {
			headers: apiKey === undefined || apiKey === "" ? {} : { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		clearTimeout(timer);
		return { reachable: true, status: res.status, endpointHost: host };
	} catch (error) {
		const reason =
			error.name === "AbortError" ? "连接超时（8 秒）" : (error.cause?.code ?? error.message);
		return { reachable: false, error: reason, endpointHost: host };
	}
}

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const WORKSPACE = process.env.WORKSPACE_DIR ?? "/data/workspace";

const results = [
	checkNodeVersion(process.version),
	checkMemory(probeMemory()),
	checkPort(PORT, await probePort(PORT)),
	checkWorkspaceWritable(probeWorkspace(WORKSPACE)),
	checkModelApi(await probeModelApi(process.env.MODEL_BASE_URL, process.env.MODEL_API_KEY)),
];

// 磁盘探测可能失败（某些文件系统不支持 statfs），失败时跳过而非报错
const disk = probeDisk(WORKSPACE);
if (disk !== undefined) {
	results.splice(2, 0, checkDisk(disk));
}

const report = summarize(results);
process.stdout.write(renderReport(report));

// 额外给一条并发建议 —— 按实际核数，不按宿主机
const cores = availableParallelism();
process.stdout.write(
	`  提示：本机可用 ${cores} 核，建议 MAX_CONCURRENT_TASKS 不超过 ${Math.max(1, cores - 1)}。\n\n`,
);

/**
 * 失败时以非零码退出，便于 Compose 的 healthcheck 与 CI 判定。
 * warn 不影响退出码 —— 能跑就该让它跑。
 */
process.exit(report.ok ? 0 : 1);
