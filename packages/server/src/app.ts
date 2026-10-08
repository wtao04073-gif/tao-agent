import { paginate, pageOptions } from "./pagination.ts";
/**
 * HTTP 路由
 *
 * 只用 Node 内置 `http`（依据见 [Spike 7](../../../spikes/07-sse-delivery/)）。
 * 手写路由在这个规模下比引框架更划算 —— 接口不到十个，而每个依赖
 * 都是私有化部署的一处风险。
 *
 * ── 一条贯穿全文件的原则 ──
 *
 * **租户身份从不信任请求体。** 它只来自鉴权中间件解析出的会话。
 * 允许请求体带 tenantId 就等于允许任意租户读别家数据 ——
 * 这类漏洞在代码审查里很难看出来，因为参数名看着很正常。
 */

import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	GENERAL_TASK_CARD_ID,
	hasRoleAtLeast,
	Role,
	type TaskEvent,
	type TenantContext,
} from "@tao/core";
import { parseAnchor, SseHub } from "./sse.ts";
import { tryServeStatic } from "./static.ts";
import type { TicketService } from "./tickets.ts";

/** 票据资源范围编码（仅做精确比对，从不反向解析）。 */
export const ticketResource = {
	file: (name: string): string => `file::${name}`,
	artifact: (taskId: string, name: string): string => `art::${taskId}/${name}`,
	events: (taskId: string | null): string | null => taskId,
};

/** 请求体大小上限。防止一个请求吃满内存。 */
export const MAX_BODY_BYTES = 1024 * 1024;
/** 上传文件大小上限：20 MB（办公场景的 Excel/Word 通常远小于此）。 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 鉴权结果。 */
export interface Principal {
	readonly tenant: TenantContext;
	/**
	 * 角色。管理接口按它判权。
	 *
	 * 默认 `Member` 而非 `TenantAdmin` —— 鉴权实现忘记设角色时，
	 * 后果应当是「管理接口用不了」而不是「谁都是管理员」。
	 */
	readonly role: Role;
	/** 账号显示名（来自账号目录），用于侧栏与 /api/me。 */
	readonly name?: string;
}

/** 上传成功后回给前端的文件信息。 */
export interface UploadedFile {
    readonly fileId?: string;
	readonly name: string;
	/** 工具消费用的绝对路径（在任务工作区内）。 */
	readonly path: string;
	readonly sizeBytes: number;
}

/** 工作区里的一个资料文件（不含任务产物所在的隐藏目录）。 */
export interface WorkspaceFile {
	readonly name: string;
	readonly sizeBytes: number;
	readonly modifiedAt: number;
}

