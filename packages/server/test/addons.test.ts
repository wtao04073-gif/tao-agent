import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredAgent, StoredSkill, TenantContext } from "@tao/core";
import { FileJsonStore } from "@tao/knowledge";
import { listVisibleAgents, listVisibleSkills, newAddonId, resolveAddons } from "../src/addons.ts";

const tenantA: TenantContext = { tenantId: "school-a", workspaceId: "ws-1", userId: "u1" };
const tenantB: TenantContext = { tenantId: "school-b", workspaceId: "ws-1", userId: "u2" };

let dir: string;
let skillStore: FileJsonStore<StoredSkill>;
let agentStore: FileJsonStore<StoredAgent>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tao-addons-"));
	skillStore = new FileJsonStore<StoredSkill>({ dir, collection: "skills", idOf: (s) => s.skillId });
	agentStore = new FileJsonStore<StoredAgent>({ dir, collection: "agents", idOf: (a) => a.agentId });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("内置扩展", () => {
	it("内置技能 / 智能体对每个租户都可见且标记 builtin", () => {
		const skillsA = listVisibleSkills(skillStore, tenantA);
		const skillsB = listVisibleSkills(skillStore, tenantB);
		expect(skillsA.length).toBeGreaterThan(0);
		expect(skillsA.length).toBe(skillsB.length);
		expect(skillsA.every((s) => s.builtin)).toBe(true);

		const agents = listVisibleAgents(agentStore, tenantA);
		expect(agents.length).toBeGreaterThan(0);
		expect(agents.every((a) => a.builtin)).toBe(true);
	});
});

describe("租户上传隔离", () => {
	it("A 租户上传的技能对 B 租户不可见", () => {
		const id = newAddonId("skill");
		skillStore.create({
			skillId: id, tenant: tenantA, name: "A 专属", description: "d", content: "c",
			builtin: false, createdAt: 1, updatedAt: 1,
		});
		expect(listVisibleSkills(skillStore, tenantA).some((s) => s.skillId === id)).toBe(true);
		expect(listVisibleSkills(skillStore, tenantB).some((s) => s.skillId === id)).toBe(false);
	});
});

describe("resolveAddons", () => {
	it("无选择时不注入技能、不覆盖提示词", () => {
		const r = resolveAddons({ tenant: tenantA, skillStore, agentStore });
		expect(r.skills).toEqual([]);
		expect(r.systemPromptOverride).toBeUndefined();
	});

	it("选用内置技能：转成 RunnerSkill 注入", () => {
		const first = listVisibleSkills(skillStore, tenantA)[0];
		const r = resolveAddons({ tenant: tenantA, skillStore, agentStore, skillId: first.skillId });
		expect(r.skills).toHaveLength(1);
		expect(r.skills[0]).toMatchObject({ name: first.name, description: first.description, content: first.content });
		expect(r.systemPromptOverride).toBeUndefined();
	});

	it("选用内置智能体：覆盖系统提示词并带上其挂载技能", () => {
		const agent = listVisibleAgents(agentStore, tenantA)[0];
		const r = resolveAddons({ tenant: tenantA, skillStore, agentStore, agentId: agent.agentId });
		expect(r.systemPromptOverride).toBe(agent.systemPrompt);
		expect(r.skills.length).toBe(agent.skillIds.length);
	});

	it("智能体挂载技能 + 显式技能合并去重", () => {
		const agent = listVisibleAgents(agentStore, tenantA)[0];
		const mounted = agent.skillIds[0];
		const r = resolveAddons({
			tenant: tenantA, skillStore, agentStore, agentId: agent.agentId, skillId: mounted,
		});
		// mounted 已在智能体技能内，显式重复不应产生两条
		expect(r.skills.filter((s) => s.content !== "").length).toBe(r.skills.length);
		const names = r.skills.map((s) => s.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("引用他租户上传的技能 / 智能体 → 抛错", () => {
		const skillId = newAddonId("skill");
		skillStore.create({
			skillId, tenant: tenantA, name: "A", description: "d", content: "c",
			builtin: false, createdAt: 1, updatedAt: 1,
		});
		expect(() =>
			resolveAddons({ tenant: tenantB, skillStore, agentStore, skillId }),
		).toThrow(/技能不存在或无权使用/);

		const agentId = newAddonId("agent");
		agentStore.create({
			agentId, tenant: tenantA, name: "A", description: "d", systemPrompt: "p", skillIds: [],
			builtin: false, createdAt: 1, updatedAt: 1,
		});
		expect(() =>
			resolveAddons({ tenant: tenantB, skillStore, agentStore, agentId }),
		).toThrow(/智能体不存在或无权使用/);
	});

	it("智能体引用了不可见技能 → 抛错（fail-closed，不静默丢技能）", () => {
		const agentId = newAddonId("agent");
		agentStore.create({
			agentId, tenant: tenantA, name: "坏引用", description: "d",
			systemPrompt: "p", skillIds: ["skill-does-not-exist"],
			builtin: false, createdAt: 1, updatedAt: 1,
		});
		expect(() =>
			resolveAddons({ tenant: tenantA, skillStore, agentStore, agentId }),
		).toThrow(/技能不存在或无权使用/);
	});
});
