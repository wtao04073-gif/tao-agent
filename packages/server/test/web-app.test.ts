/**
 * M5-3 Web 支撑接口测试
 *
 * 覆盖：同源静态托管（含路径穿越防护）、/api/me、场景卡、multipart 上传、
 * 产物/资料下载、确认/拒绝。鉴权与隔离沿用 app.test.ts 的断言重点。
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, SseHub, type AppDeps, type Principal } from "../src/index.ts";
import { Role, type TaskEvent, type TenantContext } from "@tao/core";

const TENANT: TenantContext = { tenantId: "univ-010", workspaceId: "office", userId: "sun" };
const servers: Server[] = [];
const hubs: SseHub[] = [];

afterEach(async () => {
	for (const h of hubs.splice(0)) h.closeAll();
	for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

function makeWebDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tao-web-"));
	writeFileSync(join(dir, "login.html"), "<!doctype html><title>登录</title>");
	mkdirSync(join(dir, "assets"));
	writeFileSync(join(dir, "assets", "core.js"), "window.ok=1");
	return dir;
}

const ANON = Symbol("anon");
interface ServeOpts {
	webDir?: string;
	deps?: Partial<AppDeps>;
	principal?: Principal | undefined | typeof ANON;
}
async function serve(opts: ServeOpts = {}): Promise<number> {
	const hub = new SseHub();
	hubs.push(hub);
	const member: Principal = { tenant: TENANT, role: Role.Member, name: "孙老师" };
	const authed = opts.principal === undefined ? member : opts.principal;
	const base: AppDeps = {
		authenticate: async () => (authed === ANON ? undefined : (authed as Principal)),
		hub,
		taskEvents: () => [] as TaskEvent[],
		listTasks: () => [{ taskId: "t-1", status: "SUCCEEDED", artifacts: ["/ws/报告.xlsx"] }],
		getTask: (_t, id) =>
			id === "t-1" ? { taskId: "t-1", status: "SUCCEEDED", artifacts: ["/ws/报告.xlsx"] } : undefined,
		submitTask: async () => ({ taskId: "new" }),
		steerTask: async () => {},
		cancelTask: async () => {},
		...opts.deps,
	};
	const app = createApp(base, opts.webDir === undefined ? {} : { webDir: opts.webDir });
	const server = createServer((req, res) => void app(req, res));
	servers.push(server);
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			const a = server.address();
			resolve(typeof a === "object" && a ? a.port : 0);
		}),
	);
}

async function get(port: number, path: string, init: RequestInit = {}) {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		headers: { Authorization: "Bearer t", ...(init.headers ?? {}) },
		...init,
	});
	return { status: res.status, text: await res.text(), headers: res.headers };
}

describe("同源静态托管", () => {
	it("登录页与资源在鉴权前可访问", async () => {
		const dir = makeWebDir();
		const port = await serve({ webDir: dir });
		const login = await get(port, "/", { headers: {} });
		expect(login.status).toBe(200);
		expect(login.text).toContain("登录");
		const js = await get(port, "/assets/core.js", { headers: {} });
		expect(js.status).toBe(200);
		expect(js.headers.get("content-type")).toContain("javascript");
	});

	it("目录穿越被挡（404，不读到 web 目录外文件）", async () => {
		const dir = makeWebDir();
		const port = await serve({ webDir: dir });
		const evil = await get(port, "/../../../../etc/passwd", { headers: {} });
		expect(evil.status).toBe(404);
	});

	it("未配置 webDir 时，根路径不被静态处理而走鉴权（401）", async () => {
		const port = await serve({ principal: ANON });
		const r = await get(port, "/", { headers: {} });
		expect(r.status).toBe(401);
	});
});

describe("/api/me 与场景卡", () => {
	it("/api/me 返回身份与中文角色", async () => {
		const port = await serve();
		const r = await get(port, "/api/me");
		expect(r.status).toBe(200);
		const body = JSON.parse(r.text);
		expect(body.name).toBe("孙老师");
		expect(body.userId).toBe("sun");
		expect(body.roleLabel).toBe("成员");
	});

	it("场景卡由依赖返回", async () => {
		const port = await serve({ deps: { listScenarios: () => [{ id: "mfg.8d-report", title: "8D" }] } });
		const r = await get(port, "/api/scenarios");
		expect(r.status).toBe(200);
		expect(JSON.parse(r.text).scenarios[0].id).toBe("mfg.8d-report");
	});
});

describe("multipart 上传", () => {
	it("上传单文件落工作区并回绝对路径", async () => {
		let receivedName = "";
		const port = await serve({
			deps: {
				uploadFile: async (_tenant, file) => {
					receivedName = file.name;
					return { name: file.name, path: `/ws/${file.name}`, sizeBytes: file.bytes.length };
				},
			},
		});
		const form = new FormData();
		form.append("file", new Blob(["hello"], { type: "text/plain" }), "对账单.txt");
		const res = await fetch(`http://127.0.0.1:${port}/api/files`, {
			method: "POST",
			headers: { Authorization: "Bearer t" },
			body: form,
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.path).toBe("/ws/对账单.txt");
		expect(body.sizeBytes).toBe(5);
		expect(receivedName).toBe("对账单.txt");
	});

	it("文件名带路径分隔符时只取 basename", async () => {
		let got = "";
		const port = await serve({
			deps: { uploadFile: async (_t, f) => { got = f.name; return { name: f.name, path: "/x", sizeBytes: 1 }; } },
		});
		const form = new FormData();
		form.append("file", new Blob(["x"]), "../../etc/passwd");
		await fetch(`http://127.0.0.1:${port}/api/files`, {
			method: "POST", headers: { Authorization: "Bearer t" }, body: form,
		});
		expect(got).toBe("passwd");
	});
});

describe("产物下载", () => {
	it("登记在任务产物里的文件可下载，越界名 404", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tao-dl-"));
		const real = join(dir, "报告.xlsx");
		writeFileSync(real, "PKfake");
		const port = await serve({
			deps: {
				getTask: () => ({ taskId: "t-1", artifacts: [real] }),
				artifactPath: (_tenant, _id, name) => (name === "报告.xlsx" ? real : undefined),
			},
		});
		const ok = await get(port, `/api/tasks/t-1/artifacts/${encodeURIComponent("报告.xlsx")}`);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-disposition")).toContain("attachment");
		const bad = await get(port, "/api/tasks/t-1/artifacts/..%2f..%2fetc%2fpasswd");
		expect(bad.status).toBe(404);
	});
});

describe("确认 / 拒绝动作", () => {
	it("confirm 与 reject 分别推进编排器", async () => {
		const calls: string[] = [];
		const port = await serve({
			deps: {
				confirmTask: async () => { calls.push("confirm"); },
				rejectTask: async () => { calls.push("reject"); },
			},
		});
		const c = await fetch(`http://127.0.0.1:${port}/api/tasks/t-1/confirm`, {
			method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: "{}",
		});
		expect(c.status).toBe(200);
		const rj = await fetch(`http://127.0.0.1:${port}/api/tasks/t-1/reject`, {
			method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "不行" }),
		});
		expect(rj.status).toBe(200);
		expect(calls).toEqual(["confirm", "reject"]);
	});
});
