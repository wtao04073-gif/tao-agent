/**
 * Spike 7 · SSE 事件下发与断线重连
 *
 * 「执行任务时能继续对话」这条核心需求，落到交付上就是：**前端必须能
 * 在任务执行期间持续拿到进度，且断线重连后不丢事件、不重复处理**。
 *
 * 三个必须先验证的问题：
 *
 *  1. **Node 内置 `http` 能否支撑 SSE？** 若能，Compose 包就不必引入
 *     Fastify/Express —— 依赖越少，客户 IT 装成概率越高（M4 验收门禁是
 *     「2 小时内独立装成」）。
 *  2. **`Last-Event-ID` 重连能否精确续传？** 平台事件已有单调递增的 `seq`
 *     （M1-5 设计），但「有 seq」不等于「重连能用上」。
 *  3. **客户端断开时服务端能否感知？** 感知不到就会累积死连接，
 *     长跑的私有化部署会内存泄漏 —— 而这种泄漏要跑几天才显形。
 *
 * ── 不做这个 spike 的风险 ──
 *
 * 直接上 Fastify + 插件生态，然后发现私有化环境里装不上某个原生依赖；
 * 或者 SSE 重连做成「重连后从头推」，用户看到进度条倒退。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const servers: Server[] = [];

afterEach(async () => {
	for (const s of servers.splice(0)) {
		await new Promise<void>((resolve) => s.close(() => resolve()));
	}
});

/** 一条 SSE 事件。`id` 是重连锚点。 */
interface SseEvent {
	readonly id: number;
	readonly type: string;
	readonly data: unknown;
}

/**
 * 最小 SSE 服务端 —— 只用 Node 内置 http。
 *
 * 刻意不引入框架：这段代码就是 M4-2 交付包里会用的形态，
 * spike 要验证的正是「不用框架够不够」。
 */