/** 平台需要的外部依赖。全部注入，便于测试与替换。 */
export interface AppDeps {
	/**
	 * 解析请求身份。返回 undefined 表示未通过鉴权。
	 *
	 * 一期由调用方注入一个简单实现（Bearer token → 租户）；
	 * SaaS 形态换成真实的会话服务。
	 *
	 * SSE 的 EventSource 无法自定义头，允许调用方在此额外识别一次性
	 * query 票据（ticket），由 authenticate 实现消费。
	 */
	readonly authenticate: (req: IncomingMessage) => Promise<Principal | undefined>;
	/**
	 * 当前部署可用的模型档位信息（供前端做模型选择器）。
	 * liteName 缺省表示只配置了旗舰档，前端不展示轻量选项。
	 */
	readonly modelInfo?: () => { readonly flagshipName: string; readonly liteName?: string };
	/** 列出当前账号可见的场景卡。 */
	readonly listScenarios?: (tenant: TenantContext) => readonly unknown[];
	/** 上传输入文件到租户工作区，返回落盘信息。 */
	readonly uploadFile?: (
		tenant: TenantContext,
		file: { readonly name: string; readonly bytes: Buffer },
	) => Promise<UploadedFile>;
	/** 列举租户工作区里的资料文件（知识资产页的资料库视图）。 */
	readonly listFiles?: (tenant: TenantContext) => readonly WorkspaceFile[];
	/** 按 basename 取工作区内资料文件的绝对路径（资料下载）；越界/不存在返回 undefined。 */
	readonly workspaceFilePath?: (tenant: TenantContext, name: string) => string | undefined;
	/**
	 * 取产物文件的绝对路径用于下载，或 undefined 表示无权/不存在。
	 * 必须内部校验该文件属于该租户工作区且属于该任务。
	 */
	readonly artifactPath?: (
		tenant: TenantContext,
		taskId: string,
		name: string,
	) => string | undefined;
	/** 用户确认高危动作后继续。 */
	readonly confirmTask?: (tenant: TenantContext, taskId: string, actionId?: string) => Promise<void>;
	/** 用户拒绝高危动作（取消任务）。 */
	readonly rejectTask?: (tenant: TenantContext, taskId: string, reason: string, actionId?: string) => Promise<void>;
	/** 取某任务的事件历史，供 SSE 重连补发。 */
	readonly taskEvents: (tenant: TenantContext, taskId: string, afterSeq: number) => readonly TaskEvent[];
	/** 列出某租户工作区的任务。 */
	readonly listTasks: (tenant: TenantContext) => readonly unknown[];
	/** 取单个任务。返回 undefined 表示不存在或不属于该租户。 */
	readonly getTask: (tenant: TenantContext, taskId: string) => unknown | undefined;
	/** 提交任务。 */
	readonly submitTask: (
		tenant: TenantContext,
		input: {
			readonly idempotencyKey?: string;
			readonly retryOf?: string;
			readonly scenarioId: string;
			readonly fields: Record<string, unknown>;
			/**
			 * 模型档位（M5-5）。路由层只接受 "flagship" | "lite"，非法值已在
			 * POST /api/tasks 被 400 拦截，故到达这里时只剩这两个值（缺省旗舰）。
			 */
			readonly tier?: "flagship" | "lite";
			/** 续聊所属对话 id；省略表示开启新对话。 */
			readonly conversationId?: string;
			/** 所属长程任务 id；省略表示临时对话。 */
			readonly jobId?: string;
			/** 本次使用的技能 id。 */
			readonly skillId?: string;
			/** 本次使用的智能体 id。 */
			readonly agentId?: string;
		},
	) => Promise<{ readonly taskId: string; readonly conversationId: string }>;
	/** 创建长程任务。 */
	readonly createJob?: (
		tenant: TenantContext,
		input: { readonly title: string; readonly goal: string },
	) => Promise<{ readonly jobId: string }>;
	/** 列出长程任务。 */
	readonly listJobs?: (tenant: TenantContext) => readonly unknown[];
	/** 取单个长程任务；不存在/越权返回 undefined。 */
	readonly getJob?: (tenant: TenantContext, jobId: string) => unknown | undefined;
	/** 列出可用技能（含预置与本租户上传）。 */
	readonly listSkills?: (tenant: TenantContext) => readonly unknown[];
	/** 列出可用智能体。 */
	readonly listAgents?: (tenant: TenantContext) => readonly unknown[];
	/** 上传/新建技能。 */
	readonly createSkill?: (
		tenant: TenantContext,
		input: { name: string; description: string; content: string },
	) => Promise<{ readonly skillId: string }>;
	/** 上传/新建智能体。 */
	readonly createAgent?: (
		tenant: TenantContext,
		input: { name: string; description: string; systemPrompt: string; skillIds: string[] },
	) => Promise<{ readonly agentId: string }>;
	/** 在执行期间插入消息（「执行中可继续对话」的落点）。 */
	readonly steerTask: (tenant: TenantContext, taskId: string, text: string) => Promise<void>;
	/** 取消任务。 */
	readonly cancelTask: (tenant: TenantContext, taskId: string, reason: string, actionId?: string) => Promise<void>;
	readonly hub: SseHub;
	/**
	 * 取用量看板。仅租户管理员可调。
	 *
	 * 时间窗由调用方给定（默认当月），便于管理员查历史周期。
	 */
	readonly usageDashboard?: (
		tenant: TenantContext,
		window: { readonly from: number; readonly to: number },
	) => Promise<unknown>;
	/** 取审计日志。仅租户管理员可调。 */
	readonly auditLog?: (
		tenant: TenantContext,
		window: { readonly from: number; readonly to: number },
	) => Promise<readonly unknown[]>;
	/**
	 * 短时一次性票据服务。给了才开放三个 `/ticket` 签发接口；GET 下载 / SSE
	 * 对 `?ticket=` 的鉴权由 authenticate 实现内部消费（见 main.ts）。
	 */
	readonly tickets?: TicketService;
}

/** 前端静态资源目录；给了才在鉴权前托管同源页面。 */
export interface AppOptions {
	readonly now?: () => number;
	readonly webDir?: string;
}

/** 极简 multipart/form-data 解析出的文件（零依赖，仅支持单文件字段）。 */
interface ParsedMultipart {
	readonly filename: string;
	readonly bytes: Buffer;
}

/**
 * 解析单个文件的 multipart 表单。
 *
 * 不引第三方库：请求体 ≤ 20MB，办公场景够用。只认第一个含 filename 的
 * 分片，按 boundary 切出其二进制内容。任何不符合预期的形状都返回失败话术。
 */
export function parseMultipartFile(
	req: IncomingMessage,
	maxBytes: number,
): Promise<{ ok: true; value: ParsedMultipart } | { ok: false; reason: string }> {
	const ctype = req.headers["content-type"] ?? "";
	const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
	if (!boundaryMatch) return Promise.resolve({ ok: false, reason: "不是 multipart/form-data 请求" });
	const boundary = "--" + (boundaryMatch[1] ?? boundaryMatch[2] ?? "").trim();

	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk: Buffer) => {
			if (aborted) return;
			size += chunk.length;
			if (size > maxBytes) {
				aborted = true;
				resolve({ ok: false, reason: `文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 上限` });
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (aborted) return;
			const body = Buffer.concat(chunks);
			const parsed = extractFilePart(body, boundary);
			resolve(parsed);
		});
		req.on("error", () => resolve({ ok: false, reason: "上传读取失败" }));
	});
}

