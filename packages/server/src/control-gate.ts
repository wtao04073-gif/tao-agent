import type { IncomingMessage, ServerResponse } from "node:http";
import { join, normalize, posix, relative, resolve, sep } from "node:path";
import { Role } from "@tao/core";
import type { Principal } from "./app.ts";
import { tryServeStatic } from "./static.ts";

export interface ControlGateOptions {
	readonly webDir?: string | undefined;
	readonly authenticate: (req: IncomingMessage) => Promise<Principal | undefined>;
}

/** 必须在公共静态处理器之前调用，CSS/JS 等资源同样需要管理员身份。 */
export async function handleControlGate(
	req: IncomingMessage,
	res: ServerResponse,
	options: ControlGateOptions,
): Promise<boolean> {
	let url: URL;
	let decoded: string;
	try {
		url = new URL(req.url ?? "/", "http://localhost");
		decoded = decodeURIComponent(url.pathname);
	} catch {
		respond(req, res, 400, "请求路径无效");
		return true;
	}
	// 与 static.ts 使用相同的解码和磁盘路径规范化，覆盖编码、目录折叠，
	// 以及先退出 webDir 再进入的路径别名。不能仅检查 URL.pathname 前缀。
	let pathname = posix.normalize("/" + decoded.replace(/^\/+/, ""));
	if (options.webDir) {
		const root = resolve(options.webDir);
		const target = normalize(join(root, decoded.replace(/^\/+/, "")));
		if (target === root || target.startsWith(root + sep)) {
			pathname = "/" + relative(root, target).split(sep).join("/");
			if (decoded.endsWith("/") && !pathname.endsWith("/")) pathname += "/";
		}
	}
	const legacy = pathname === "/desktop/admin.html" || pathname === "/desktop/admin.html/";
	const control = pathname === "/control" || pathname.startsWith("/control/");
	if (!legacy && !control) return false;

	res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
	res.setHeader("Referrer-Policy", "same-origin");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Vary", "Cookie, Authorization");
	let principal: Principal | undefined;
	try {
		principal = await options.authenticate(req);
	} catch {
		respond(req, res, 503, "暂时无法验证身份，请稍后重试");
		return true;
	}
	if (!principal) {
		respond(req, res, 401, "请先登录管理员账号");
		return true;
	}
	if (principal.role !== Role.TenantAdmin && principal.role !== Role.PlatformAdmin) {
		respond(req, res, 403, "需要租户管理员或平台管理员权限，请联系管理员");
		return true;
	}
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.setHeader("Allow", "GET, HEAD");
		respond(req, res, 405, "此入口仅支持页面访问");
		return true;
	}
	if (legacy || pathname === "/control") {
		res.writeHead(302, { Location: "/control/" });
		res.end();
		return true;
	}
	if (!options.webDir) {
		respond(req, res, 404, "管控平台页面尚未部署");
		return true;
	}
	// 传入已规范化的路径，每段恰好编码一次，由静态处理器解码一次。
	url.pathname = pathname.split("/").map(encodeURIComponent).join("/");
	if (!tryServeStatic(req, res, options.webDir, url).handled) {
		respond(req, res, 404, "页面不存在");
	}
	return true;
}

function respond(req: IncomingMessage, res: ServerResponse, status: number, message: string): void {
	// 消息均为服务端固定文案，不包含请求输入。
	res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
	res.end(req.method === "HEAD" ? undefined : `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>管控平台</title><h1>${status}</h1><p>${message}</p><p><a href="/admin-login.html">前往登录</a> · <a href="/chat.html">返回工作区</a></p></html>`);
}
