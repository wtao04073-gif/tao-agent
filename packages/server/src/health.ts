/**
 * 部署自检
 *
 * M4 的验收门禁是「客户 IT 人员 2 小时内独立装成」。达不到这个目标的
 * 首要原因不是安装步骤复杂，而是**出错时不知道错在哪**：
 *
 *  - 端口被占 → 服务起不来，日志里是一句 `EADDRINUSE`
 *  - 模型 API 打不通 → 任务全部失败，日志里是 `fetch failed`
 *  - 磁盘满 → 产物写不出，日志里是 `ENOSPC`
 *  - 内存不够 → 进程被 OOM kill，日志里什么都没有
 *
 * 客户 IT 看到这些会直接打电话，2 小时就没了。所以自检的产出必须是
 * **可操作的修复建议**，而不是堆栈或错误码。
 *
 * ── 一条设计原则 ──
 *
 * 每项检查都要回答「失败了该做什么」。只报「✗ 磁盘检查失败」没有价值 ——
 * 必须说「剩余 800MB，建议至少 5GB；清理 /var/lib/docker 或扩容」。
 */

/** 一项检查的结论。 */
export interface CheckResult {
	readonly name: string;
	/**
	 * `pass` 通过；`warn` 能跑但有风险；`fail` 装不成。
	 *
	 * warn 与 fail 分开是必要的：内存 4GB 能跑但会卡，
	 * 报成 fail 会让客户以为硬件不达标而放弃采购。
	 */
	readonly level: "pass" | "warn" | "fail";
	/** 实测值的描述。 */
	readonly detail: string;
	/** 失败或告警时的修复建议。`pass` 时为 undefined。 */
	readonly advice?: string;
}

/** 自检项的定义。 */
export interface Check {
	readonly name: string;
	readonly run: () => Promise<CheckResult>;
}

/** 部署环境的最低要求。写成常量便于随实测调整。 */
export const REQUIREMENTS = {
	/** Node 主版本下限。vendor/pi 需要 22+。 */
	nodeMajor: 22,
	/** 建议内存（字节）。低于此值能跑但并发一高就 OOM。 */
	recommendedMemoryBytes: 8 * 1024 ** 3,
	/** 最低内存。低于此值装不成。 */
	minimumMemoryBytes: 4 * 1024 ** 3,
	/** 建议可用磁盘（字节）。产物、知识库与日志都要空间。 */
	recommendedDiskBytes: 20 * 1024 ** 3,
	/** 最低可用磁盘。 */
	minimumDiskBytes: 5 * 1024 ** 3,
} as const;

/** 把字节数格式化成给人看的大小。 */
export function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
	return `${bytes} B`;
}

/**
 * 检查 Node 版本。
 *
 * 版本不够的表现是构建期或运行期报一堆语法错误，
 * 客户 IT 会以为是代码有问题。
 */
export function checkNodeVersion(version: string): CheckResult {
	const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
	if (!Number.isFinite(major)) {
		return {
			name: "Node 版本",
			level: "fail",
			detail: `无法识别版本号：${version}`,
			advice: `请确认已安装 Node ${REQUIREMENTS.nodeMajor} 或更高版本（node -v）`,
		};
	}
	if (major < REQUIREMENTS.nodeMajor) {
		return {
			name: "Node 版本",
			level: "fail",
			detail: `当前 ${version}，需要 ${REQUIREMENTS.nodeMajor} 或更高`,
			advice:
				`升级 Node 到 ${REQUIREMENTS.nodeMajor} LTS。` +
				`若用 Docker 部署，请确认镜像基于 node:${REQUIREMENTS.nodeMajor} 或更新版本`,
		};
	}
	return { name: "Node 版本", level: "pass", detail: version };
}

/**
 * 检查内存。
 *
 * 分 fail / warn 两档：低于最低值装不成，介于最低与建议之间能跑但
 * 并发一高就 OOM —— 后者报 fail 会让客户以为硬件不达标而放弃。
 */
export function checkMemory(totalBytes: number): CheckResult {
	if (totalBytes < REQUIREMENTS.minimumMemoryBytes) {
		return {
			name: "内存",
			level: "fail",
			detail: `${formatBytes(totalBytes)}，低于最低要求 ${formatBytes(REQUIREMENTS.minimumMemoryBytes)}`,
			advice: `扩容到 ${formatBytes(REQUIREMENTS.recommendedMemoryBytes)} 以上。若在虚拟机里，调高分配的内存`,
		};
	}
	if (totalBytes < REQUIREMENTS.recommendedMemoryBytes) {
		return {
			name: "内存",
			level: "warn",
			detail: `${formatBytes(totalBytes)}，低于建议值 ${formatBytes(REQUIREMENTS.recommendedMemoryBytes)}`,
			advice:
				"可以运行，但并发任务较多时可能 OOM。" +
				"建议把并发上限调低（配置项 MAX_CONCURRENT_TASKS=2），或扩容内存",
		};
	}
	return { name: "内存", level: "pass", detail: formatBytes(totalBytes) };
}