/**
 * 恢复 multipart 普通 filename 里的中文文件名。
 *
 * 浏览器一般用 filename*=UTF-8''… 传非 ASCII 名（已在上方优先处理）；但部分
 * 客户端（含 Node 内置 fetch/undici）直接把 UTF-8 字节塞进 filename=，按
 * HTTP 头的 latin1 解码就成了 mojibake（如「对账单」→「å¯¹è´¦å•")。
 * 这里把 latin1 字符串重新按字节以 UTF-8 解码；只有当结果「解码成功且确实出现
 * 非 ASCII 字符」时才采用恢复值，纯 ASCII 的英文名原样返回，不会误伤。
 */
function restoreUtf8Filename(latin1Name: string): string {
	if (/^[\x20-\x7E]+$/.test(latin1Name)) return latin1Name;
	const bytes = Buffer.from(latin1Name, "latin1");
	const restored = bytes.toString("utf8");
	if (restored === latin1Name) return latin1Name;
	// 恢复后仍含替换符说明它本就不是 UTF-8 字节，保留原值而不是制造乱码
	return restored.includes("�") ? latin1Name : restored;
}

/** 从 multipart body 中切出第一个文件分片的文件名与二进制内容。 */
function extractFilePart(body: Buffer, boundary: string):
	{ ok: true; value: ParsedMultipart } | { ok: false; reason: string } {
	const bBuf = Buffer.from(boundary);
	const start = body.indexOf(bBuf);
	if (start < 0) return { ok: false, reason: "表单格式不正确" };
	const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), start);
	if (headerEnd < 0) return { ok: false, reason: "表单格式不正确" };
	const headers = body.subarray(start, headerEnd).toString("latin1");
	// 优先 RFC 5987 扩展文件名 filename*=UTF-8''<百分号编码>——浏览器对中文名
	// 常这样发；回退到普通 filename="…"（此时按 latin1 取，ASCII 名不受影响）。
	let rawName: string | undefined;
	const star = /filename\*\s*=\s*([^']+)'[^']*'([^;]+)/i.exec(headers);
	if (star !== null && star[2] !== undefined) {
		try {
			rawName = decodeURIComponent(star[2].trim());
		} catch {
			rawName = undefined;
		}
	}
	if (rawName === undefined) {
		const plain = /filename="([^"]*)"/i.exec(headers)?.[1];
		rawName = plain === undefined ? undefined : restoreUtf8Filename(plain);
	}
	if (rawName === undefined || rawName === "") return { ok: false, reason: "缺少上传文件" };
	// 只保留 basename，杜绝文件名里带路径
	const filename = rawName.split(/[\\/]/).pop() ?? rawName;
	if (filename === "") return { ok: false, reason: "文件名无效" };

	const contentStart = headerEnd + 4;
	const terminator = body.indexOf(Buffer.from("\r\n" + boundary), contentStart);
	if (terminator < 0) return { ok: false, reason: "表单内容不完整" };
	const bytes = body.subarray(contentStart, terminator);
	return { ok: true, value: { filename, bytes } };
}

/** 安全的下载文件名（RFC 5987，支持中文）。 */
function contentDisposition(name: string): string {
	const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 以附件形式回传一个本地文件（已由调用方完成归属与边界校验）。 */
function streamDownload(res: ServerResponse, filePath: string, name: string): void {
	let size = 0;
	try {
		size = statSync(filePath).size;
	} catch {
		sendError(res, 404, "文件不存在");
		return;
	}
	res.writeHead(200, {
		"Content-Type": "application/octet-stream",
		"Content-Length": size,
		"Content-Disposition": contentDisposition(name),
		"X-Content-Type-Options": "nosniff",
	});
	createReadStream(filePath)
		.on("error", () => res.end())
		.pipe(res);
}

/** 读取并解析 JSON 请求体。 */
export async function readJsonBody(
	req: IncomingMessage,
	maxBytes = MAX_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		// 超限立即中断，不等读完 —— 否则上限形同虚设
		if (size > maxBytes) {
			return { ok: false, reason: `请求体超过 ${Math.floor(maxBytes / 1024)} KB 上限` };
		}
		chunks.push(buffer);
	}

	if (size === 0) return { ok: true, value: {} };

	try {
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, reason: "请求体必须是 JSON 对象" };
		}
		return { ok: true, value };
	} catch {
		return { ok: false, reason: "请求体不是合法的 JSON" };
	}
}

/** 回一个 JSON 响应。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(text),
	});
	res.end(text);
}

/**
 * 回一个错误响应。
 *
 * **面向用户的话术，不是技术报错。** 行业用户看到「500 Internal
 * Server Error」只会打电话；看到「模型服务暂时不可用，请稍后重试」
 * 至少知道不是自己操作错了。
 */
export function sendError(res: ServerResponse, status: number, message: string): void {
	sendJson(res, status, { error: message });
}

/**
 * 从 URL 里取路径段，并解码。
 *
 * **必须解码**：不解码的话中文路径会以 `%E4%B9%B1%E6%9D%A5` 的形态
 * 进入错误信息，用户看到一串乱码不知道自己敲错了什么。
 * 目标用户是高校行政与制造业管理岗，他们会用中文命名。
 *
 * 解码失败（畸形百分号编码）时保留原串 —— 报错总比崩掉好。
 */
function segments(pathname: string): string[] {
	return pathname
		.split("/")
		.filter((s) => s !== "")
		.map((s) => {
			try {
				return decodeURIComponent(s);
			} catch {
				return s;
			}
		});
}

