import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type SettingValue = string | number | boolean;
export type SettingsValues = Record<string, SettingValue>;
export type SettingsEnvironment = Record<string, string | undefined>;
export type Values = SettingsEnvironment;
export interface SettingsField {
	key: string;
	label: string;
	group: string;
	type: "string" | "number" | "boolean";
	secret?: boolean;
	default?: SettingValue;
	min?: number;
	max?: number;
	integer?: boolean;
	options?: string[];
	readOnly?: boolean;
	effect: "new-task" | "refresh" | "restart" | "reindex";
}

const fields: SettingsField[] = [];
function field(key: string, label: string, group: string, type: SettingsField["type"] = "string", extra: Partial<SettingsField> = {}): void {
	fields.push({ key, label, group, type, effect: "new-task", ...extra });
}
for (const [prefix, title] of [["MODEL", "旗舰模型"], ["MODEL_LITE", "轻量模型"], ["EVAL_MODEL", "评测模型"]]) {
	field(`${prefix}_PROVIDER`, `${title}服务商`, "model", "string", { options: ["openai-compatible", "deepseek", "qwen", "custom"] });
	field(`${prefix}_BASE_URL`, `${title}服务地址`, "model");
	field(`${prefix}_NAME`, `${title}名称`, "model");
	field(`${prefix}_API_KEY`, `${title}密钥`, "model", "string", { secret: true });
	for (const [suffix, label] of [["INPUT_PRICE", "输入单价"], ["OUTPUT_PRICE", "输出单价"], ["CACHE_READ_PRICE", "缓存读取单价"]]) {
		field(`${prefix}_${suffix}`, `${title}${label}（元/百万 Token）`, "model", "number", { min: 0 });
	}
}
field("MODEL_MAX_TOKENS", "最大输出 Token", "model", "number", { default: 4096, min: 1, max: 1_000_000, integer: true });
field("MODEL_CONTEXT_WINDOW", "上下文窗口", "model", "number", { min: 1, max: 10_000_000, integer: true });
field("MODEL_TIMEOUT_MS", "模型请求超时（毫秒）", "model", "number", { default: 120_000, min: 1000, max: 3_600_000, integer: true });
for (const [key, label] of [["MODEL_RPM", "每分钟请求数"], ["MODEL_TPM", "每分钟 Token 预算"], ["QUOTA_MAX_TOKENS", "月度 Token 配额"], ["QUOTA_MAX_TASKS", "月度任务配额"]]) {
	field(key!, label!, "limits", "number", { min: 0, integer: true });
}
field("QUOTA_MAX_COST_YUAN", "月度费用配额（元）", "limits", "number", { min: 0 });
for (const [key, label, initial] of [["MODEL_MAX_CONCURRENCY", "模型请求并发", 3], ["MAX_CONCURRENT_TASKS", "任务并发", 3], ["MAX_SUBTASK_CONCURRENCY", "子任务并发", 3], ["EVAL_CONCURRENCY", "评测并发", 1]] as const) {
	field(key, label, "limits", "number", { default: initial, min: 1, max: ["MAX_SUBTASK_CONCURRENCY", "EVAL_CONCURRENCY"].includes(key) ? 5 : 20, integer: true });
}
field("SUBAGENTS_ENABLED", "启用子智能体", "extensions", "boolean", { default: true });
field("EMBEDDING_ENDPOINT", "嵌入模型地址", "knowledge", "string", { effect: "reindex" });
field("EMBEDDING_MODEL", "嵌入模型名称", "knowledge", "string", { effect: "reindex" });
field("EMBEDDING_API_KEY", "嵌入模型密钥", "knowledge", "string", { secret: true });
field("EMBEDDING_DIMENSIONS", "向量维度", "knowledge", "number", { min: 1, max: 8192, integer: true, effect: "reindex" });
field("EMBEDDING_REVISION", "向量空间版本", "knowledge", "string", { default: "1", effect: "reindex" });
field("EMBEDDING_QUERY_PREFIX", "检索文本前缀", "knowledge");
field("EMBEDDING_DOCUMENT_PREFIX", "文档文本前缀", "knowledge");
field("RAG_REQUIRED", "要求知识库可用", "knowledge", "boolean");
field("RAG_MODE", "检索方式", "knowledge", "string", { options: ["semantic", "hybrid"] });
field("RAG_MIN_SIMILARITY", "最低相似度", "knowledge", "number", { default: 0.35, min: -1, max: 1 });
field("RAG_CHUNK_CHARS", "切片字符数", "knowledge", "number", { default: 800, min: 100, max: 8000, integer: true, effect: "reindex" });
field("RAG_CHUNK_OVERLAP_CHARS", "切片重叠字符数", "knowledge", "number", { default: 100, min: 0, max: 7999, integer: true, effect: "reindex" });
field("RAG_TOP_K", "检索召回数量", "knowledge", "number", { default: 8, min: 1, max: 100, integer: true });
field("SEARCH_ENABLED", "启用联网搜索", "search", "boolean", { default: false });
field("SEARCH_PROVIDER", "搜索服务商", "search", "string", { options: ["tavily", "brave"] });
field("SEARCH_API_KEY", "搜索密钥", "search", "string", { secret: true });
field("SEARCH_MAX_RESULTS", "默认搜索结果数", "search", "number", { default: 5, min: 1, max: 20, integer: true });
field("SEARCH_TIMEOUT_MS", "搜索超时（毫秒）", "search", "number", { default: 15_000, min: 1000, max: 120_000, integer: true });
field("NETWORK_ALLOWED_CIDRS", "允许访问的私有网段（逗号分隔）", "deployment", "string", { default: "127.0.0.1/32,::1/128" });
field("ALLOW_OUTBOUND_NETWORK", "允许联网工具出网", "search", "boolean", { default: false });
field("MCP_ENABLED", "启用 MCP 服务", "extensions", "boolean", { default: false });
field("MCP_NAME", "MCP 服务名称", "extensions");
field("MCP_URL", "MCP 服务地址", "extensions");
field("MCP_TOOLS", "允许的工具（逗号分隔）", "extensions");
field("MCP_AUTH_HEADER", "MCP 认证头名称", "extensions", "string", { default: "Authorization" });
field("MCP_AUTH_TOKEN", "MCP 认证凭据", "extensions", "string", { secret: true });

