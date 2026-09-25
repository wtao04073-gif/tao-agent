/**
 * SSE 事件下发测试
 *
 * 用真实的 `http.Server` 而非 mock。SSE 的坑几乎都在真实 socket 行为上
 * （响应头 flush、反代缓冲、断开感知），mock 出来的 `ServerResponse`
 * 会让这些全部测不到 —— [Spike 7](../../../spikes/07-sse-delivery/) 里
 * `flushHeaders` 那个缺陷就是只有真连接才暴露的。
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parseAnchor, SseHub, toSseFrame } from "../src/index.ts";
import type { TaskEvent, TenantContext } from "@tao/core";

const TENANT: TenantContext = { tenantId: "univ-007", workspaceId: "office", userId: "qian" };
const OTHER: TenantContext = { tenantId: "other-univ", workspaceId: "office", userId: "x" };

const servers: Server[] = [];
const hubs: SseHub[] = [];

afterEach(async () => {
	for (const h of hubs.splice(0)) h.closeAll();
	for (const s of servers.splice(0)) {
		await new Promise<void>((resolve) => s.close(() => resolve()));
	}
});

function event(patch: Partial<TaskEvent> = {}): TaskEvent {
	return {
		eventId: "e-1",
		seq: 1,
		taskId: "t-1",
		tenant: TENANT,
		at: 1_700_000_000_000,
		type: "step",
		step: 1,
		action: "读取文件",
		phase: "started",
		...patch,
	} as TaskEvent;
}

/** 起一个用 SseHub 的服务，返回端口与 hub。 */
async function serve(options: {
	readonly backlog?: (taskId: string | null, anchor: number) => TaskEvent[];
	readonly heartbeatMs?: number;
} = {}): Promise<{ port: number; hub: SseHub }> {
	const hub = new SseHub(
		options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs },
	);
	hubs.push(hub);

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const taskId = url.searchParams.get("taskId");
		const tenantId = url.searchParams.get("tenantId") ?? TENANT.tenantId;
		const workspaceId = url.searchParams.get("workspaceId") ?? TENANT.workspaceId;
		const anchor = parseAnchor(req.headers["last-event-id"], url.searchParams.get("lastEventId"));

		hub.attach({
			res,
			tenantId,
			workspaceId,
			taskId,
			backlog: options.backlog?.(taskId, anchor) ?? [],
			onClientClose: (handler) => req.on("close", handler),
		});
	});
	servers.push(server);

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({ port, hub });
		});
	});
}

/**
 * 一个 SSE 连接，带**累积缓冲**。
 *
 * 缓冲是必需的：补发的历史事件与 `: connected` 心跳常在同一个 TCP chunk 里。
 * 若「等连接确立」时把那个 chunk 读走就丢掉，后续断言会看不到 backlog ——
 * 这不是服务端的问题，而是测试辅助函数把数据吃掉了。
 */
interface Conn {
	/** 到目前为止收到的全部内容。 */
	text: () => string;
	/** 继续读到满足条件或超时。 */
	until: (predicate: (text: string) => boolean, timeoutMs?: number) => Promise<string>;
	close: () => void;
}

/** 连上一个 SSE 端点，并等到连接确立。 */
async function connect(
	port: number,
	query = "taskId=t-1",
	headers: Record<string, string> = {},
): Promise<Conn> {
	const controller = new AbortController();
	const res = await fetch(`http://127.0.0.1:${port}/events?${query}`, {
		signal: controller.signal,
		headers,
	});
	const reader = res.body?.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const until = async (
		predicate: (text: string) => boolean,
		timeoutMs = 2000,
	): Promise<string> => {
		if (predicate(buffer)) return buffer;
		if (reader === undefined) return buffer;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const chunk = await Promise.race([
				reader.read(),
				new Promise<{ value: undefined; done: boolean }>((resolve) =>
					setTimeout(() => resolve({ value: undefined, done: false }), 100),
				),
			]);
			if (chunk.value !== undefined) buffer += decoder.decode(chunk.value);
			if (predicate(buffer)) return buffer;
		}
		return buffer;
	};

	// 等连接确立 —— 后续推送才不会打在还没接上的连接上。
	// 累积到 buffer 里，不丢弃
	await until((t) => t.includes("connected"));
	return { text: () => buffer, until, close: () => controller.abort() };
}