/**
 * 解析时间窗查询参数，默认当月。
 *
 * 畸形值退回默认值而非报错 —— 管理员手敲 URL 时打错一个字符，
 * 应当看到当月数据而不是一条参数校验错误。
 *
 * 但**起止顺序颠倒要报错**：`from > to` 会让查询返回空，
 * 管理员会以为「这个月没人用」，而实际是参数写反了。
 */
export function parseWindow(
	params: URLSearchParams,
	now: () => number,
): { ok: true; window: { from: number; to: number } } | { ok: false; reason: string } {
	const parse = (raw: string | null): number | undefined => {
		if (raw === null || raw.trim() === "") return undefined;
		// 同时接受毫秒时间戳与 YYYY-MM-DD
		const asNumber = Number(raw);
		if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
		const asDate = Date.parse(raw);
		return Number.isNaN(asDate) ? undefined : asDate;
	};

	const at = new Date(now());
	const defaultFrom = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
	const defaultTo = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);

	const from = parse(params.get("from")) ?? defaultFrom;
	const to = parse(params.get("to")) ?? defaultTo;

	if (from >= to) {
		return {
			ok: false,
			reason: "起始时间必须早于结束时间。参数格式为毫秒时间戳或 YYYY-MM-DD",
		};
	}
	return { ok: true, window: { from, to } };
}

/**
 * 构造请求处理器。
 *
 * 路由表：
 *   GET  /healthz                      存活探测（不鉴权）
 *   GET  /、/desktop/*、/mobile/*、/assets/*   同源静态前端（不鉴权）
 *   GET  /api/me                       当前身份
 *   GET  /api/scenarios                可见场景卡
 *   POST /api/files                    上传输入文件（multipart）
 *   GET  /api/tasks                    任务列表
 *   POST /api/tasks                    提交任务
 *   GET  /api/tasks/:id                任务详情
 *   POST /api/tasks/:id/steer          执行中插话
 *   POST /api/tasks/:id/cancel         取消
 *   POST /api/tasks/:id/confirm        确认高危动作
 *   POST /api/tasks/:id/reject         拒绝（取消）
 *   GET  /api/tasks/:id/artifacts/:n   下载产物（凭一次性 query ticket）
 *   POST /api/tasks/:id/artifacts/:n/ticket  产物下载票据
 *   POST /api/files/:name/ticket       资料下载票据
 *   POST /api/events/ticket            SSE 订阅票据
 *   GET  /api/events                   SSE 事件流（凭一次性 query ticket）
 */
