/**
 * 内存会话工厂
 *
 * 存在的理由是**边界纪律**：会话存储是内核概念（`Session`、`SessionRepo`
 * 都来自 vendor/pi），业务层不该认识它们。
 *
 * 写 M4-2 的服务入口时我一度在 main.ts 里直接 import vendor 的存储类 ——
 * 构建立刻失败（rootDir 越界），`scripts/check-boundaries.mjs` 也会拦下。
 * 这是纪律起作用的一次：图省事的那行 import 会让「将来换掉内核」
 * 从改一个包变成改全平台。
 *
 * ── 用 `MemorySessionRepo` 而非自己拼装 ──
 *
 * 第一版写的是 `new StorageBackedSession(metadata, new MemoryStorage())`，
 * 但 `MemoryStorage` 不在 vendor 的包导出里（`exports` 只暴露了
 * `MemorySessionRepo`）—— 只能用相对路径深入 vendor 源码，那恰好是
 * 边界检查要禁止的事。
 *
 * 上游把 `MemorySessionRepo` 作为公开 API 导出，正是为这个用途设计的：
 * 它负责 id 生成、元数据装配、关闭时的资源回收。自己拼装等于重写这些，
 * 且会在上游改动存储版本号时静默失配。
 */

import { MemorySessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import type { Session } from "@earendil-works/pi-agent-core";

/**
 * 进程内会话仓库。
 *
 * **进程重启后会话丢失。** 这是明确的能力边界而非疏漏：落盘要处理
 * 并发写、崩溃后的半写状态、跨版本的存储格式迁移，不是换个类那么简单。
 * 私有化单机部署一期接受这个限制（任务通常几分钟内跑完），落盘留到 M5。
 */
export class MemorySessionFactory {
	private readonly repo: MemorySessionRepo;

	constructor(options: { now?: () => number } = {}) {
		this.repo = new MemorySessionRepo(options.now === undefined ? {} : { now: options.now });
	}

	/** 造一个会话。id 由调用方给定，便于与 taskId 对应。 */
	async create(sessionId: string): Promise<Session> {
		return this.repo.create({ id: sessionId }, BACKGROUND_CONTEXT);
	}

	/** 关闭仓库并释放全部会话。服务停机时调用。 */
	async close(): Promise<void> {
		await this.repo.close(BACKGROUND_CONTEXT);
	}
}
