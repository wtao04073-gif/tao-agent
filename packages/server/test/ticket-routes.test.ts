/**
 * 票据化下载 / SSE 的 HTTP 端到端测试
 *
 * 与 main.ts 同一套语义装配：Bearer 走账号，无 Bearer 时仅 SSE/下载三类 GET
 * 凭一次性 ?ticket= 通过（由 createApp 的 /ticket 接口用 Bearer 签发）。
 *
 * 覆盖：
 *  - 长期 access_token 出现在 URL 不再被接受（回 401）；
 *  - 签发接口要 Bearer、且先做归属/存在校验（不存在 404）；
 *  - 票据可完成一次下载/SSE 建连，复用即 401；
 *  - 跨用途、跨资源票据被拒；
 *  - SSE 建连后票据已消耗，连接本身仍能建立（200）。
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Role, type TenantContext } from "@tao/core";
import { createApp, SseHub, ticketResource, type AppDeps, type Principal } from "../src/index.ts";
import { TicketService } from "../src/tickets.ts";

const TENANT: TenantContext = { tenantId: "univ-1", workspaceId: "office", userId: "sun" };
const MEMBER: Principal = { tenant: TENANT, role: Role.Member, name: "孙" };
const servers: Server[] = [];
const hubs: SseHub[] = [];

afterEach(async () => {
	for (const h of hubs.splice(0)) h.closeAll();
	for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function serve(ticketOptions: ConstructorParameters<typeof TicketService>[0] = {}): Promise<{ port: number; tickets: TicketService; filePath: string; artPath: string }> {
	const hub = new SseHub();
	hubs.push(hub);
	const tickets = new TicketService(ticketOptions);
	const dir = mkdtempSync(join(tmpdir(), "tao-tk-"));
	const filePath = join(dir, "资料.txt");
	const artPath = join(dir, "报告.xlsx");
	writeFileSync(filePath, "file-bytes");
	writeFileSync(artPath, "artifact-bytes");

	// 与 main.ts 一致的鉴权：Bearer 精确通过；无 Bearer 时仅票据通道消费一次性票
	const authenticate = async (req: import("node:http").IncomingMessage): Promise<Principal | undefined> => {
		const auth = req.headers.authorization;
		const bearer = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "").trim() : "";
		if (bearer === "t") return MEMBER;
		try {
			const u = new URL(req.url ?? "", "http://localhost");
			const decode = (s: string): string => {
				try { return decodeURIComponent(s); } catch { return s; }
			};
			const seg = u.pathname.split("/").filter(Boolean).map(decode);
			if (seg[0] !== "api") return undefined;
			let kind: "events" | "download" | undefined;
			let resource: string | null = null;
			if (seg[1] === "events" && seg.length === 2) {
				kind = "events";
				resource = ticketResource.events(u.searchParams.get("taskId"));
			} else if (seg[1] === "tasks" && seg[3] === "artifacts" && seg.length === 5) {
				kind = "download";
				resource = ticketResource.artifact(seg[2] as string, seg[4] as string);
			} else if (seg[1] === "files" && seg.length === 3) {
				kind = "download";
				resource = ticketResource.file(seg[2] as string);
			}
			if (kind === undefined) return undefined;
			const ticket = (u.searchParams.get("ticket") ?? "").trim();
			return ticket === "" ? undefined : tickets.consume({ kind, ticket, resource });
		} catch {
			return undefined;
		}
	};

	const deps: AppDeps = {
		authenticate,
		hub,
		tickets,
		taskEvents: () => [],
		listTasks: () => [],
		getTask: (_t, id) => (id === "t-1" ? { taskId: "t-1", artifacts: [artPath] } : undefined),
		submitTask: async () => ({ taskId: "new" }),
		steerTask: async () => {},
		cancelTask: async () => {},
		workspaceFilePath: (_t, name) => (name === "资料.txt" ? filePath : undefined),
		artifactPath: (_t, id, name) => (id === "t-1" && name === "报告.xlsx" ? artPath : undefined),
	};
	const app = createApp(deps);
	const server = createServer((req, res) => void app(req, res));
	servers.push(server);
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			const a = server.address();
			resolve({ port: typeof a === "object" && a ? a.port : 0, tickets, filePath, artPath });
		}),
	);
}

async function req(port: number, path: string, init: RequestInit = {}) {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		headers: { ...(init.method === "POST" ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
		...init,
	});
	const text = await res.text();
	let body: Record<string, unknown> = {};
	try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
	return { status: res.status, body, text, res };
}

describe("票据化下载 / SSE", () => {
	it("资料下载：URL 里的长期 access_token 不再被接受", async () => {
		const { port } = await serve();
		const r = await req(port, `/api/files/${encodeURIComponent("资料.txt")}?access_token=t`);
		expect(r.status).toBe(401);
	});

	it("无 Bearer 不能签发票据", async () => {
		const { port } = await serve();
		const r = await req(port, `/api/files/${encodeURIComponent("资料.txt")}/ticket`, { method: "POST" });
		expect(r.status).toBe(401);
	});

	it("资料：Bearer 换票 → 一次性 ?ticket 下载成功 → 复用 401", async () => {
		const { port } = await serve();
		const issued = await req(port, `/api/files/${encodeURIComponent("资料.txt")}/ticket`, {
			method: "POST",
			headers: { Authorization: "Bearer t" },
			body: "{}",
		});
		expect(issued.status).toBe(200);
		const ticket = String(issued.body.ticket);
		expect(typeof issued.body.expiresInSec).toBe("number");

		const dl = await req(port, `/api/files/${encodeURIComponent("资料.txt")}?ticket=${encodeURIComponent(ticket)}`);
		expect(dl.status).toBe(200);
		expect(dl.text).toBe("file-bytes");

		const again = await req(port, `/api/files/${encodeURIComponent("资料.txt")}?ticket=${encodeURIComponent(ticket)}`);
		expect(again.status).toBe(401);
	});

	it("给不存在的资料发票 → 404", async () => {
		const { port } = await serve();
		const r = await req(port, "/api/files/nope.txt/ticket", {
			method: "POST", headers: { Authorization: "Bearer t" }, body: "{}",
		});
		expect(r.status).toBe(404);
	});

	it("产物：Bearer 换票 → ?ticket 下载；任务/产物不存在 → 404", async () => {
		const { port } = await serve();
		const ok = await req(port, `/api/tasks/t-1/artifacts/${encodeURIComponent("报告.xlsx")}/ticket`, {
			method: "POST", headers: { Authorization: "Bearer t" }, body: "{}",
		});
		expect(ok.status).toBe(200);
		const ticket = String(ok.body.ticket);
		const dl = await req(port, `/api/tasks/t-1/artifacts/${encodeURIComponent("报告.xlsx")}?ticket=${encodeURIComponent(ticket)}`);
		expect(dl.status).toBe(200);
		expect(dl.text).toBe("artifact-bytes");

		const otherTask = await req(port, "/api/tasks/t-x/artifacts/x/ticket", {
			method: "POST", headers: { Authorization: "Bearer t" }, body: "{}",
		});
		expect(otherTask.status).toBe(404);
		const missingArt = await req(port, "/api/tasks/t-1/artifacts/nope/ticket", {
			method: "POST", headers: { Authorization: "Bearer t" }, body: "{}",
		});
		expect(missingArt.status).toBe(404);
	});

	it("跨资源拒绝：资料票据不能下产物，且票据被作废", async () => {
		const { port } = await serve();
		const issued = await req(port, `/api/files/${encodeURIComponent("资料.txt")}/ticket`, {
			method: "POST", headers: { Authorization: "Bearer t" }, body: "{}",
		});
		const ticket = String(issued.body.ticket);
		const cross = await req(port, `/api/tasks/t-1/artifacts/${encodeURIComponent("报告.xlsx")}?ticket=${encodeURIComponent(ticket)}`);
		expect(cross.status).toBe(401);
		// 原资源也无法再用这张票
		const original = await req(port, `/api/files/${encodeURIComponent("资料.txt")}?ticket=${encodeURIComponent(ticket)}`);
		expect(original.status).toBe(401);
	});

	it("SSE：Bearer 换票（归属校验）→ ?ticket 能建立事件流；非法任务 404", async () => {
		const { port } = await serve();
		const bad = await req(port, "/api/events/ticket?taskId=t-other", {
			method: "POST", headers: { Authorization: "Bearer t" }, body: "{}",
		});
		expect(bad.status).toBe(404);

		const issued = await req(port, "/api/events/ticket", {
			method: "POST", headers: { Authorization: "Bearer t" }, body: "{}",
		});
		expect(issued.status).toBe(200);
		const ticket = String(issued.body.ticket);

		// 票据只在建连那一下使用；建立后连接持续（读状态后即取消）
		const res = await fetch(`http://127.0.0.1:${port}/api/events?ticket=${encodeURIComponent(ticket)}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		await res.body?.cancel();

		// 票据已消耗，不能再建第二个连接
		const reuse = await fetch(`http://127.0.0.1:${port}/api/events?ticket=${encodeURIComponent(ticket)}`);
		expect(reuse.status).toBe(401);
		await reuse.body?.cancel();
	});

	it("SSE 票据不能用于下载（跨用途拒绝）", async () => {
		const { port } = await serve();
		const issued = await req(port, "/api/events/ticket", {
			method: "POST", headers: { Authorization: "Bearer t" }, body: "{}",
		});
		const ticket = String(issued.body.ticket);
		const r = await req(port, `/api/files/${encodeURIComponent("资料.txt")}?ticket=${encodeURIComponent(ticket)}`);
		expect(r.status).toBe(401);
	});

	it("未消费票据触顶：三类签发接口都回 503，而非空 body 的 200", async () => {
		// 单身份未消费上限设为 1：先用掉唯一名额且不消费，随后签发应被容量闸拒绝
		const { port, tickets } = await serve({ maxActiveTicketsPerPrincipal: 1 });
		const seeded = tickets.issue({ kind: "events", principal: MEMBER, resource: null });
		expect(seeded).toBeDefined();

		const fileTicket = await req(port, `/api/files/${encodeURIComponent("资料.txt")}/ticket`, {
			method: "POST", headers: { Authorization: "Bearer t" }, body: "{}",
		});
		expect(fileTicket.status).toBe(503);
		expect(fileTicket.body.ticket).toBeUndefined();

		const eventsTicket = await req(port, "/api/events/ticket", {
			method: "POST", headers: { Authorization: "Bearer t" }, body: "{}",
		});
		expect(eventsTicket.status).toBe(503);
		expect(eventsTicket.body.ticket).toBeUndefined();

		const artifactTicket = await req(port, `/api/tasks/t-1/artifacts/${encodeURIComponent("报告.xlsx")}/ticket`, {
			method: "POST", headers: { Authorization: "Bearer t" }, body: "{}",
		});
		expect(artifactTicket.status).toBe(503);
		expect(artifactTicket.body.ticket).toBeUndefined();
	});
});