export function createApp(deps: AppDeps, options: AppOptions = {}) {
	const now = options.now ?? (() => Date.now());

	return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const path = segments(url.pathname);
		const method = req.method ?? "GET";

		/**
		 * 存活探测不鉴权。
		 *
		 * 放在鉴权之前：Compose 的 healthcheck 与负载均衡的探测都不带凭证，
		 * 要求鉴权会让容器被判定为不健康而反复重启。
		 */
		if (method === "GET" && path.length === 1 && path[0] === "healthz") {
			sendJson(res, 200, { status: "ok" });
			return;
		}

		/**
		 * 同源静态前端。**必须在鉴权之前** —— 否则登录页自身（及其 JS/CSS）
		 * 都要带 token，用户永远进不到登录。静态目录不含任何租户数据。
		 */
		if (options.webDir !== undefined) {
			const staticResult = tryServeStatic(req, res, options.webDir, url);
			if (staticResult.handled) return;
		}

		let principal: Principal | undefined;
		try {
			principal = await deps.authenticate(req);
		} catch {
			// 鉴权组件自身故障不该泄漏内部错误
			sendError(res, 503, "鉴权服务暂时不可用，请稍后重试");
			return;
		}

		if (principal === undefined) {
			sendError(res, 401, "未登录或登录已过期，请重新登录");
			return;
		}
		const { tenant } = principal;
        if(method==='GET' && (url.searchParams.has('limit')||url.searchParams.has('offset')||url.searchParams.has('cursor'))) {
          try{pageOptions(url.searchParams);}catch{sendError(res,400,"分页参数无效");return;}
        }
        const listPage=(key:string, rows:readonly unknown[])=>{const {items,...meta}=paginate(rows,url.searchParams);sendJson(res,200,{[key]:items,count:meta.total,...meta});};

		// ── 当前身份（侧栏渲染、角色判入口）──
		if (method === "GET" && path.length === 2 && path[0] === "api" && path[1] === "me") {
			const models = deps.modelInfo ? deps.modelInfo() : { flagshipName: "" };
			sendJson(res, 200, {
				name: principal.name ?? tenant.userId,
				userId: tenant.userId,
				tenantId: tenant.tenantId,
				workspaceId: tenant.workspaceId,
				role: principal.role,
				roleLabel: hasRoleAtLeast(principal.role, Role.TenantAdmin) ? "租户管理员" : "成员",
				models: {
					flagship: models.flagshipName,
					lite: models.liteName ?? null,
				},
			});
			return;
		}

		// ── 场景卡列表（按租户解析自建覆盖）──
		if (method === "GET" && path.length === 2 && path[0] === "api" && path[1] === "scenarios") {
			const all = deps.listScenarios ? deps.listScenarios(tenant) : [];
			// 通用自由任务卡是「一句话入口」的隐式兜底，不作为可点选卡片列出。
			const cards = all.filter(
				(c) => (c as { id?: unknown })?.id !== GENERAL_TASK_CARD_ID,
			);
			sendJson(res, 200, { scenarios: cards });
			return;
		}

		// ── 长程任务（Job）集合：POST 建任务 / GET 列表 ──
		if (path.length === 2 && path[0] === "api" && path[1] === "jobs") {
			if (deps.createJob === undefined || deps.listJobs === undefined) {
				sendError(res, 501, "当前部署未启用长程任务");
				return;
			}
			if (method === "GET") {
				listPage("jobs", deps.listJobs(tenant));
				return;
			}
			if (method === "POST") {
				const body = await readJsonBody(req);
				if (!body.ok) { sendError(res, 400, body.reason); return; }
				const v = body.value as { title?: unknown; goal?: unknown };
				const goal = typeof v.goal === "string" ? v.goal.trim() : "";
				const title =
					typeof v.title === "string" && v.title.trim() !== ""
						? v.title.trim()
						: goal.slice(0, 24);
				if (goal === "") { sendError(res, 400, "请填写任务目标"); return; }
				try {
					const result = await deps.createJob(tenant, { title, goal });
					sendJson(res, 201, result);
				} catch (error) {
					sendError(res, 400, error instanceof Error ? error.message : "创建任务失败");
				}
				return;
			}
			sendError(res, 405, `不支持 ${method} 方法`);
			return;
		}

		// ── 单个长程任务：GET 详情（含其下会话与长期记忆）──
		if (method === "GET" && path.length === 3 && path[0] === "api" && path[1] === "jobs") {
			if (deps.getJob === undefined) { sendError(res, 501, "当前部署未启用长程任务"); return; }
			const job = deps.getJob(tenant, path[2] as string);
			if (job === undefined) { sendError(res, 404, "任务不存在"); return; }
			sendJson(res, 200, job);
			return;
		}

		// ── 技能：GET 列表 / POST 上传新建 ──
		if (path.length === 2 && path[0] === "api" && path[1] === "skills") {
			if (deps.listSkills === undefined || deps.createSkill === undefined) {
				sendError(res, 501, "当前部署未启用技能"); return;
			}
			if (method === "GET") { listPage("skills", deps.listSkills(tenant)); return; }
			if (method === "POST") {
				const body = await readJsonBody(req);
				if (!body.ok) { sendError(res, 400, body.reason); return; }
				const v = body.value as { name?: unknown; description?: unknown; content?: unknown };
				const name = typeof v.name === "string" ? v.name.trim() : "";
				const description = typeof v.description === "string" ? v.description.trim() : "";
				const content = typeof v.content === "string" ? v.content.trim() : "";
				if (!name || !content) { sendError(res, 400, "技能名称与指令内容必填"); return; }
				try {
					sendJson(res, 201, await deps.createSkill(tenant, {
						name, description: description || "自定义技能", content,
					}));
				} catch (error) {
					sendError(res, 400, error instanceof Error ? error.message : "创建技能失败");
				}
				return;
			}
			sendError(res, 405, `不支持 ${method} 方法`); return;
		}

		// ── 智能体：GET 列表 / POST 上传新建 ──
		if (path.length === 2 && path[0] === "api" && path[1] === "agents") {
			if (deps.listAgents === undefined || deps.createAgent === undefined) {
				sendError(res, 501, "当前部署未启用智能体"); return;
			}
			if (method === "GET") { listPage("agents", deps.listAgents(tenant)); return; }
			if (method === "POST") {
				const body = await readJsonBody(req);
				if (!body.ok) { sendError(res, 400, body.reason); return; }
				const v = body.value as {
					name?: unknown; description?: unknown; systemPrompt?: unknown; skillIds?: unknown;
				};
				const name = typeof v.name === "string" ? v.name.trim() : "";
				const description = typeof v.description === "string" ? v.description.trim() : "";
				const systemPrompt = typeof v.systemPrompt === "string" ? v.systemPrompt.trim() : "";
				const skillIds = Array.isArray(v.skillIds)
					? v.skillIds.filter((x): x is string => typeof x === "string")
					: [];
				if (!name || !systemPrompt) { sendError(res, 400, "智能体名称与系统提示词必填"); return; }
				try {
					sendJson(res, 201, await deps.createAgent(tenant, {
						name, description: description || "自定义智能体", systemPrompt, skillIds,
					}));
				} catch (error) {
					sendError(res, 400, error instanceof Error ? error.message : "创建智能体失败");
				}
				return;
			}
			sendError(res, 405, `不支持 ${method} 方法`); return;
		}

		// ── 输入文件上传（multipart，单文件）──
		if (method === "POST" && path.length === 2 && path[0] === "api" && path[1] === "files") {
			if (deps.uploadFile === undefined) {
				sendError(res, 501, "当前部署未启用文件上传");
				return;
			}
			const parsed = await parseMultipartFile(req, MAX_UPLOAD_BYTES);
			if (!parsed.ok) {
				sendError(res, 400, parsed.reason);
				return;
			}
			try {
				const info = await deps.uploadFile(tenant, {
					name: parsed.value.filename,
					bytes: parsed.value.bytes,
				});
				sendJson(res, 201, info);
			} catch (error) {
				sendError(res, 400, error instanceof Error ? error.message : "文件上传失败");
			}
			return;
		}

		// ── 资料文件列表（知识资产页资料库）──
		if (method === "GET" && path.length === 2 && path[0] === "api" && path[1] === "files") {
			if (deps.listFiles === undefined) {
				sendError(res, 501, "当前部署未启用资料库");
				return;
			}
			listPage("files", deps.listFiles(tenant));
			return;
		}

		// ── 资料下载票据：POST /api/files/:name/ticket ──
		// 走正常 Bearer 鉴权，并先做与实际下载完全相同的存在 / 边界校验，
		// 避免给一个下不了的文件发票。
		if (
			method === "POST" &&
			path.length === 4 &&
			path[0] === "api" &&
			path[1] === "files" &&
			path[3] === "ticket"
		) {
			if (deps.tickets === undefined || deps.workspaceFilePath === undefined) {
				sendError(res, 501, "当前部署未启用资料库");
				return;
			}
			const name = path[2] as string;
			if (deps.workspaceFilePath(tenant, name) === undefined) {
				sendError(res, 404, "文件不存在");
				return;
			}
			const fileTicket = deps.tickets.issue({
				kind: "download",
				principal,
				resource: ticketResource.file(name),
			});
			// 未消费票据数触顶（容量保护）：明确回 503，不能退化成空 body 的 200
			if (fileTicket === undefined) {
				sendError(res, 503, "票据签发过于频繁，请稍后再试");
				return;
			}
			sendJson(res, 200, fileTicket);
			return;
		}

		// ── 资料文件下载：GET /api/files/:name ──
		if (method === "GET" && path.length === 3 && path[0] === "api" && path[1] === "files") {
			if (deps.workspaceFilePath === undefined) {
				sendError(res, 501, "当前部署未启用资料库");
				return;
			}
			const filePath = deps.workspaceFilePath(tenant, path[2] as string);
			if (filePath === undefined) {
				sendError(res, 404, "文件不存在");
				return;
			}
			streamDownload(res, filePath, path[2] as string);
			return;
		}

		// ── SSE 订阅票据：POST /api/events/ticket ──
		// 归属校验与 GET /api/events 完全一致：带 taskId 时任务必须属于本租户。
		if (
			method === "POST" &&
			path.length === 3 &&
			path[0] === "api" &&
			path[1] === "events" &&
			path[2] === "ticket"
		) {
			if (deps.tickets === undefined) {
				sendError(res, 501, "当前部署未启用事件订阅");
				return;
			}
			const taskId = url.searchParams.get("taskId");
			if (taskId !== null && deps.getTask(tenant, taskId) === undefined) {
				sendError(res, 404, "任务不存在");
				return;
			}
			const eventsTicket = deps.tickets.issue({
				kind: "events",
				principal,
				resource: ticketResource.events(taskId),
			});
			// 未消费票据数触顶（容量保护）：明确回 503，不能退化成空 body 的 200
			if (eventsTicket === undefined) {
				sendError(res, 503, "票据签发过于频繁，请稍后再试");
				return;
			}
			sendJson(res, 200, eventsTicket);
			return;
		}

		// ── SSE 事件流 ──
		if (method === "GET" && path.length === 2 && path[0] === "api" && path[1] === "events") {
			const taskId = url.searchParams.get("taskId");
			const anchor = parseAnchor(
				req.headers["last-event-id"],
				url.searchParams.get("lastEventId"),
			);

			/**
			 * 订阅特定任务前先校验归属。
			 *
			 * 不校验的话，猜到别家的 taskId 就能收到对方的全部事件 ——
			 * 而事件里含文件路径、数据摘要这些敏感内容。
			 * SseHub 的租户过滤是第二道闸，但第一道必须在这里。
			 */
			if (taskId !== null && deps.getTask(tenant, taskId) === undefined) {
				sendError(res, 404, "任务不存在");
				return;
			}

			deps.hub.attach({
				res,
				tenantId: tenant.tenantId,
				workspaceId: tenant.workspaceId,
				taskId,
				backlog: taskId === null ? [] : deps.taskEvents(tenant, taskId, anchor),
				onClientClose: (handler) => req.on("close", handler),
			});
			return;
		}

		// ── 任务集合 ──
		if (path.length === 2 && path[0] === "api" && path[1] === "tasks") {
			if (method === "GET") {
				listPage("tasks", deps.listTasks(tenant));
				return;
			}

			if (method === "POST") {
				const body = await readJsonBody(req);
				if (!body.ok) {
					sendError(res, 400, body.reason);
					return;
				}
				const input = body.value as {
					scenarioId?: unknown;
					fields?: unknown;
					query?: unknown;
					files?: unknown;
					tier?: unknown;
					conversationId?: unknown;
					jobId?: unknown;
					skillId?: unknown;
					agentId?: unknown;
				};
				// 自由文本入口：未给 scenarioId 时允许直接给一句话 query，
				// 路由归一到内置「通用任务」卡（fields.query），让前台能一句话发起。
				let scenarioId: string;
				let fields: Record<string, unknown>;
				if (typeof input.scenarioId === "string" && input.scenarioId !== "") {
					scenarioId = input.scenarioId;
					fields =
						typeof input.fields === "object" && input.fields !== null
							? (input.fields as Record<string, unknown>)
							: {};
				} else if (typeof input.query === "string" && input.query.trim() !== "") {
					scenarioId = GENERAL_TASK_CARD_ID;
					// 自由入口的附件路径归到通用卡 attachments（文件级白名单据此授权）。
					fields = {
						query: input.query,
						...(Array.isArray(input.files) && input.files.length > 0
							? { attachments: input.files.filter((f) => typeof f === "string") }
							: {}),
					};
				} else {
					sendError(res, 400, "请输入要执行的任务（query），或指定场景（scenarioId）");
					return;
				}
				// 档位是显式选路入口：白名单校验，非法值 400；缺省旗舰。
				// 绝不把未知字符串透传给编排器，避免它落到不可预期的模型分支。
				let tier: "flagship" | "lite";
				if (input.tier === undefined) {
					tier = "flagship";
				} else if (input.tier === "flagship" || input.tier === "lite") {
					tier = input.tier;
				} else {
					sendError(res, 400, "模型档位（tier）只能是 flagship 或 lite");
					return;
				}

				// 续聊对话 id：只接受非空字符串，非法/缺失一律按新对话处理。
				const conversationId =
					typeof input.conversationId === "string" && input.conversationId.trim() !== ""
						? input.conversationId.trim()
						: undefined;
				const jobId =
					typeof input.jobId === "string" && input.jobId.trim() !== ""
						? input.jobId.trim()
						: undefined;
				const skillId =
					typeof input.skillId === "string" && input.skillId.trim() !== ""
						? input.skillId.trim()
						: undefined;
				const agentId =
					typeof input.agentId === "string" && input.agentId.trim() !== ""
						? input.agentId.trim()
						: undefined;

				try {
					// 租户来自鉴权，**绝不**从请求体取 —— 见文件头说明
					const result = await deps.submitTask(tenant, {
						...(typeof req.headers["idempotency-key"] === "string" ? { idempotencyKey: req.headers["idempotency-key"] } : {}),
						scenarioId,
						fields,
						tier,
						...(conversationId === undefined ? {} : { conversationId }),
						...(jobId === undefined ? {} : { jobId }),
						...(skillId === undefined ? {} : { skillId }),
						...(agentId === undefined ? {} : { agentId }),
					});
					sendJson(res, 202, result);
				} catch (error) {
					sendError(res, error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 400, error instanceof Error ? error.message : "任务提交失败");
				}
				return;
			}

			sendError(res, 405, `不支持 ${method} 方法`);
			return;
		}

		// ── 单个任务 ──
		if (path.length === 3 && path[0] === "api" && path[1] === "tasks" && method === "GET") {
			const task = deps.getTask(tenant, path[2] as string);
			if (task === undefined) {
				// 不存在与无权访问都回 404 —— 回 403 会泄漏「这个 id 存在」
				sendError(res, 404, "任务不存在");
				return;
			}
			sendJson(res, 200, task);
			return;
		}

		// ── 任务事件历史（首屏/断线兜底，与 SSE backlog 同源）：GET /api/tasks/:id/events ──
		if (
			method === "GET" &&
			path.length === 4 &&
			path[0] === "api" &&
			path[1] === "tasks" &&
			path[3] === "events"
		) {
			const taskId = path[2] as string;
			if (deps.getTask(tenant, taskId) === undefined) {
				sendError(res, 404, "任务不存在");
				return;
			}
			const after = parseAnchor(undefined, url.searchParams.get("afterSeq"));
			sendJson(res, 200, { events: deps.taskEvents(tenant, taskId, after) });
			return;
		}

		// ── 产物下载票据：POST /api/tasks/:id/artifacts/:name/ticket ──
		if (
			method === "POST" &&
			path.length === 6 &&
			path[0] === "api" &&
			path[1] === "tasks" &&
			path[3] === "artifacts" &&
			path[5] === "ticket"
		) {
			if (deps.tickets === undefined || deps.artifactPath === undefined) {
				sendError(res, 501, "当前部署未启用产物下载");
				return;
			}
			const taskId = path[2] as string;
			const name = path[4] as string;
			if (deps.getTask(tenant, taskId) === undefined) {
				sendError(res, 404, "任务不存在");
				return;
			}
			if (deps.artifactPath(tenant, taskId, name) === undefined) {
				sendError(res, 404, "产物不存在");
				return;
			}
			const artifactTicket = deps.tickets.issue({
				kind: "download",
				principal,
				resource: ticketResource.artifact(taskId, name),
			});
			// 未消费票据数触顶（容量保护）：明确回 503，不能退化成空 body 的 200
			if (artifactTicket === undefined) {
				sendError(res, 503, "票据签发过于频繁，请稍后再试");
				return;
			}
			sendJson(res, 200, artifactTicket);
			return;
		}

		// ── 产物下载：GET /api/tasks/:id/artifacts/:name ──
		if (
			method === "GET" &&
			path.length === 5 &&
			path[0] === "api" &&
			path[1] === "tasks" &&
			path[3] === "artifacts"
		) {
			if (deps.artifactPath === undefined) {
				sendError(res, 501, "当前部署未启用产物下载");
				return;
			}
			const taskId = path[2] as string;
			const name = path[4] as string;
			if (deps.getTask(tenant, taskId) === undefined) {
				sendError(res, 404, "任务不存在");
				return;
			}
			const filePath = deps.artifactPath(tenant, taskId, name);
			if (filePath === undefined) {
				// 不存在 / 越界 / 不属于该任务，一律 404，不区分
				sendError(res, 404, "产物不存在");
				return;
			}
			streamDownload(res, filePath, name);
			return;
		}

		// ── 任务动作 ──
		if (path.length === 4 && path[0] === "api" && path[1] === "tasks" && method === "POST") {
			const taskId = path[2] as string;
			const action = path[3];

			if (deps.getTask(tenant, taskId) === undefined) {
				sendError(res, 404, "任务不存在");
				return;
			}

			const body = await readJsonBody(req);
			if (!body.ok) {
				sendError(res, 400, body.reason);
				return;
			}
			const payload = body.value as { text?: unknown; reason?: unknown; actionId?: unknown };
			if (payload.actionId !== undefined && (typeof payload.actionId !== "string" || payload.actionId.trim() === "")) { sendError(res, 400, "actionId 无效"); return; }

			try {
				if (action === "steer") {
					if (typeof payload.text !== "string" || payload.text.trim() === "") {
						sendError(res, 400, "插话内容不能为空");
						return;
					}
					await deps.steerTask(tenant, taskId, payload.text);
					/**
					 * 口径固定：**已插入，将在当前步骤完成后送达**。
					 *
					 * 内核的 steering 永不打断执行中的工具。回「已打断」
					 * 是无法兑现的承诺，用户会以为当前动作已停止。
					 */
					sendJson(res, 202, {
						delivery: "queued_after_current_step",
						message: "已收到，将在当前步骤完成后送达",
					});
					return;
				}

				if (action === "cancel") {
					const reason = typeof payload.reason === "string" ? payload.reason : "用户取消";
					await deps.cancelTask(tenant, taskId, reason);
					sendJson(res, 200, { status: "cancelled" });
					return;
				}

				if (action === "confirm") {
					if (deps.confirmTask === undefined) {
						sendError(res, 501, "当前部署未启用动作确认");
						return;
					}
					await deps.confirmTask(tenant, taskId, payload.actionId as string | undefined);
					sendJson(res, 200, { status: "confirmed" });
					return;
				}

				if (action === "reject") {
					if (deps.rejectTask === undefined) {
						sendError(res, 501, "当前部署未启用动作确认");
						return;
					}
					const reason = typeof payload.reason === "string" && payload.reason.trim() !== ""
						? payload.reason
						: "用户拒绝了该高危动作";
					await deps.rejectTask(tenant, taskId, reason, payload.actionId as string | undefined);
					sendJson(res, 200, { status: "rejected" });
					return;
				}
			} catch (error) {
				sendError(res, 409, error instanceof Error && /Runner|runner/.test(error.message) ? "任务已结束，无法操作，请发起新消息或重新执行" : error instanceof Error ? error.message : "操作失败");
				return;
			}

			sendError(res, 404, `未知的操作：${action}`);
			return;
		}

		// ── 管理接口（仅租户管理员）──
		if (path.length >= 2 && path[0] === "api" && path[1] === "admin") {
			/**
			 * 权限在这里统一判，不在每个子路由里各判一次。
			 *
			 * 分散判权的问题是「新增一个管理接口忘了加判断」——
			 * 而那个疏漏的后果是普通成员能看到全租户的用量与审计日志。
			 */
			if (!hasRoleAtLeast(principal.role, Role.TenantAdmin)) {
				// 回 403 而非 404：管理员入口是公开知识，藏不住也没必要藏。
				// 但要说清是权限问题，否则管理员会以为功能没部署
				sendError(res, 403, "需要租户管理员权限。若你确认应当有权限，请联系平台管理员");
				return;
			}

			const window = parseWindow(url.searchParams, now);
			if (!window.ok) {
				sendError(res, 400, window.reason);
				return;
			}

			if (method === "GET" && path[2] === "usage") {
				if (deps.usageDashboard === undefined) {
					sendError(res, 501, "当前部署未启用用量看板");
					return;
				}
				sendJson(res, 200, await deps.usageDashboard(tenant, window.window));
				return;
			}

			if (method === "GET" && path[2] === "audit") {
				if (deps.auditLog === undefined) {
					sendError(res, 501, "当前部署未启用审计查询");
					return;
				}
				const entries = await deps.auditLog(tenant, window.window);
				listPage("entries", entries);
				return;
			}

			if (method === "GET" && path[2] === "tasks") {
				// 管理员看全工作区的任务，而成员只看自己工作区的
				listPage("tasks", deps.listTasks(tenant));
				return;
			}

			sendError(res, 404, `未知的管理接口：${path.slice(2).join("/")}`);
			return;
		}

		sendError(res, 404, "接口不存在");
	};
}