describe("SSE 帧格式", () => {
	it("id 用 seq，供 Last-Event-ID 重连", () => {
		const frame = toSseFrame(event({ seq: 42 }));
		expect(frame).toContain("id: 42");
	});

	it("event 字段用事件类型，前端可按类型分发", () => {
		expect(toSseFrame(event({ type: "status" } as Partial<TaskEvent>))).toContain("event: status");
	});

	it("data 是完整事件的 JSON", () => {
		const frame = toSseFrame(event({ action: "生成文档" } as Partial<TaskEvent>));
		const line = frame.split("\n").find((l) => l.startsWith("data: "));
		expect(JSON.parse(line?.slice(6) ?? "{}")).toMatchObject({ action: "生成文档" });
	});

	it("帧以空行结尾 —— 少了这个前端收不到", () => {
		// SSE 规范用空行分隔事件。漏掉的话事件会一直攒在缓冲里，
		// 表现为「前端完全收不到」而非「收到一半」
		expect(toSseFrame(event())).toMatch(/\n\n$/);
	});

	it("中文内容不被转义成不可读形式", () => {
		const frame = toSseFrame(event({ action: "核对供应商对账表" } as Partial<TaskEvent>));
		expect(frame).toContain("核对供应商对账表");
	});
});

describe("重连锚点解析", () => {
	it("取 Last-Event-ID 头", () => {
		expect(parseAnchor("5", null)).toBe(5);
	});

	it("头缺失时回退到查询参数（供非 EventSource 客户端）", () => {
		// 移动端原生与部分小程序框架不支持 EventSource，带不了这个头
		expect(parseAnchor(undefined, "7")).toBe(7);
	});

	it("头优先于查询参数", () => {
		expect(parseAnchor("5", "99")).toBe(5);
	});

	it("畸形值退化为 0，而不是 NaN", () => {
		// NaN 参与 `seq > anchor` 比较会让全部事件被过滤掉 ——
		// 比从头开始更糟，用户什么都看不到
		expect(parseAnchor("abc", null)).toBe(0);
		expect(parseAnchor("", null)).toBe(0);
		expect(parseAnchor(undefined, null)).toBe(0);
	});

	it("负数退化为 0", () => {
		expect(parseAnchor("-1", null)).toBe(0);
	});

	it("数组形式的头取第一个（Node 对重复头的表示）", () => {
		expect(parseAnchor(["3", "9"], null)).toBe(3);
	});

	it("零与非数字都按从头开始处理", () => {
		expect(parseAnchor("0", null)).toBe(0);
	});
});

describe("SSE 连接", () => {
	it("没有事件可发时连接依然立即建立", async () => {
		// 对应 Spike 7 查出的真缺陷：writeHead 只把头排队，
		// 不显式 flushHeaders 的话 fetch 在无事件时永远不 resolve
		const { port } = await serve();
		const controller = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`, {
			signal: controller.signal,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		controller.abort();
	});

	it("带 X-Accel-Buffering 头 —— 私有化部署常在 nginx 后面", async () => {
		// 不加这行反代会把 SSE 攒到连接结束才吐出，
		// 表现为「任务跑完了才看到进度」。本地开发永远复现不出来
		const { port } = await serve();
		const controller = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`, {
			signal: controller.signal,
		});
		expect(res.headers.get("x-accel-buffering")).toBe("no");
		controller.abort();
	});

	it("连接保持期间能收到推送", async () => {
		const { port, hub } = await serve();
		const conn = await connect(port);

		hub.publish(event({ seq: 1, action: "读取文件" } as Partial<TaskEvent>));
		const body = await conn.until((t) => t.includes("读取文件"));
		conn.close();

		expect(body).toContain("读取文件");
		expect(body).toContain("id: 1");
	});

	it("重连时补发断线期间的事件", async () => {
		const history = [
			event({ seq: 1, action: "第一步" } as Partial<TaskEvent>),
			event({ seq: 2, action: "第二步" } as Partial<TaskEvent>),
			event({ seq: 3, action: "第三步" } as Partial<TaskEvent>),
		];
		const { port } = await serve({
			backlog: (_taskId, anchor) => history.filter((e) => e.seq > anchor),
		});

		const conn = await connect(port, "taskId=t-1", { "Last-Event-ID": "1" });
		const body = await conn.until((t) => t.includes("第三步"));
		conn.close();

		// 补了 2、3，没重发 1
		expect(body).toContain("第二步");
		expect(body).toContain("第三步");
		expect(body).not.toContain("第一步");
	});

	it("首连拿到全部历史 —— 用户刷新页面要看到完整进度", async () => {
		const history = [
			event({ seq: 1, action: "第一步" } as Partial<TaskEvent>),
			event({ seq: 2, action: "第二步" } as Partial<TaskEvent>),
		];
		const { port } = await serve({
			backlog: (_taskId, anchor) => history.filter((e) => e.seq > anchor),
		});

		const conn = await connect(port);
		const body = await conn.until((t) => t.includes("第二步"));
		conn.close();

		expect(body).toContain("第一步");
		expect(body).toContain("第二步");
	});

	it("客户端断开后连接被清掉", async () => {
		// 清不掉会累积死连接，长跑的私有化部署会内存泄漏，
		// 而这种泄漏要跑几天才显形
		const { port, hub } = await serve();
		const conn = await connect(port);
		expect(hub.connectionCount).toBe(1);

		conn.close();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(hub.connectionCount).toBe(0);
	});

	it("closeAll 清空全部连接", async () => {
		const { port, hub } = await serve();
		await connect(port);
		await connect(port, "taskId=t-2");
		expect(hub.connectionCount).toBe(2);

		hub.closeAll();
		expect(hub.connectionCount).toBe(0);
	});
});