/** 检查可用磁盘。 */
export function checkDisk(availableBytes: number): CheckResult {
	if (availableBytes < REQUIREMENTS.minimumDiskBytes) {
		return {
			name: "可用磁盘",
			level: "fail",
			detail: `${formatBytes(availableBytes)}，低于最低要求 ${formatBytes(REQUIREMENTS.minimumDiskBytes)}`,
			advice:
				"清理空间或扩容。Docker 环境常见占用：" +
				"docker system prune -a 可回收未使用的镜像与容器",
		};
	}
	if (availableBytes < REQUIREMENTS.recommendedDiskBytes) {
		return {
			name: "可用磁盘",
			level: "warn",
			detail: `${formatBytes(availableBytes)}，低于建议值 ${formatBytes(REQUIREMENTS.recommendedDiskBytes)}`,
			advice: "可以运行。产物与知识库会持续占用空间，建议定期清理或扩容",
		};
	}
	return { name: "可用磁盘", level: "pass", detail: formatBytes(availableBytes) };
}

/**
 * 检查端口可用性。
 *
 * 端口占用是最常见的首次部署失败原因，而 `EADDRINUSE` 这个错误码
 * 对非专业运维没有意义。
 */
export function checkPort(port: number, inUse: boolean, occupant?: string): CheckResult {
	if (inUse) {
		return {
			name: `端口 ${port}`,
			level: "fail",
			detail: `已被占用${occupant === undefined ? "" : `（${occupant}）`}`,
			advice:
				`换一个端口（配置项 PORT=${port + 1}），` +
				`或先停掉占用方：lsof -i :${port} 查进程，然后 kill`,
		};
	}
	return { name: `端口 ${port}`, level: "pass", detail: "可用" };
}

/**
 * 检查模型 API 连通性。
 *
 * 这项最容易出错也最难自查：私有化环境常有出网限制、需要代理、
 * 或 API Key 配错。而失败表现是「所有任务都失败」，看不出是网络问题。
 *
 * **不在结果里回显 API Key**，只说配置项名 —— 自检报告常被截图发群里。
 */
export function checkModelApi(outcome: {
	readonly reachable: boolean;
	readonly status?: number;
	readonly error?: string;
	readonly endpointHost?: string;
	/** 配置项本身缺失 —— 与「配了但连不上」是两回事。 */
	readonly unconfigured?: boolean;
}): CheckResult {
	const where = outcome.endpointHost === undefined ? "" : `（${outcome.endpointHost}）`;

	/**
	 * 「没配」与「配了但连不上」必须分开报。
	 *
	 * 这是自检脚本首次真实运行时发现的措辞缺陷：未配置时却建议
	 * 「确认服务器能出网、设置 HTTPS_PROXY」—— 客户 IT 会去查网络，
	 * 而实际上只是少填一行配置。排查方向错了比没有建议更浪费时间。
	 */
	if (outcome.unconfigured === true) {
		return {
			name: "模型 API 连通性",
			level: "fail",
			detail: "未配置模型服务地址",
			advice:
				"在 .env 里填写 MODEL_BASE_URL 与 MODEL_API_KEY。" +
				"用公有云模型请填服务商的 API 地址；" +
				"用内网自建推理服务请填该服务的地址。可参考 .env.example",
		};
	}

	if (!outcome.reachable) {
		return {
			name: "模型 API 连通性",
			level: "fail",
			detail: `无法连接${where}：${outcome.error ?? "原因未知"}`,
			advice:
				"依次确认：① 服务器能出网（curl 目标域名）；" +
				"② 若需代理，设置 HTTPS_PROXY 环境变量；" +
				"③ 内网部署请确认 MODEL_BASE_URL 指向可达的推理服务地址",
		};
	}

	/**
	 * 取不到状态码时不能判通过。连接建立只说明地址通，不说明模型接口能用，
	 * 而「自检通过但所有任务失败」是最费时间的排查起点。
	 */
	if (outcome.status === undefined) {
		return {
			name: "模型 API 连通性",
			level: "warn",
			detail: `已连上${where}但未取到 HTTP 状态码`,
			advice:
				"手动确认接口真的可调用：" +
				'curl -i "$MODEL_BASE_URL/v1/models" -H "Authorization: Bearer $MODEL_API_KEY"',
		};
	}

	/**
	 * 只有明确的 2xx 才算通过。
	 *
	 * 自检与真实任务用同一个地址和同一份凭证，这里放行就等于把问题推迟到
	 * 任务全量失败时才暴露 —— 那时客户看到的是「装好了但一个都跑不成」。
	 */
	if (outcome.status >= 200 && outcome.status < 300) {
		return { name: "模型 API 连通性", level: "pass", detail: `可达${where}` };
	}

	if (outcome.status === 401 || outcome.status === 403) {
		return {
			name: "模型 API 连通性",
			level: "fail",
			// 只说配置项名，不回显密钥值 —— 自检报告常被截图发群
			detail: `网络可达但鉴权失败（HTTP ${outcome.status}）`,
			advice: "检查配置项 MODEL_API_KEY 是否正确、是否有效、是否有该模型的调用权限",
		};
	}

	/**
	 * 404 是地址路径配错，与「服务不可用」要分开报 —— 前者改一行配置就好，
	 * 后者要查网络。漏掉 /v1 后缀是最常见的一种。
	 */
	if (outcome.status === 404) {
		return {
			name: "模型 API 连通性",
			level: "fail",
			detail: "网络可达但接口路径不存在（HTTP 404）",
			advice:
				"检查配置项 MODEL_BASE_URL 的路径是否正确：多数服务商要求带 /v1 后缀" +
				"（如 https://api.example.com/v1）。" +
				'可用 curl -i "$MODEL_BASE_URL/v1/models" 确认哪个路径有响应',
		};
	}

	/**
	 * 429 归 warn 而非 fail：服务本身是通的，扛不住的是当前并发或配额，
	 * 报 fail 会让客户回去反复检查配置。
	 */
	if (outcome.status === 429) {
		return {
			name: "模型 API 连通性",
			level: "warn",
			detail: "网络可达但被限流（HTTP 429）",
			advice:
				"把并发上限调低（配置项 MAX_CONCURRENT_TASKS=2）后重试；" +
				"若刚部署就限流，多半是账号配额已用完或未开通该模型，需找模型服务提供方确认配额",
		};
	}

	if (outcome.status >= 500) {
		return {
			name: "模型 API 连通性",
			level: "warn",
			detail: `服务端错误（HTTP ${outcome.status}）`,
			advice: "模型服务方暂时异常，稍后重试。若持续出现请联系模型服务提供方",
		};
	}

	return {
		name: "模型 API 连通性",
		level: "fail",
		detail: `网络可达但接口返回异常（HTTP ${outcome.status}）`,
		advice:
			"4xx 说明请求不符合服务方要求，先核对配置项 MODEL_BASE_URL 的路径与 MODEL_API_KEY 的格式；" +
			"3xx 说明地址被重定向，改填重定向后的地址。" +
			'可用 curl -i "$MODEL_BASE_URL/v1/models" 看响应体里的具体原因',
	};
}

