/**
 * 内存经验存储
 *
 * 与知识库同样的取舍：先把接口定死、测试写全，换持久化实现时可直接复用测试。
 *
 * 一个租户一个场景的经验条数通常在几十条量级（超过 12 条就不会全部注入了），
 * 内存完全够用。
 */

import type { Lesson, LessonStore } from "@tao/core";

export class MemoryLessonStore implements LessonStore {
	/** 按 tenantId 分桶存储。 */
	private readonly byTenant = new Map<string, Map<string, Lesson>>();

	private bucket(tenantId: string): Map<string, Lesson> {
		let found = this.byTenant.get(tenantId);
		if (found === undefined) {
			found = new Map();
			this.byTenant.set(tenantId, found);
		}
		return found;
	}

	async list(tenantId: string, scenarioId: string): Promise<Lesson[]> {
		return [...this.bucket(tenantId).values()]
			// 经验按场景隔离 —— 台账的口径不该影响 8D 报告
			.filter((l) => l.scenarioId === scenarioId)
			.sort((a, b) => b.timesObserved - a.timesObserved || b.updatedAt - a.updatedAt);
	}

	async upsert(lesson: Lesson): Promise<Lesson> {
		this.bucket(lesson.tenantId).set(lesson.id, lesson);
		return lesson;
	}

	async get(tenantId: string, id: string): Promise<Lesson | undefined> {
		return this.bucket(tenantId).get(id);
	}

	async remove(tenantId: string, id: string): Promise<boolean> {
		return this.bucket(tenantId).delete(id);
	}

	/** 某租户的经验总数。仅供测试与运维观测。 */
	countFor(tenantId: string): number {
		return this.bucket(tenantId).size;
	}
}
