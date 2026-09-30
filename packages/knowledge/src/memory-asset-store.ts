/**
 * 内存资产存储
 *
 * 与经验、知识库同样的取舍：接口先定死，测试写全，换持久化实现可直接复用。
 */

import type { AssetStore, FieldDefinition, Template } from "@tao/core";

export class MemoryAssetStore implements AssetStore {
	private readonly templates = new Map<string, Map<string, Template>>();
	private readonly definitions = new Map<string, Map<string, FieldDefinition>>();

	private bucket<T>(map: Map<string, Map<string, T>>, tenantId: string): Map<string, T> {
		let found = map.get(tenantId);
		if (found === undefined) {
			found = new Map();
			map.set(tenantId, found);
		}
		return found;
	}

	async listTemplates(tenantId: string, scenarioId: string | null): Promise<Template[]> {
		return [...this.bucket(this.templates, tenantId).values()].filter(
			// null 表示「只要通用模板」；给了 scenarioId 则同时返回该场景与通用模板，
			// 由 resolveTemplate 决定优先级
			(t) => (scenarioId === null ? t.scenarioId === null : t.scenarioId === scenarioId || t.scenarioId === null),
		);
	}

	async getTemplate(tenantId: string, id: string): Promise<Template | undefined> {
		return this.bucket(this.templates, tenantId).get(id);
	}

	async upsertTemplate(template: Template): Promise<Template> {
		this.bucket(this.templates, template.tenantId).set(template.id, template);
		return template;
	}

	async removeTemplate(tenantId: string, id: string): Promise<boolean> {
		return this.bucket(this.templates, tenantId).delete(id);
	}

	async listDefinitions(tenantId: string): Promise<FieldDefinition[]> {
		return [...this.bucket(this.definitions, tenantId).values()];
	}

	async upsertDefinition(definition: FieldDefinition): Promise<FieldDefinition> {
		this.bucket(this.definitions, definition.tenantId).set(definition.id, definition);
		return definition;
	}

	async removeDefinition(tenantId: string, id: string): Promise<boolean> {
		return this.bucket(this.definitions, tenantId).delete(id);
	}
}