function sseServer(options: {
	/** 取某任务在 afterId 之后的全部事件。 */
	readonly events: (taskId: string, afterId: number) => SseEvent[];
	/** 连接建立与断开的观测点。 */
	readonly onOpen?: (taskId: string) => void;
	readonly onClose?: (taskId: string) => void;
	/** 保持连接打开，供测试推送后续事件。 */
	readonly hold?: boolean;
}): Promise<{ port: number; push: (event: SseEvent) => void }> {
	const clients = new Set<ServerResponse>();

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const taskId = url.searchParams.get("taskId") ?? "";

		/**
		 * 重连锚点优先取 `Last-Event-ID` 头（浏览器 EventSource 自动带），
		 * 回退到查询参数（供不用 EventSource 的客户端，如移动端原生）。
		 */
		const header = req.headers["last-event-id"];
		const fromHeader = typeof header === "string" ? Number.parseInt(header, 10) : Number.NaN;
		const fromQuery = Number.parseInt(url.searchParams.get("lastEventId") ?? "", 10);
		const afterId = Number.isNaN(fromHeader)
			? Number.isNaN(fromQuery)
				? 0
				: fromQuery
			: fromHeader;

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			// 关掉 nginx 缓冲 —— 私有化部署常在反代后面，不加这行 SSE 会被攒住
			"X-Accel-Buffering": "no",
		});

		options.onOpen?.(taskId);
		clients.add(res);

		/**
		 * 必须显式 flush 响应头 —— 这是本 spike 查出的**真实缺陷**。
		 *
		 * `writeHead()` 只是把头排进队列，Node 要等到第一次 `write()`
		 * 或连接结束才真正发出。SSE 场景下若暂时没有事件可发，
		 * 客户端会一直等响应头 —— 连接建立不起来。
		 *
		 * 生产表现：任务已在执行、事件也在产生，但前端一直连不上，
		 * 直到第一个事件恰好到达才突然通。而「刚好有事件」的开发环境里
		 * 永远复现不出来。
		 *
		 * 再补一行注释行（`:` 开头，SSE 规范里是心跳/占位）双重保险：
		 * 部分反代要看到实际数据才认为流已开始。
		 */
		res.flushHeaders();
		res.write(": connected\n\n");

		// 补发断线期间的事件
		for (const event of options.events(taskId, afterId)) {
			res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
		}

		if (options.hold !== true) {
			res.end();
			clients.delete(res);
			return;
		}

		// 客户端断开的感知。不接这个会累积死连接
		req.on("close", () => {
			clients.delete(res);
			options.onClose?.(taskId);
		});
	});

	servers.push(server);

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({
				port,
				push: (event) => {
					for (const res of clients) {
						res.write(
							`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
						);
					}
				},
			});
		});
	});
}

/** 解析 SSE 响应体为事件列表。以 `:` 开头的注释行（心跳）被跳过。 */
function parseSse(body: string): Array<{ id: number; type: string; data: string }> {
	const events: Array<{ id: number; type: string; data: string }> = [];
	for (const block of body.split("\n\n")) {
		if (block.trim() === "") continue;
		// 注释行不是事件 —— 把它当事件会让「不补发」的断言拿到一条假数据
		if (block.trimStart().startsWith(":")) continue;
		let id = Number.NaN;
		let type = "";
		let data = "";
		for (const line of block.split("\n")) {
			if (line.startsWith("id: ")) id = Number.parseInt(line.slice(4), 10);
			else if (line.startsWith("event: ")) type = line.slice(7);
			else if (line.startsWith("data: ")) data = line.slice(6);
		}
		events.push({ id, type, data });
	}
	return events;
}

/**
 * 从流里持续读取，直到满足条件或超时。
 *
 * 不能只 `read()` 一次：第一个 chunk 可能只是心跳注释行，
 * 而真正的事件在下一个 chunk 里。只读一次会让断言随时序抖动而偶发失败。
 */
async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
	predicate: (text: string) => boolean,
	timeoutMs = 3000,
): Promise<string> {
	if (reader === undefined) return "";
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const chunk = await Promise.race([
			reader.read(),
			new Promise<{ value: undefined; done: true }>((resolve) =>
				setTimeout(() => resolve({ value: undefined, done: true }), 200),
			),
		]);
		if (chunk.value !== undefined) text += decoder.decode(chunk.value);
		if (predicate(text)) return text;
		if (chunk.done && chunk.value === undefined) continue; // 超时片，继续等
	}
	return text;
}

/** 造一批事件。 */
function makeEvents(n: number): SseEvent[] {
	return Array.from({ length: n }, (_, i) => ({
		id: i + 1,
		type: "step",
		data: { step: i + 1, action: `第 ${i + 1} 步` },
	}));
}

describe("Spike 7 · Node 内置 http 支撑 SSE", () => {
	it("不用框架就能推出合规的 SSE 流", async () => {
		// 若这条通过，M4-2 的交付包不必引入 Fastify —— 依赖越少越好装
		const all = makeEvents(3);
		const { port } = await sseServer({ events: (_t, after) => all.filter((e) => e.id > after) });

		const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`);
		expect(res.headers.get("content-type")).toBe("text/event-stream");

		const events = parseSse(await res.text());
		expect(events).toHaveLength(3);
		expect(events[0]?.type).toBe("step");
		expect(JSON.parse(events[0]?.data ?? "{}")).toMatchObject({ step: 1 });
	});

	it("带 X-Accel-Buffering 头 —— 私有化部署常在 nginx 后面", async () => {
		// 不加这行，反代会把 SSE 攒到连接结束才一次性吐出，
		// 表现为「任务跑完了才看到进度」。这种问题在本地开发环境永远复现不出来
		const { port } = await sseServer({ events: () => [] });
		const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`);
		expect(res.headers.get("x-accel-buffering")).toBe("no");
		await res.text();
	});
});

describe("Spike 7 · 断线重连", () => {
	it("Last-Event-ID 头精确续传，不重发已收到的事件", async () => {
		const all = makeEvents(5);
		const { port } = await sseServer({ events: (_t, after) => all.filter((e) => e.id > after) });

		const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`, {
			headers: { "Last-Event-ID": "3" },
		});
		const events = parseSse(await res.text());

		// 只补 4、5 两条
		expect(events.map((e) => e.id)).toEqual([4, 5]);
	});

	it("查询参数形式的重连锚点同样生效（供非 EventSource 客户端）", async () => {
		// 移动端原生与部分小程序框架不支持 EventSource，只能手搓流式请求，
		// 那种情况下带不了 Last-Event-ID 头
		const all = makeEvents(5);
		const { port } = await sseServer({ events: (_t, after) => all.filter((e) => e.id > after) });

		const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1&lastEventId=4`);
		expect(parseSse(await res.text()).map((e) => e.id)).toEqual([5]);
	});

	it("首次连接（无锚点）拿到全部历史事件", async () => {
		// 用户刷新页面后要能看到完整进度，不是只看到之后的
		const all = makeEvents(4);
		const { port } = await sseServer({ events: (_t, after) => all.filter((e) => e.id > after) });

		const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`);
		expect(parseSse(await res.text()).map((e) => e.id)).toEqual([1, 2, 3, 4]);
	});

	it("锚点已是最新时不补发，但连接正常建立", async () => {
		// 返回空而非报错 —— 报错会让前端以为要重试
		const all = makeEvents(2);
		const { port } = await sseServer({ events: (_t, after) => all.filter((e) => e.id > after) });

		const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`, {
			headers: { "Last-Event-ID": "2" },
		});
		expect(res.status).toBe(200);
		expect(parseSse(await res.text())).toEqual([]);
	});

	it("畸形锚点退化为从头开始，不崩", async () => {
		// 客户端可能传来任何东西。NaN 参与比较会让**全部事件都被过滤掉**
		// —— 比从头开始更糟，用户什么都看不到。
		//
		// 用 ASCII 畸形值而非中文：HTTP 头只允许 ByteString，
		// 中文值会在 fetch 层就报错，测不到服务端的解析逻辑
		const all = makeEvents(3);
		const { port } = await sseServer({ events: (_t, after) => all.filter((e) => e.id > after) });

		const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`, {
			headers: { "Last-Event-ID": "not-a-number" },
		});
		expect(parseSse(await res.text()).map((e) => e.id)).toEqual([1, 2, 3]);
	});

	it("负数与空锚点同样退化为从头开始", async () => {
		const all = makeEvents(2);
		const { port } = await sseServer({ events: (_t, after) => all.filter((e) => e.id > after) });

		for (const value of ["-5", ""]) {
			const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`, {
				headers: { "Last-Event-ID": value },
			});
			const ids = parseSse(await res.text()).map((e) => e.id);
			expect(ids, `锚点 "${value}"`).toEqual([1, 2]);
		}
	});
});

describe("Spike 7 · 连接生命周期", () => {
	it("没有事件可发时，连接依然能立即建立", async () => {
		// 这条断言对应本 spike 查出的真实缺陷：`writeHead()` 只把响应头排队，
		// Node 要等到第一次 `write()` 或连接结束才真正发出。
		//
		// 若不显式 flushHeaders + 写一行心跳，`fetch` 在「暂时无事件」时
		// 永远不 resolve —— 生产表现为「任务在跑但前端连不上」，
		// 直到第一个事件恰好到达才突然通。而开发环境里往往刚好有事件，
		// 所以这个缺陷不做 spike 就会带到线上。
		const { port } = await sseServer({ events: () => [], hold: true });

		const controller = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`, {
			signal: controller.signal,
		});

		// 关键：响应头到手了，而服务端一个事件都没发
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		controller.abort();
	});

	it("客户端断开时服务端能感知", async () => {
		// 感知不到就会累积死连接。长跑的私有化部署会内存泄漏，
		// 而这种泄漏要跑几天才显形 —— 上线后才发现
		let opened = 0;
		let closed = 0;
		const { port } = await sseServer({
			events: () => [],
			hold: true,
			onOpen: () => void (opened += 1),
			onClose: () => void (closed += 1),
		});

		const controller = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`, {
			signal: controller.signal,
		});
		// 读到心跳，确认连接真的建立了
		const reader = res.body?.getReader();
		await readUntil(reader, (t) => t.includes("connected"));
		expect(opened).toBe(1);

		controller.abort();
		// 等 close 事件冒出来
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(closed).toBe(1);
	});

	it("连接保持期间能持续收到新推送的事件", async () => {
		// 这是「执行中可继续对话」的技术前提：任务在跑，事件在流
		const { port, push } = await sseServer({ events: () => [], hold: true });

		const controller = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`, {
			signal: controller.signal,
		});
		const reader = res.body?.getReader();

		// 先等连接确立（心跳到达），再推送 —— 否则可能推给还没接上的连接
		await readUntil(reader, (t) => t.includes("connected"));

		push({ id: 1, type: "step", data: { action: "读取文件" } });
		push({ id: 2, type: "step", data: { action: "生成文档" } });

		const body = await readUntil(
			reader,
			(t) => t.includes("读取文件") && t.includes("生成文档"),
		);
		controller.abort();

		expect(body).toContain("读取文件");
		expect(body).toContain("生成文档");
	});

	it("多个客户端订阅同一任务都能收到（多端同时看进度）", async () => {
		// 用户在电脑上提交任务、用手机看进度 —— 两个连接都要收到
		const { port, push } = await sseServer({ events: () => [], hold: true });

		const controllers = [new AbortController(), new AbortController()];
		const readers = await Promise.all(
			controllers.map(async (c) => {
				const res = await fetch(`http://127.0.0.1:${port}/events?taskId=t-1`, {
					signal: c.signal,
				});
				return res.body?.getReader();
			}),
		);

		// 两端都接上后再推
		await Promise.all(readers.map((r) => readUntil(r, (t) => t.includes("connected"))));
		push({ id: 1, type: "status", data: { to: "RUNNING" } });

		const texts = await Promise.all(
			readers.map((r) => readUntil(r, (t) => t.includes("RUNNING"))),
		);
		for (const c of controllers) c.abort();

		// 两端都收到了
		expect(texts[0]).toContain("RUNNING");
		expect(texts[1]).toContain("RUNNING");
	});
});