field("SANDBOX_ENABLED", "启用隔离执行环境", "sandbox", "boolean", { default: false });
field("SANDBOX_PROVIDER", "运行方式（生产推荐 cube）", "sandbox", "string", { default: "cube", options: ["cube", "bubblewrap"] });
field("SANDBOX_API_URL", "CubeSandbox API 地址", "sandbox");
field("SANDBOX_API_KEY", "CubeSandbox 密钥", "sandbox", "string", { secret: true });
field("SANDBOX_TEMPLATE", "CubeSandbox 模板 ID", "sandbox");
field("SANDBOX_PROXY_IP", "CubeProxy IP（可选）", "sandbox");
field("SANDBOX_PROXY_PORT", "CubeProxy 端口", "sandbox", "number", { default: 443, min: 1, max: 65535, integer: true });
field("SANDBOX_PROXY_SCHEME", "CubeProxy 协议", "sandbox", "string", { default: "https", options: ["https", "http"] });
field("SANDBOX_DOMAIN", "CubeSandbox 域名", "sandbox", "string", { default: "cube.app" });
field("SANDBOX_NETWORK_ENABLED", "允许沙箱访问公网（私网始终禁止）", "sandbox", "boolean", { default: false });
field("SANDBOX_ALLOWED_DOMAINS", "出网域名白名单（逗号分隔；空白允许公网）", "sandbox");
field("SANDBOX_REQUIRE_CONFIRM", "代码执行前要求用户确认", "sandbox", "boolean", { default: true });
for (const [key,label,initial,min,max] of [
 ["SANDBOX_TTL_SECONDS","单任务沙箱最长存活（秒）",600,60,3600],
 ["SANDBOX_EXEC_TIMEOUT_SECONDS","单次代码执行超时（秒）",60,1,120],
 ["SANDBOX_MAX_CONCURRENT","沙箱最大并发",2,1,5],
 ["SANDBOX_MEMORY_MB","本地沙箱内存监督阈值（MB，Cube 由模板控制）",1536,256,4096],
 ["SANDBOX_DISK_MB","本地沙箱文件监督阈值（MB，Cube 由模板控制）",128,32,1024],
] as const) field(key,label,"sandbox","number",{default:initial,min,max,integer:true});
for(const key of ["SANDBOX_LOCAL_RUNTIME","SANDBOX_LOCAL_BROWSERS","SANDBOX_LOCAL_UID","SANDBOX_CUBE_EGRESS_GUARD"]) field(key,"本地运行时部署参数","deployment","string",{readOnly:true,effect:"restart"});

