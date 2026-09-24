/**
 * D 级路径黑名单
 *
 * 对应[安全策略决策 2](../../../docs/security-policy.md)：**凭据路径绝对禁止，不留配置口子。**
 *
 * 这份清单**硬编码，不接受任何配置覆盖** —— 即使租户管理员、
 * 即使客户书面要求也不得开放。原因：一旦留了配置口子，它就会在
 * 某次赶工的现场支持中被打开，然后永远开着。
 *
 * 判定在**路径规范化之后**进行，否则 `/workspace/../etc/passwd`
 * 这类穿越会绕过前缀匹配。
 */

import { isAbsolute, normalize, resolve, sep } from "node:path";

/** 系统关键路径。命中即拒绝。 */
const SYSTEM_PREFIXES: readonly string[] = [
	"/etc",
	"/sys",
	"/proc",
	"/boot",
	"/dev",
	"/root",
	"/var/run",
	"/var/lib/docker",
];

/** 凭据与密钥目录。 */
const CREDENTIAL_DIRS: readonly string[] = [
	".ssh",
	".aws",
	".kube",
	".gnupg",
	".docker",
	".config/gcloud",
	".azure",
];

/** 凭据与密钥文件名模式。 */
const CREDENTIAL_FILES: readonly RegExp[] = [
	/\.pem$/i,
	/\.key$/i,
	/\.p12$/i,
	/\.pfx$/i,
	/^id_rsa/i,
	/^id_ed25519/i,
	/^id_ecdsa/i,
	/(^|\.)env$/i, // .env、prod.env
	/^\.env($|\.)/i, // .env.local
	/^\.netrc$/i,
	/^\.npmrc$/i,
	/^credentials$/i,
	/\.kdbx$/i,
];

/**
 * 本产品自身的路径。防止 Agent 自我修改与篡改证据。
 *
 * 用路径**片段**匹配而非绝对前缀，因为产品安装位置随部署环境变化。
 */
const SELF_SEGMENTS: readonly string[] = [
	"vendor", // 内核源码，防自我修改
	"node_modules", // 防注入依赖
	".git", // 防改历史
];

/** 会话与审计存储的目录名。防篡改证据。 */
const EVIDENCE_SEGMENTS: readonly string[] = ["sessions", "audit"];

export interface PathVerdict {
	readonly allowed: boolean;
	/** 拒绝原因。面向用户，须说清为什么不行。 */
	readonly reason?: string;
	/** 命中的规则类别，用于审计与告警分类。 */
	readonly rule?: "system" | "credential" | "self" | "evidence" | "escape" | "outside_workspace";
}

const ALLOWED: PathVerdict = { allowed: true };

function deny(rule: NonNullable<PathVerdict["rule"]>, reason: string): PathVerdict {
	return { allowed: false, reason, rule };
}

/** 把路径切成片段，用于片段级匹配。 */
function segments(path: string): string[] {
	return path.split(/[/\\]/).filter((s) => s.length > 0);
}

/**
 * 判定一个路径是否可访问。
 *
 * @param candidate 待判定路径。可以是相对或绝对。
 * @param workspace 任务工作区绝对路径。候选路径必须落在其内（或落在授权目录内）。
 * @param grantedDirs 用户/管理员显式授权的目录（绝对路径）。
 */
export function checkPath(
	candidate: string,
	workspace: string,
	grantedDirs: readonly string[] = [],
): PathVerdict {
	// 1. 规范化。必须先做，否则 ../ 穿越能绕过所有前缀匹配。
	const absolute = isAbsolute(candidate) ? normalize(candidate) : resolve(workspace, candidate);
	const parts = segments(absolute);
	const basename = parts[parts.length - 1] ?? "";

	// 2. 系统关键路径
	for (const prefix of SYSTEM_PREFIXES) {
		if (absolute === prefix || absolute.startsWith(`${prefix}/`)) {
			return deny("system", `系统关键路径不可访问：${prefix}`);
		}
	}

	// 3. 凭据目录（片段匹配，覆盖 ~/.ssh 与 /home/x/.ssh 两种形态）
	for (const dir of CREDENTIAL_DIRS) {
		const dirParts = segments(dir);
		for (let i = 0; i + dirParts.length <= parts.length; i++) {
			if (dirParts.every((p, j) => parts[i + j] === p)) {
				return deny("credential", `凭据目录不可访问：${dir}`);
			}
		}
	}

	// 4. 凭据文件名
	for (const pattern of CREDENTIAL_FILES) {
		if (pattern.test(basename)) {
			return deny("credential", `凭据文件不可访问：${basename}`);
		}
	}

	// 5. 产品自身与证据存储。
	// 仅在工作区之外判定 —— 工作区内允许出现同名业务目录
	// （例如用户上传的资料里恰好有个叫 sessions 的文件夹）。
	const insideWorkspace =
		absolute === workspace || absolute.startsWith(`${workspace}${sep}`) || absolute.startsWith(`${workspace}/`);

	if (!insideWorkspace) {
		for (const segment of SELF_SEGMENTS) {
			if (parts.includes(segment)) {
				return deny("self", `产品自身路径不可访问：${segment}`);
			}
		}
		for (const segment of EVIDENCE_SEGMENTS) {
			if (parts.includes(segment)) {
				return deny("evidence", `审计与会话存储不可访问：${segment}`);
			}
		}
	}

	// 6. 必须落在工作区或授权目录内
	if (insideWorkspace) return ALLOWED;

	for (const granted of grantedDirs) {
		const normalizedGrant = normalize(granted);
		if (absolute === normalizedGrant || absolute.startsWith(`${normalizedGrant}/`)) {
			return ALLOWED;
		}
	}

	// 原始路径含 .. 说明是穿越尝试，单独归类以便告警区分「误操作」与「探测」
	if (candidate.includes("..")) {
		return deny("escape", `路径越界：${candidate} 超出授权范围`);
	}
	return deny("outside_workspace", `路径不在任务工作区或已授权目录内：${candidate}`);
}

/** 供测试与审计使用的规则快照。**只读，不提供修改入口。** */
export const PATH_RULES = Object.freeze({
	systemPrefixes: SYSTEM_PREFIXES,
	credentialDirs: CREDENTIAL_DIRS,
	credentialFilePatterns: CREDENTIAL_FILES.map((r) => r.source),
	selfSegments: SELF_SEGMENTS,
	evidenceSegments: EVIDENCE_SEGMENTS,
});
