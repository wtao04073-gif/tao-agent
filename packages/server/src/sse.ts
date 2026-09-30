/**
 * SSE 事件下发
 *
 * ── 设计依据：[Spike 7](../../../spikes/07-sse-delivery/) ──
 *
 * 只用 Node 内置 `http`，不引入 Fastify/Express。理由是 M4 的验收门禁
 * 是「客户 IT 人员 2 小时内独立装成」—— 每多一个依赖就多一处装不上的可能，
 * 而私有化环境常常没有外网、npm 源被墙、或有奇怪的代理。
 *
 * ── Spike 7 查出的真缺陷 ──
 *
 * `writeHead()` 只把响应头排进队列，Node 要等到第一次 `write()` 或连接
 * 结束才真正发出。SSE 场景下若暂时没有事件可发，客户端会一直等响应头，
 * 连接建立不起来。
 *
 * 生产表现：任务已在执行、事件也在产生，但前端一直连不上，直到第一个
 * 事件恰好到达才突然通。而开发环境往往刚好有事件，所以这个缺陷不做
 * spike 就会带到线上。修法是显式 `flushHeaders()` 并立即写一行心跳。
 */

import type { ServerResponse } from "node:http";
import type { TaskEvent } from "@tao/core";

/** SSE 心跳间隔。默认 15 秒。 */
export const HEARTBEAT_MS = 15_000;

/**
 * 一个订阅连接。
 *
 * `taskId` 为 `null` 表示订阅该租户的全部任务（用于任务列表页的实时刷新）。
 */
interface Subscriber {
	readonly res: ServerResponse;
	readonly tenantId: string;
	readonly workspaceId: string;
	readonly taskId: string | null;
	timer: ReturnType<typeof setInterval> | undefined;
}

/** 把事件序列化成 SSE 帧。`id` 用 `seq`，供 `Last-Event-ID` 重连。 */
export function toSseFrame(event: TaskEvent): string {
	return [
		`id: ${event.seq}`,
		`event: ${event.type}`,
		`data: ${JSON.stringify(event)}`,
		"",
		"",
	].join("\n");
}

/**
 * 解析重连锚点。
 *
 * 优先 `Last-Event-ID` 头（浏览器 EventSource 自动带），回退到查询参数
 * （移动端原生与部分小程序框架不支持 EventSource，带不了这个头）。
 *
 * **畸形值退化为 0（从头开始）而非 NaN。** NaN 参与 `seq > anchor` 比较
 * 会让**全部事件都被过滤掉** —— 比从头开始更糟，用户什么都看不到。
 */
export function parseAnchor(
	header: string | string[] | undefined,
	query: string | null,
): number {
	for (const raw of [Array.isArray(header) ? header[0] : header, query]) {
		if (raw === undefined || raw === null || raw === "") continue;
		const value = Number.parseInt(raw, 10);
		// 负数也按 0 处理 —— 客户端传 -1 常表示「我要全部」
		if (Number.isFinite(value) && value > 0) return value;
	}
	return 0;
}

/**
 * 事件下发中枢。
 *
 * 职责边界：只管**投递**，不管事件从哪来。事件由编排器订阅回调喂进来，
 * 历史补发由调用方提供 `history` 回调 —— 这样中枢不必知道事件存在哪。
 */
export class SseHub {
	private readonly subscribers = new Set<Subscriber>();
	private readonly heartbeatMs: number;

	constructor(options: { heartbeatMs?: number } = {}) {
		this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
	}

	/** 当前连接数。运维看板与泄漏排查用。 */
	get connectionCount(): number {
		return this.subscribers.size;
	}

	/**
	 * 接入一个订阅连接。
	 *
	 * 返回断开函数。调用方通常不需要用它 —— `req.on("close")` 已接上。
	 */
	attach(options: {
		readonly res: ServerResponse;
		readonly tenantId: string;
		readonly workspaceId: string;
		/** null 表示订阅本工作区全部任务。 */
		readonly taskId: string | null;
		/** 重连锚点之后的历史事件。首连时是全部历史。 */
		readonly backlog: readonly TaskEvent[];
		/** 客户端断开的通知源。 */
		readonly onClientClose: (handler: () => void) => void;
	}): () => void {
		const { res } = options;

		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			// 私有化部署常在 nginx 后面。不加这行反代会把 SSE 攒到连接
			// 结束才一次性吐出，表现为「任务跑完了才看到进度」
			"X-Accel-Buffering": "no",
		});

		/**
		 * 必须显式 flush —— 见文件头说明。
		 * 心跳注释行既是 flush 的载体，也让反代确认流已开始。
		 */
		res.flushHeaders();
		res.write(": connected\n\n");

		const subscriber: Subscriber = {
			res,
			tenantId: options.tenantId,
			workspaceId: options.workspaceId,
			taskId: options.taskId,
			timer: undefined,
		};
		this.subscribers.add(subscriber);

		// 补发断线期间的事件。在加入订阅集合之后做，
		// 避免补发过程中产生的新事件被漏掉
		for (const event of options.backlog) {
			this.writeTo(subscriber, event);
		}

		/**
		 * 心跳。长连接经过反代或负载均衡时，空闲超时会被静默切断，
		 * 而前端只会看到「进度停了」而非「连接断了」—— 不会触发重连。
		 */
		subscriber.timer = setInterval(() => {
			try {
				res.write(": ping\n\n");
			} catch {
				this.detach(subscriber);
			}
		}, this.heartbeatMs);
		// 心跳不该拖住进程退出
		subscriber.timer.unref?.();

		options.onClientClose(() => this.detach(subscriber));
		return () => this.detach(subscriber);
	}

	/**
	 * 投递一个事件。
	 *
	 * **租户隔离在这里守住**：事件只发给同租户同工作区的订阅者。
	 * 这是最后一道闸 —— 若编排器的事件流出了问题，这里仍能拦住越界投递。
	 */
	publish(event: TaskEvent): void {
		for (const subscriber of this.subscribers) {
			if (subscriber.tenantId !== event.tenant.tenantId) continue;
			if (subscriber.workspaceId !== event.tenant.workspaceId) continue;
			// 订阅了特定任务的，只收该任务的事件
			if (subscriber.taskId !== null && subscriber.taskId !== event.taskId) continue;
			this.writeTo(subscriber, event);
		}
	}

	/** 关闭全部连接。服务优雅停机时调用。 */
	closeAll(): void {
		for (const subscriber of [...this.subscribers]) {
			try {
				subscriber.res.end();
			} catch {
				// 已经断了就算了 —— 停机路径上不该因此抛错
			}
			this.detach(subscriber);
		}
	}

	private writeTo(subscriber: Subscriber, event: TaskEvent): void {
		try {
			subscriber.res.write(toSseFrame(event));
		} catch {
			// 写失败说明连接已废。清掉，否则会累积死连接 ——
			// 长跑的私有化部署会内存泄漏，而这种泄漏要跑几天才显形
			this.detach(subscriber);
		}
	}

	private detach(subscriber: Subscriber): void {
		if (subscriber.timer !== undefined) clearInterval(subscriber.timer);
		subscriber.timer = undefined;
		this.subscribers.delete(subscriber);
	}
}