field("OBSERVABILITY_RETENTION_DAYS", "观测数据保留天数", "observability", "number", { default: 30, min: 1, max: 3650, integer: true });
field("OBSERVABILITY_SAMPLE_RATE", "观测采样比例", "observability", "number", { default: 1, min: 0, max: 1 });

field("OTLP_ENDPOINT", "OTLP 导出地址", "observability");
field("OTLP_AUTH_HEADER", "OTLP 认证头名称", "observability", "string", { default: "Authorization" });
field("OTLP_AUTH_TOKEN", "OTLP 导出凭据", "observability", "string", { secret: true });
field("EVAL_MAX_CASES", "每次评测最多用例数", "evaluation", "number", { default: 20, min: 1, max: 100, integer: true });
field("EVAL_MAX_TOKENS", "单次评测 Token 预算", "evaluation", "number", { min: 1, integer: true });
field("EVAL_MAX_COST_YUAN", "单次评测费用预算（元）", "evaluation", "number", { min: 0 });
field("BRAND_NAME", "平台名称", "branding", "string", { default: "Tao Agent", effect: "refresh" });
field("BRAND_SHORT_NAME", "平台简称", "branding", "string", { default: "Tao", effect: "refresh" });
field("BRAND_WELCOME", "欢迎语", "branding", "string", { default: "有什么可以帮你？", effect: "refresh" });
field("BRAND_DESCRIPTION", "平台说明", "branding", "string", { effect: "refresh" });
field("BRAND_LOGO_URL", "平台图标", "branding", "string", { effect: "refresh" });
field("PORT", "监听端口（需重启）", "deployment", "number", { min: 1, max: 65535, integer: true, readOnly: true, effect: "restart" });
field("WORKSPACE_DIR", "存储位置（部署管理）", "deployment", "string", { readOnly: true, effect: "restart" });

const byKey = new Map(fields.map((entry) => [entry.key, entry]));
const groups = [
	["model", "模型"], ["limits", "限流与配额"], ["knowledge", "知识库"], ["search", "联网搜索"],
	["extensions", "扩展与子智能体"], ["sandbox", "沙箱执行环境"], ["observability", "观测"], ["evaluation", "评测"], ["branding", "品牌"], ["deployment", "部署"],
].map(([id, label]) => ({ id: id!, label: label! }));

export class AdminError extends Error {
	readonly status: number;
	constructor(status: number, message: string) { super(message); this.status = status; this.name = "AdminError"; }
}
export class SettingsError extends AdminError {
	readonly code: string;
	constructor(status: number, code: string, message: string) { super(status, message); this.code = code; this.name = "SettingsError"; }
}