/**
 * 检查工作区可写。
 *
 * 容器里挂载卷权限配错时，表现是任务跑完但产物文件不存在 ——
 * 而任务状态可能还是成功（若实现没检查写入结果）。
 */
export function checkWorkspaceWritable(outcome: {
	readonly writable: boolean;
	readonly path: string;
	readonly error?: string;
}): CheckResult {
	if (!outcome.writable) {
		return {
			name: "工作区可写",
			level: "fail",
			detail: `${outcome.path} 不可写：${outcome.error ?? "原因未知"}`,
			advice:
				"若用 Docker 部署，检查挂载卷的宿主目录权限：" +
				`chown -R 1000:1000 <宿主目录>。确认 docker-compose.yml 里的 volumes 配置指向存在的目录`,
		};
	}
	return { name: "工作区可写", level: "pass", detail: outcome.path };
}

/** 自检总结。 */
export interface HealthReport {
	readonly results: readonly CheckResult[];
	/** 有 fail 即为 false。warn 不影响。 */
	readonly ok: boolean;
	readonly failures: readonly CheckResult[];
	readonly warnings: readonly CheckResult[];
}

/**
 * 汇总检查结果。
 *
 * **全部跑完再汇总，不在第一个失败处停下。** 客户 IT 需要一次看到
 * 所有问题 —— 修一个跑一次、再修一个，2 小时的预算撑不住几轮。
 */
export function summarize(results: readonly CheckResult[]): HealthReport {
	const failures = results.filter((r) => r.level === "fail");
	const warnings = results.filter((r) => r.level === "warn");
	return { results, ok: failures.length === 0, failures, warnings };
}

/**
 * 把自检报告渲染成终端输出。
 *
 * 排版上把**修复建议放在紧跟失败项的位置**，而不是集中到末尾 ——
 * 后者需要来回对照，出错时人是没有耐心对照的。
 */
export function renderReport(report: HealthReport): string {
	const lines: string[] = ["", "部署自检", "─".repeat(48)];

	for (const result of report.results) {
		const mark = result.level === "pass" ? "✓" : result.level === "warn" ? "!" : "✗";
		lines.push(`  ${mark} ${result.name}：${result.detail}`);
		if (result.advice !== undefined) {
			// 建议紧跟在问题下面，缩进对齐
			lines.push(`      → ${result.advice}`);
		}
	}

	lines.push("─".repeat(48));

	if (report.ok && report.warnings.length === 0) {
		lines.push("  自检通过，可以启动服务。", "");
		return lines.join("\n");
	}

	if (report.ok) {
		lines.push(
			`  自检通过，但有 ${report.warnings.length} 项提醒（见上方 ! 标记）。`,
			"  服务可以启动，建议按提示优化后再投入生产使用。",
			"",
		);
		return lines.join("\n");
	}

	lines.push(
		`  自检未通过：${report.failures.length} 项必须修复。`,
		"  按上方 ✗ 标记逐项处理后重新运行自检。",
		"",
	);
	return lines.join("\n");
}
