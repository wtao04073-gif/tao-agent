import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminSettings, SettingsError } from "../src/admin-settings.ts";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "tao-settings-")); });
afterEach(() => { rmSync(directory, { force: true, recursive: true }); });
const actor = "admin";

describe("管理配置与凭据存储", () => {
	it("首启迁移显式环境配置，密钥仅加密落盘且读取不回显", () => {
		const secret = randomBytes(20).toString("hex");
		const settings = new AdminSettings({ directory, env: { MODEL_NAME: "example-model", MODEL_API_KEY: secret, MAX_CONCURRENT_TASKS: "2", UNRELATED: "ignored" } });
		expect(settings.effective("global").MODEL_API_KEY).toBe(secret);
		expect(settings.effective("global").UNRELATED).toBeUndefined();
		expect(settings.public("global").values.MAX_CONCURRENT_TASKS).toBe(2);
		expect(settings.public("global").secrets.MODEL_API_KEY).toBe(true);
		expect(JSON.stringify(settings.public("global"))).not.toContain(secret);
		expect(JSON.stringify(settings.history("global"))).not.toContain(secret);
		expect(readFileSync(join(directory, "settings.json"), "utf8")).not.toContain(secret);
		expect(statSync(join(directory, "settings.json")).mode & 0o777).toBe(0o600);
		expect(statSync(join(directory, "master.key")).mode & 0o777).toBe(0o600);
		expect(new AdminSettings({ directory }).effective("global").MODEL_API_KEY).toBe(secret);
	});

	it("草稿独立于生效配置，保存和发布均检查预期版本", () => {
		const settings = new AdminSettings({ directory });
		const saved = settings.saveDraft("global", { expectedRevision: 0, actor, values: { MODEL_NAME: "next-model" } });
		expect(saved.revision).toBe(1);
		expect(saved.activeRevision).toBe(0);
		expect(saved.draft?.MODEL_NAME).toBe("next-model");
		expect(settings.effective("global").MODEL_NAME).toBeUndefined();
		expect(settings.draftEffective("global").MODEL_NAME).toBe("next-model");
		expect(() => settings.apply("global", { expectedRevision: 0, actor })).toThrow(SettingsError);
		expect(() => settings.saveDraft("global", { expectedRevision: 0, actor, values: {} })).toThrow(/刷新/);
		const published = settings.apply("global", { expectedRevision: 1, actor });
		expect(published.revision).toBe(2);
		expect(published.activeRevision).toBe(2);
		expect(published.draft).toBeNull();
		expect(new AdminSettings({ directory }).effective("global").MODEL_NAME).toBe("next-model");
	});

	it("支持保持、替换、显式清除凭据且回退不复活旧密钥", () => {
		const previous = randomBytes(20).toString("hex"), replacement = randomBytes(20).toString("hex");
		const settings = new AdminSettings({ directory, env: { MODEL_API_KEY: previous, MODEL_NAME: "old" } });
		settings.saveDraft("global", { expectedRevision: 0, actor, values: { MODEL_NAME: "new", MODEL_API_KEY: "" } });
		settings.apply("global", { expectedRevision: 1, actor });
		expect(settings.effective("global").MODEL_API_KEY).toBe(previous);
		settings.saveDraft("global", { expectedRevision: 2, actor, values: {}, secrets: { MODEL_API_KEY: { action: "replace", value: replacement } } });
		settings.apply("global", { expectedRevision: 3, actor });
		expect(settings.effective("global").MODEL_API_KEY).toBe(replacement);
		settings.rollback("global", { expectedRevision: 4, actor, targetRevision: 0 });
		expect(settings.effective("global").MODEL_NAME).toBe("old");
		expect(settings.effective("global").MODEL_API_KEY).toBe(replacement);
		settings.saveDraft("global", { expectedRevision: 5, actor, values: {}, secrets: { MODEL_API_KEY: { action: "clear" } } });
		expect(settings.public("global").secrets.MODEL_API_KEY).toBe(true);
		expect(settings.public("global").draftSecrets?.MODEL_API_KEY).toBe(false);
		settings.apply("global", { expectedRevision: 6, actor });
		settings.rollback("global", { expectedRevision: 7, actor, targetRevision: 2 });
		expect(settings.effective("global").MODEL_API_KEY).toBeUndefined();
		expect(settings.history("global").at(-1)?.secretRestored).toBe(false);
	});

	it("租户覆盖隔离且可以显式屏蔽继承凭据", () => {
		const settings = new AdminSettings({ directory, env: { BRAND_NAME: "global", MODEL_API_KEY: randomBytes(20).toString("hex") } });
		settings.saveDraft("tenant-a", { expectedRevision: 0, actor, values: { BRAND_NAME: "tenant A" }, secrets: { MODEL_API_KEY: null } });
		settings.apply("tenant-a", { expectedRevision: 1, actor });
		expect(settings.effective("tenant-a").BRAND_NAME).toBe("tenant A");
		expect(settings.effective("tenant-a").MODEL_API_KEY).toBeUndefined();
		expect(settings.effective("tenant-b").BRAND_NAME).toBe("global");
		expect(settings.public("tenant-b").secrets.MODEL_API_KEY).toBe(true);
		expect(settings.public("tenant-b").revision).toBe(0);
		expect(() => settings.public("../tenant-a")).toThrow();
		expect(() => settings.public("__proto__")).toThrow();
	});

	it("拒绝未知字段、错误类型、不可在线修改项以及地址内凭据", () => {
		const settings = new AdminSettings({ directory });
		for (const values of [{ RANDOM_KEY: "x" }, { MODEL_RPM: "12" }, { MODEL_RPM: -1 }, { MODEL_RPM: 1.5 }, { SEARCH_ENABLED: "true" }, { PORT: 9999 }, { MODEL_BASE_URL: "https://user:pass@example.test" }, { MODEL_BASE_URL: "https://example.test?key=hidden" }, { BRAND_LOGO_URL: "javascript:alert(1)" }]) {
			expect(() => settings.saveDraft("global", { expectedRevision: 0, actor, values })).toThrow(SettingsError);
		}
		expect(settings.public("global").revision).toBe(0);
	});

	it("发布校验失败不修改草稿、原版本或密文，错误不含运行时秘密", () => {
		const settings = new AdminSettings({ directory, env: { MODEL_NAME: "old" } });
		settings.saveDraft("global", { expectedRevision: 0, actor, values: { MODEL_NAME: "new" } });
		const before = readFileSync(join(directory, "settings.json"), "utf8");
		const secret = randomBytes(20).toString("hex");
		let thrown: unknown;
		try { settings.apply("global", { expectedRevision: 1, actor }, () => { throw new Error(secret); }); } catch (error) { thrown = error; }
		expect(String(thrown)).not.toContain(secret);
		expect(settings.effective("global").MODEL_NAME).toBe("old");
		expect(settings.public("global").revision).toBe(1);
		expect(readFileSync(join(directory, "settings.json"), "utf8")).toBe(before);
	});

	it("搜索配置不完整时不能发布", () => {
		const settings = new AdminSettings({ directory });
		settings.saveDraft("global", { expectedRevision: 0, actor, values: { SEARCH_ENABLED: true } });
		expect(() => settings.apply("global", { expectedRevision: 1, actor })).toThrow(/搜索/);
		expect(settings.effective("global").SEARCH_ENABLED).toBe("false");
	});

	it("两个实例的写入仍根据最新持久化版本检测冲突", () => {
		const first = new AdminSettings({ directory }), second = new AdminSettings({ directory });
		first.saveDraft("global", { expectedRevision: 0, actor, values: { BRAND_NAME: "first" } });
		expect(() => second.saveDraft("global", { expectedRevision: 0, actor, values: { BRAND_NAME: "second" } })).toThrow(/刷新/);
		expect(second.public("global").draft?.BRAND_NAME).toBe("first");
	});

	it("主密钥丢失或错误时拒绝读取，不自动生成替代密钥", () => {
		new AdminSettings({ directory, env: { MODEL_API_KEY: randomBytes(20).toString("hex") } });
		expect(() => new AdminSettings({ directory, masterKey: randomBytes(32) })).toThrow(/解密/);
		unlinkSync(join(directory, "master.key"));
		expect(() => new AdminSettings({ directory })).toThrow(/主密钥丢失/);
	});

	it("独立注入主密钥时不在配置目录额外保存主密钥", () => {
		const masterKey = randomBytes(32);
		const settings = new AdminSettings({ directory, masterKey, env: { SEARCH_API_KEY: randomBytes(20).toString("hex") } });
		expect(settings.protectionLevel).toBe("mounted-key");
		expect(() => statSync(join(directory, "master.key"))).toThrow();
		expect(new AdminSettings({ directory, masterKey: masterKey.toString("base64") }).public("global").secrets.SEARCH_API_KEY).toBe(true);
	});

	it("配置主文件损坏时使用已校验备份并明确返回恢复告警", () => {
		const settings = new AdminSettings({ directory, env: { BRAND_NAME: "last-good" } });
		settings.saveDraft("global", { expectedRevision: 0, actor, values: { BRAND_NAME: "draft" } });
		writeFileSync(join(directory, "settings.json"), "{broken");
		const restored = new AdminSettings({ directory });
		expect(restored.effective("global").BRAND_NAME).toBe("last-good");
		expect(restored.public("global").recoveryWarning).toContain("恢复");
	});

	it("密文认证失败时恢复最近有效备份，禁止使用被修改的凭据", () => {
		const secret = randomBytes(20).toString("hex");
		const settings = new AdminSettings({ directory, env: { MODEL_API_KEY: secret } });
		settings.saveDraft("global", { expectedRevision: 0, actor, values: { BRAND_NAME: "draft" } });
		const file = join(directory, "settings.json");
		const data = JSON.parse(readFileSync(file, "utf8"));
		const entry = Object.values(data.credentials)[0] as { tag: string };
		entry.tag = randomBytes(16).toString("base64");
		writeFileSync(file, JSON.stringify(data));
		const restored = new AdminSettings({ directory });
		expect(restored.effective("global").MODEL_API_KEY).toBe(secret);
		expect(restored.public("global").recoveryWarning).toContain("恢复");
	});

	it("备份落盘失败时原配置与内存版本不变", () => {
		const settings = new AdminSettings({ directory });
		mkdirSync(join(directory, "settings.json.previous"));
		expect(() => settings.saveDraft("global", { expectedRevision: 0, actor, values: { BRAND_NAME: "not-saved" } })).toThrow(/保存失败/);
		expect(settings.public("global").revision).toBe(0);
		expect(new AdminSettings({ directory }).public("global").revision).toBe(0);
	});

	it("返回对象修改不能改变存储，嵌套发布校验不能重入写配置", () => {
		const settings = new AdminSettings({ directory });
		const response = settings.public("global");
		response.values.BRAND_NAME = "mutated";
		expect(settings.effective("global").BRAND_NAME).toBe("Tao Agent");
		settings.saveDraft("global", { expectedRevision: 0, actor, values: { BRAND_NAME: "candidate" } });
		expect(() => settings.apply("global", { expectedRevision: 1, actor }, () => {
			settings.saveDraft("global", { expectedRevision: 1, actor, values: {} });
		})).toThrow(/正在发布/);
		expect(settings.public("global").activeRevision).toBe(0);
	});
});
