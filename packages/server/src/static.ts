/**
 * 同源静态文件托管（M5-3 Web 前端）
 *
 * 只用 Node 内置 fs/path/http —— 延续 server「零第三方运行时依赖」的纪律
 * （私有化环境可能没有 npm 源）。前端是纯静态 HTML/JS/CSS，由本服务同源
 * 托管，避免再开一个端口、引入跨域与额外进程。
 *
 * 安全：URL 路径不可信，必须在 resolve + 边界校验后再读盘，挡住
 * `/../../etc/passwd` 这类目录逃逸。校验失败一律 404（不回 403，
 * 不向探测者确认「这个路径存在但越界」）。
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";

/** 前端会用到的静态资源 MIME。未列出的按通用二进制下载。 */
const MIME: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};

/** 不允许被任何方式访问的扩展名（即便误放进 web 目录）。 */
const FORBIDDEN_EXT = new Set([".env", ".pem", ".key"]);

export interface StaticResult {
	/** 是否已处理该请求（命中静态文件并已响应，或已回 404）。 */
	readonly handled: boolean;
}

/**
 * 尝试把请求当作静态资源处理。
 *
 * @param rootDir 前端目录绝对路径（如 /app/web）
 * @returns handled=true 表示已响应，调用方应直接 return；false 表示交给后续路由
 */
export function tryServeStatic(
	req: IncomingMessage,
	res: ServerResponse,
	rootDir: string,
	url: URL,
): StaticResult {
	if ((req.method ?? "GET") !== "GET" && (req.method ?? "HEAD") !== "HEAD") {
		return { handled: false };
	}
	const pathname = url.pathname;
	// API 与存活探测不属静态资源
	if (pathname === "/healthz" || pathname.startsWith("/api/")) return { handled: false };

	const root = resolve(rootDir);
	// "/" 落到登录页；其余去掉前导斜杠拼到根下。
	let target: string;
	if (pathname === "/") {
		target = join(root, "login.html");
	} else {
		const decoded = decodePath(pathname);
		if (decoded === null) {
			finish404(res);
			return { handled: true };
		}
		target = normalize(join(root, decoded.replace(/^\/+/, "")));
	}

	// 边界校验：解析后的真实路径必须仍在前端根之内。
	if (target !== root && !target.startsWith(root + sep)) {
		finish404(res);
		return { handled: true };
	}
	if (FORBIDDEN_EXT.has(extname(target).toLowerCase())) {
		finish404(res);
		return { handled: true };
	}

	let filePath = target;
	try {
		const st = statSync(filePath);
		if (st.isDirectory()) {
			// 目录不开放列举，落到其 index.html；本站无目录式页面，缺失即 404
			filePath = join(target, "index.html");
			if (!existsSync(filePath)) {
				finish404(res);
				return { handled: true };
			}
		} else if (!st.isFile()) {
			finish404(res);
			return { handled: true };
		}
	} catch {
		finish404(res);
		return { handled: true };
	}

	const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
	res.writeHead(200, {
		"Content-Type": mime,
		"Cache-Control": "no-cache",
		"X-Content-Type-Options": "nosniff",
	});
	if (req.method === "HEAD") {
		res.end();
		return { handled: true };
	}
	const stream = createReadStream(filePath);
	stream.on("error", () => {
		if (!res.headersSent) finish404(res);
		else res.end();
	});
	stream.pipe(res);
	return { handled: true };
}

/** 解码 URL 路径；畸形百分号编码返回 null（交给 404，不把原始串拼进文件路径）。 */
function decodePath(pathname: string): string | null {
	try {
		return decodeURIComponent(pathname);
	} catch {
		return null;
	}
}

function finish404(res: ServerResponse): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
	res.end("Not Found");
}

/**
 * 定位前端目录。
 *
 * 入口在 `<root>/packages/server/dist/main.js`：从其所在目录
 * `…/packages/server/dist` 上溯三级（dist→server→packages→root）到应用根，
 * 再拼 `web`。生产镜像根为 /app（→ /app/web），开发态根为仓库根（→ repo/web），
 * 两种布局同构。允许 WEB_DIR 显式覆盖；都探测不到则返回 undefined（仅提供 API）。
 */
export function resolveWebDir(override: string | undefined, entryFile: string): string | undefined {
	const distDir = dirname(entryFile);
	const candidates = [override, join(distDir, "..", "..", "..", "web")]
		.filter((p): p is string => typeof p === "string" && p !== "");
	for (const dir of candidates) {
		try {
			if (statSync(join(dir, "login.html")).isFile()) return resolve(dir);
		} catch {
			// 试下一个候选
		}
	}
	return undefined;
}