describe("SSE 投递范围", () => {
	it("订阅特定任务只收该任务的事件", async () => {
		const { port, hub } = await serve();
		const conn = await connect(port, "taskId=t-1");

		hub.publish(event({ taskId: "t-2", action: "别的任务" } as Partial<TaskEvent>));
		hub.publish(event({ taskId: "t-1", action: "我的任务" } as Partial<TaskEvent>));

		const body = await conn.until((t) => t.includes("我的任务"));
		conn.close();

		expect(body).toContain("我的任务");
		expect(body).not.toContain("别的任务");
	});

	it("不带 taskId 时订阅本工作区全部任务", async () => {
		// 任务列表页要能实时刷新多个任务的状态
		const { port, hub } = await serve();
		const conn = await connect(port, "workspaceId=office");

		hub.publish(event({ taskId: "t-1", action: "任务一" } as Partial<TaskEvent>));
		hub.publish(event({ taskId: "t-2", action: "任务二" } as Partial<TaskEvent>));

		const body = await conn.until((t) => t.includes("任务一") && t.includes("任务二"));
		conn.close();

		expect(body).toContain("任务一");
		expect(body).toContain("任务二");
	});

	it("别家租户的事件绝不投递 —— 这是最后一道闸", async () => {
		// 即使编排器的事件流出了问题，这里仍要拦住越界投递
		const { port, hub } = await serve();
		const conn = await connect(port, `tenantId=${TENANT.tenantId}&taskId=t-1`);

		hub.publish(event({ tenant: OTHER, action: "别家的机密" } as Partial<TaskEvent>));
		hub.publish(event({ tenant: TENANT, action: "我方的事件" } as Partial<TaskEvent>));

		const body = await conn.until((t) => t.includes("我方的事件"));
		conn.close();

		expect(body).toContain("我方的事件");
		expect(body).not.toContain("别家的机密");
	});

	it("同租户不同工作区的事件不串", async () => {
		const { port, hub } = await serve();
		const conn = await connect(port, "workspaceId=office");

		hub.publish(
			event({
				tenant: { ...TENANT, workspaceId: "finance" },
				action: "财务处的事件",
			} as Partial<TaskEvent>),
		);
		hub.publish(event({ action: "办公室的事件" } as Partial<TaskEvent>));

		const body = await conn.until((t) => t.includes("办公室的事件"));
		conn.close();

		expect(body).toContain("办公室的事件");
		expect(body).not.toContain("财务处的事件");
	});

	it("多端订阅同一任务都能收到（电脑提交、手机看进度）", async () => {
		const { port, hub } = await serve();
		const a = await connect(port, "taskId=t-1");
		const b = await connect(port, "taskId=t-1");

		hub.publish(event({ action: "进度更新" } as Partial<TaskEvent>));

		const [bodyA, bodyB] = await Promise.all([
			a.until((t) => t.includes("进度更新")),
			b.until((t) => t.includes("进度更新")),
		]);
		a.close();
		b.close();

		expect(bodyA).toContain("进度更新");
		expect(bodyB).toContain("进度更新");
	});

	it("没有订阅者时投递不报错", async () => {
		const { hub } = await serve();
		expect(() => hub.publish(event())).not.toThrow();
	});
});

describe("SSE 心跳", () => {
	it("空闲连接会收到心跳", async () => {
		// 长连接经过反代或负载均衡时空闲超时会被静默切断，
		// 而前端只看到「进度停了」而非「连接断了」—— 不会触发重连
		const { port } = await serve({ heartbeatMs: 50 });
		const conn = await connect(port);

		// 等至少两个心跳周期
		const body = await conn.until((t) => (t.match(/: ping/g) ?? []).length >= 2, 1500);
		conn.close();

		expect((body.match(/: ping/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	it("心跳是 SSE 注释行，不会被前端当成事件", async () => {
		// 用 `data:` 发心跳会让前端收到一条内容为空的假事件
		const { port } = await serve({ heartbeatMs: 50 });
		const conn = await connect(port);
		const body = await conn.until((t) => t.includes(": ping"), 1000);
		conn.close();

		// 心跳行以 : 开头，且不含 data: 字段
		const pingBlocks = body.split("\n\n").filter((b) => b.includes("ping"));
		expect(pingBlocks.length).toBeGreaterThan(0);
		for (const block of pingBlocks) {
			expect(block.trimStart().startsWith(":")).toBe(true);
			expect(block).not.toContain("data:");
		}
	});
});