/** 供管理数据存储共用的受限权限原子 JSON 写入。 */
export function atomicJson(file: string, value: unknown): void {
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		const fd = openSync(temp, "wx", 0o600);
		try { writeFileSync(fd, JSON.stringify(value), "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(temp, file);
		const parent = openSync(dirname(file), "r");
		try { fsyncSync(parent); } finally { closeSync(parent); }
	} finally { if (existsSync(temp)) unlinkSync(temp); }
}
export type SecretChange = string | null | { action: "keep" | "replace" | "clear"; value?: string };
export interface DraftSettingsInput {
	expectedRevision: number;
	values: Record<string, SettingValue | null>;
	secrets?: Record<string, SecretChange>;
	actor: string;
}
export interface ApplySettingsInput { expectedRevision: number; actor: string; }
export interface RollbackSettingsInput extends ApplySettingsInput { targetRevision: number; }
interface Snapshot { values: SettingsValues; secretRefs: Record<string, string | null>; }
interface Revision extends Snapshot { revision: number; updatedAt: string; actor: string; action: "migration" | "apply" | "rollback"; restoredFrom?: number; }
interface ScopeState { revision: number; active: Revision; draft?: Snapshot; history: Revision[]; }
interface CipherSecret { scope: string; key: string; nonce: string; ciphertext: string; tag: string; keyVersion: 1; }
interface SettingsStore { schemaVersion: 1; scopes: Record<string, ScopeState>; credentials: Record<string, CipherSecret>; }
export interface PublicSettings {
	scope: string;
	schemaVersion: 1;
	revision: number;
	activeRevision: number;
	values: SettingsValues;
	draft: SettingsValues | null;
	secrets: Record<string, boolean>;
	draftSecrets: Record<string, boolean> | null;
	source: Record<string, "default" | "environment" | "global" | "admin">;
	updatedAt: string;
	actor: string;
	protectionLevel: "mounted-key" | "local-key-file";
	recoveryWarning?: string;
}
export interface PublicSettingsRevision {
	revision: number;
	updatedAt: string;
	actor: string;
	action: Revision["action"];
	values: SettingsValues;
	secrets: Record<string, boolean>;
	restoredFrom?: number;
	secretRestored: false;
}
export interface AdminSettingsOptions {
	directory: string;
	/** 显式传入部署配置；不读取进程的其他环境变量。 */
	env?: SettingsEnvironment;
	/** 32 字节主密钥，或其 base64 编码。挂载文件由调用方读取。 */
	masterKey?: Uint8Array | string;
}

const mutationLocks = new Set<string>();
function clone<T>(value: T): T { return structuredClone(value); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalid(message: string): never { throw new SettingsError(400, "invalid_settings", message); }
function safeScope(scope: string): void { if (typeof scope !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(scope) || ["__proto__", "constructor", "prototype"].includes(scope)) invalid("配置作用域无效"); }

/** 单进程、单机配置中心；认证与 scope 授权必须由 API 层完成。 */
export class AdminSettings {
	private readonly directory: string;
	private readonly file: string;
	private readonly key: Buffer;
	private store: SettingsStore;
	private recoveryWarning?: string;
	readonly protectionLevel: "mounted-key" | "local-key-file";

	constructor(options: AdminSettingsOptions) {
		this.directory = resolve(options.directory);
		this.file = join(this.directory, "settings.json");
		this.protectionLevel = options.masterKey === undefined ? "local-key-file" : "mounted-key";
		try {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			chmodSync(this.directory, 0o700);
			const keyFile = join(this.directory, "master.key");
			if (options.masterKey !== undefined) {
				this.key = typeof options.masterKey === "string" ? Buffer.from(options.masterKey, "base64") : Buffer.from(options.masterKey);
			} else if (existsSync(keyFile)) {
				this.key = readFileSync(keyFile);
				chmodSync(keyFile, 0o600);
			} else {
				if (existsSync(this.file) || existsSync(`${this.file}.previous`)) throw new SettingsError(500, "master_key_missing", "配置主密钥丢失，请恢复原主密钥");
				this.key = randomBytes(32);
				const fd = openSync(keyFile, "wx", 0o600);
				try { writeFileSync(fd, this.key); fsyncSync(fd); } finally { closeSync(fd); }
			}
			if (this.key.length !== 32) throw new SettingsError(500, "invalid_master_key", "配置主密钥须为 32 字节");
			if (existsSync(this.file) || existsSync(`${this.file}.previous`)) {
				this.store = this.readStore();
			} else {
				this.store = { schemaVersion: 1, scopes: {}, credentials: {} };
				const initial = this.emptyScope();
				this.store.scopes.global = initial;
				for (const entry of fields) {
					const raw = options.env?.[entry.key];
					if (raw === undefined || raw === "") continue;
					if (entry.secret) initial.active.secretRefs[entry.key] = this.encrypt(this.store, "global", entry.key, raw);
					else initial.active.values[entry.key] = this.migrateValue(entry, raw);
				}
				initial.history = [clone(initial.active)];
				this.persist(this.store);
			}
			// 验证全部密文，错误主密钥不可静默当作空配置。
			for (const ref of Object.keys(this.store.credentials)) this.decrypt(ref, this.store);
		} catch (error) {
			if (error instanceof AdminError) throw error;
			throw new SettingsError(500, "settings_unavailable", "无法读取配置存储，请检查配置与主密钥备份");
		}
	}

	schema(): { version: 1; groups: typeof groups; fields: SettingsField[] } { return { version: 1, groups: clone(groups), fields: clone(fields) }; }

	/** 仅供服务端运行时使用，禁止序列化到响应、日志或任务快照。 */
	effective(scope: string): SettingsEnvironment {
		safeScope(scope);
		return this.environment(this.store, scope, this.current(scope).active);
	}

	/** 草稿连接测试使用同一条凭据解析链，但不会发布配置。 */
	draftEffective(scope: string): SettingsEnvironment {
		safeScope(scope);
		const state = this.current(scope);
		return this.environment(this.store, scope, state.draft ?? state.active);
	}

	public(scope: string): PublicSettings {
		safeScope(scope);
		const state = this.current(scope);
		const active = this.merged(this.store, scope, state.active);
		const draft = state.draft ? this.merged(this.store, scope, state.draft) : undefined;
		const source: PublicSettings["source"] = {};
		for (const entry of fields) {
			const own = Object.hasOwn(state.active.values, entry.key) || Object.hasOwn(state.active.secretRefs, entry.key);
			const global = this.store.scopes.global!.active;
			const inherited = Object.hasOwn(global.values, entry.key) || Object.hasOwn(global.secretRefs, entry.key);
			source[entry.key] = own ? (state.active.revision === 0 ? "environment" : "admin") : inherited ? "global" : "default";
		}
		return { scope, schemaVersion: 1, revision: state.revision, activeRevision: state.active.revision,
			values: clone(active.values), draft: draft ? clone(draft.values) : null, secrets: this.secretStatus(active), draftSecrets: draft ? this.secretStatus(draft) : null,
			source, updatedAt: state.active.updatedAt, actor: state.active.actor, protectionLevel: this.protectionLevel,
			...(this.recoveryWarning ? { recoveryWarning: this.recoveryWarning } : {}) };
	}

	history(scope: string): PublicSettingsRevision[] {
		safeScope(scope);
		return this.current(scope).history.map((revision) => ({ revision: revision.revision, updatedAt: revision.updatedAt, actor: revision.actor, action: revision.action,
			values: clone(revision.values), secrets: this.secretStatus(revision), ...(revision.restoredFrom === undefined ? {} : { restoredFrom: revision.restoredFrom }), secretRestored: false }));
	}

	saveDraft(scope: string, input: DraftSettingsInput): PublicSettings {
		return this.mutate(scope, input, (next, state) => {
			if (!record(input.values) || (input.secrets !== undefined && !record(input.secrets))) invalid("配置字段必须为对象");
			const draft = clone(state.draft ?? state.active);
			const secretChanges: Record<string, SecretChange> = {};
			for (const [key, value] of Object.entries(input.values)) {
				const entry = byKey.get(key);
				if (!entry) invalid("包含不支持的配置字段");
				if (entry.readOnly) invalid(`${entry.label}不能在线修改`);
				if (entry.secret) {
					if (typeof value !== "string" && value !== null) invalid(`${entry.label}格式无效`);
					secretChanges[key] = value;
				} else if (value === null) delete draft.values[key];
				else { this.validateValue(entry, value); draft.values[key] = value; }
			}
			for (const [key, change] of Object.entries(input.secrets ?? {})) {
				if (Object.hasOwn(secretChanges, key)) invalid("同一凭据不能重复提交");
				if (!byKey.get(key)?.secret) invalid("包含不支持的凭据字段");
				secretChanges[key] = change;
			}
			for (const [key, change] of Object.entries(secretChanges)) {
				if (change === null || (record(change) && change.action === "clear")) draft.secretRefs[key] = null;
				else if (typeof change === "string") {
					if (change.trim()) draft.secretRefs[key] = this.encrypt(next, scope, key, change);
				} else if (record(change) && change.action === "keep") continue;
				else if (record(change) && change.action === "replace" && typeof change.value === "string" && change.value.trim()) draft.secretRefs[key] = this.encrypt(next, scope, key, change.value);
				else invalid("凭据操作无效，请选择保持、替换或清除");
			}
			state.draft = draft;
		});
	}

	apply(scope: string, input: ApplySettingsInput, validate?: (candidate: SettingsEnvironment) => void): PublicSettings {
		return this.mutate(scope, input, (next, state) => {
			if (!state.draft) invalid("没有待发布的配置草稿");
			this.validateCandidate(this.environment(next, scope, state.draft), validate);
			state.active = { ...clone(state.draft), revision: state.revision + 1, updatedAt: new Date().toISOString(), actor: input.actor, action: "apply" };
			state.history.push(clone(state.active));
			delete state.draft;
		});
	}

	/** 回退非密钥配置，保持当前凭据，防止历史 Key 被重新启用。 */
	rollback(scope: string, input: RollbackSettingsInput, validate?: (candidate: SettingsEnvironment) => void): PublicSettings {
		return this.mutate(scope, input, (next, state) => {
			if (!Number.isSafeInteger(input.targetRevision)) invalid("目标版本无效");
			const target = state.history.find((entry) => entry.revision === input.targetRevision);
			if (!target) throw new SettingsError(404, "revision_not_found", "配置版本不存在");
			const candidate: Snapshot = { values: clone(target.values), secretRefs: clone(state.active.secretRefs) };
			this.validateCandidate(this.environment(next, scope, candidate), validate);
			state.active = { ...candidate, revision: state.revision + 1, updatedAt: new Date().toISOString(), actor: input.actor, action: "rollback", restoredFrom: input.targetRevision };
			state.history.push(clone(state.active));
			delete state.draft;
		});
	}

	private current(scope: string): ScopeState { return this.store.scopes[scope] ?? this.emptyScope(); }
	private emptyScope(): ScopeState {
		const active: Revision = { values: {}, secretRefs: {}, revision: 0, updatedAt: new Date().toISOString(), actor: "deployment", action: "migration" };
		return { revision: 0, active, history: [clone(active)] };
	}
	private merged(store: SettingsStore, scope: string, snapshot: Snapshot): Snapshot {
		const values: SettingsValues = {};
		for (const entry of fields) if (entry.default !== undefined) values[entry.key] = entry.default;
		const global = store.scopes.global!.active;
		return { values: { ...values, ...(scope === "global" ? {} : global.values), ...snapshot.values }, secretRefs: { ...(scope === "global" ? {} : global.secretRefs), ...snapshot.secretRefs } };
	}
	private environment(store: SettingsStore, scope: string, snapshot: Snapshot): SettingsEnvironment {
		const merged = this.merged(store, scope, snapshot);
		const env: SettingsEnvironment = {};
		for (const [key, value] of Object.entries(merged.values)) env[key] = String(value);
		for (const [key, ref] of Object.entries(merged.secretRefs)) env[key] = ref === null ? undefined : this.decrypt(ref, store);
		return env;
	}
	private secretStatus(snapshot: Snapshot): Record<string, boolean> {
		return Object.fromEntries(fields.filter((entry) => entry.secret).map((entry) => [entry.key, Boolean(snapshot.secretRefs[entry.key])]));
	}
	private migrateValue(entry: SettingsField, raw: string): SettingValue {
		const value = entry.type === "number" ? Number(raw) : entry.type === "boolean" ? raw === "true" : raw;
		if (entry.type === "boolean" && raw !== "true" && raw !== "false") invalid(`${entry.label}格式无效`);
		this.validateValue(entry, value);
		return value;
	}
	private validateValue(entry: SettingsField, value: unknown): asserts value is SettingValue {
		if (typeof value !== entry.type) invalid(`${entry.label}类型无效`);
		if (typeof value === "number" && (!Number.isFinite(value) || (entry.integer && !Number.isSafeInteger(value)) || (entry.min !== undefined && value < entry.min) || (entry.max !== undefined && value > entry.max))) invalid(`${entry.label}超出允许范围`);
		if (typeof value === "string") {
			if (value.length > 8192 || /[\u0000]/.test(value)) invalid(`${entry.label}内容无效`);
			if (entry.options && !entry.options.includes(value)) invalid(`${entry.label}选项无效`);
			if (value && (entry.key.endsWith("_URL") || entry.key.endsWith("_ENDPOINT")) && entry.key !== "BRAND_LOGO_URL") {
				let url: URL;
				try { url = new URL(value); } catch { invalid(`${entry.label}地址无效`); }
				if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid(`${entry.label}须为不含凭据、查询参数的 HTTP 地址`);
			}
			if (entry.key === "BRAND_LOGO_URL" && value && !/^\/api\/branding\/logo\/[A-Za-z0-9_.-]+$/.test(value)) invalid("图标必须使用已上传的平台图标");
			if (entry.key.endsWith("_AUTH_HEADER") && !/^[A-Za-z0-9-]{1,128}$/.test(value)) invalid(`${entry.label}格式无效`);
		}
	}
	private validateCandidate(env: SettingsEnvironment, validate?: (candidate: SettingsEnvironment) => void): void {
		if (Number(env.RAG_CHUNK_OVERLAP_CHARS) >= Number(env.RAG_CHUNK_CHARS)) invalid("切片重叠字符数必须小于切片字符数");
		if (env.SEARCH_ENABLED === "true" && (env.ALLOW_OUTBOUND_NETWORK !== "true" || !env.SEARCH_PROVIDER || !env.SEARCH_API_KEY)) invalid("启用搜索需要允许出网并配置服务商与密钥");
		if (env.MCP_ENABLED === "true" && (env.ALLOW_OUTBOUND_NETWORK !== "true" || !env.MCP_NAME || !env.MCP_URL || !env.MCP_TOOLS)) invalid("启用 MCP 需要允许出网、服务名称、地址与工具白名单");
		if (env.MODEL_CONTEXT_WINDOW && Number(env.MODEL_MAX_TOKENS) > Number(env.MODEL_CONTEXT_WINDOW)) invalid("最大输出不能超过上下文窗口");
		try {
			const result: unknown = validate?.(clone(env));
			if (result && typeof (result as Promise<unknown>).then === "function") invalid("配置发布校验必须同步完成");
		} catch (error) {
			if (error instanceof AdminError) throw error;
			throw new SettingsError(400, "runtime_validation_failed", "配置运行时校验失败，原生效版本已保留");
		}
	}
	private mutate(scope: string, input: ApplySettingsInput, update: (next: SettingsStore, state: ScopeState) => void): PublicSettings {
		safeScope(scope);
		if (!record(input) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) invalid("必须提供有效的预期版本");
		if (typeof input.actor !== "string" || !input.actor.trim() || input.actor.length > 256) invalid("配置操作者无效");
		if (mutationLocks.has(this.directory)) throw new SettingsError(409, "settings_busy", "配置正在发布，请刷新后重试");
		mutationLocks.add(this.directory);
		try {
			this.store = this.readStore();
			const next = clone(this.store);
			const state = next.scopes[scope] ?? (next.scopes[scope] = this.emptyScope());
			if (state.revision !== input.expectedRevision) throw new SettingsError(409, "revision_conflict", "配置已被其他管理员修改，请刷新后重试");
			update(next, state);
			state.revision++;
			this.persist(next);
			this.store = next;
			return this.public(scope);
		} catch (error) {
			if (error instanceof AdminError) throw error;
			throw new SettingsError(500, "settings_write_failed", "配置保存失败，原生效版本已保留");
		} finally { mutationLocks.delete(this.directory); }
	}
	private encrypt(store: SettingsStore, scope: string, key: string, plaintext: string): string {
		if (plaintext.length > 16384 || /[\r\n\u0000]/.test(plaintext)) invalid("凭据长度或格式无效");
		const ref = randomUUID();
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
		cipher.setAAD(Buffer.from(`${scope}:${key}:${ref}`));
		const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
		store.credentials[ref] = { scope, key, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64"), keyVersion: 1 };
		return ref;
	}
	private decrypt(ref: string, store: SettingsStore): string {
		try {
			const entry = store.credentials[ref];
			if (!entry || entry.keyVersion !== 1) throw new Error();
			const cipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(entry.nonce, "base64"));
			cipher.setAAD(Buffer.from(`${entry.scope}:${entry.key}:${ref}`));
			cipher.setAuthTag(Buffer.from(entry.tag, "base64"));
			return Buffer.concat([cipher.update(Buffer.from(entry.ciphertext, "base64")), cipher.final()]).toString("utf8");
		} catch { throw new SettingsError(500, "credential_unavailable", "凭据无法解密，请检查原主密钥与配置备份"); }
	}
	private readStore(): SettingsStore {
		const parse = (file: string): SettingsStore => {
			const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!record(raw) || raw.schemaVersion !== 1 || !record(raw.scopes) || !record(raw.credentials) || !raw.scopes.global) throw new Error();
			for (const [scope, state] of Object.entries(raw.scopes)) {
				safeScope(scope);
				if (!record(state) || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0 || !record(state.active) || !Array.isArray(state.history) || state.history.length === 0) throw new Error();
				for (const revision of [state.active, ...state.history]) {
					if (!record(revision) || !Number.isSafeInteger(revision.revision) || (revision.revision as number) < 0 || (revision.revision as number) > (state.revision as number)
						|| typeof revision.actor !== "string" || typeof revision.updatedAt !== "string" || !["migration", "apply", "rollback"].includes(String(revision.action))) throw new Error();
				}
				for (const snapshot of [state.active, state.draft, ...state.history].filter(Boolean)) {
					if (!record(snapshot) || !record(snapshot.values) || !record(snapshot.secretRefs)) throw new Error();
					for (const [key, value] of Object.entries(snapshot.values)) {
						const entry = byKey.get(key);
						if (!entry || entry.secret) throw new Error();
						this.validateValue(entry, value);
					}
					for (const [key, ref] of Object.entries(snapshot.secretRefs)) {
						if (!byKey.get(key)?.secret || (ref !== null && (typeof ref !== "string" || !Object.hasOwn(raw.credentials, ref)))) throw new Error();
						if (typeof ref === "string") {
							const secret = raw.credentials[ref];
							if (!record(secret) || secret.scope !== scope || secret.key !== key) throw new Error();
						}
					}
				}
			}
			const parsed = raw as unknown as SettingsStore;
			for (const ref of Object.keys(parsed.credentials)) this.decrypt(ref, parsed);
			return parsed;
		};
		try { return parse(this.file); }
		catch (primaryError) {
			try { const restored = parse(`${this.file}.previous`); this.recoveryWarning = "配置文件损坏，已恢复最近备份；请核对生效版本"; return restored; }
			catch {
				if (primaryError instanceof SettingsError && primaryError.code === "credential_unavailable") throw primaryError;
				throw new SettingsError(500, "settings_corrupt", "配置文件及备份无法读取，请恢复配置备份");
			}
		}
	}
	private atomicWrite(file: string, data: string): void {
		const temp = `${file}.${randomUUID()}.tmp`;
		try {
			const fd = openSync(temp, "wx", 0o600);
			try { writeFileSync(fd, data, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
			renameSync(temp, file);
		} finally { if (existsSync(temp)) unlinkSync(temp); }
	}
	private persist(next: SettingsStore): void {
		// 先备份内存中已经校验过的版本，绝不将损坏的主文件复制到备份。
		if (existsSync(this.file) && this.store) this.atomicWrite(`${this.file}.previous`, JSON.stringify(this.store));
		this.atomicWrite(this.file, JSON.stringify(next));
		const fd = openSync(this.directory, "r");
		try { fsyncSync(fd); } finally { closeSync(fd); }
	}
}
