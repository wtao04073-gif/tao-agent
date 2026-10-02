/**
 * 通用 JSON 文件存储
 *
 * 给「数量少、读多写少、整条覆盖」的对象用：技能、智能体。
 * `<dir>/<collection>/<id>.json`，原子写（临时文件 + rename），按记录内
 * tenantId/workspaceId 过滤做租户隔离。集合可要求 id 白名单（默认安全字符）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface TenantScoped {
	tenant: { tenantId: string; workspaceId: string };
}

export interface FileJsonStoreOptions<T> {
	readonly dir: string;
	readonly collection: string;
	/** 从一条记录取主键 id。 */
	readonly idOf: (item: T) => string;
}

export class FileJsonStore<T extends TenantScoped> {
	private readonly colDir: string;
	private readonly idOf: (item: T) => string;

	constructor(options: FileJsonStoreOptions<T>) {
		this.idOf = options.idOf;
		this.colDir = join(options.dir, options.collection);
		mkdirSync(this.colDir, { recursive: true });
	}

	private safe(id: string): boolean {
		return /^[A-Za-z0-9_-]+$/.test(id);
	}

	private path(id: string): string {
		return join(this.colDir, `${id}.json`);
	}

	create(item: T): boolean {
		const id = this.idOf(item);
		if (!this.safe(id)) throw new Error(`非法 id：${id}`);
		if (existsSync(this.path(id))) return false;
		this.writeAtomic(id, item);
		return true;
	}

	put(item: T): void {
		const id = this.idOf(item);
		if (!this.safe(id)) throw new Error(`非法 id：${id}`);
		this.writeAtomic(id, item);
	}

	get(id: string): T | undefined {
		if (!this.safe(id) || !existsSync(this.path(id))) return undefined;
		try {
			return JSON.parse(readFileSync(this.path(id), "utf8")) as T;
		} catch {
			return undefined;
		}
	}

	remove(id: string): void {
		if (!this.safe(id)) return;
		try { rmSync(this.path(id), { force: true }); } catch { /* 忽略 */ }
	}

	listByTenant(tenantId: string, workspaceId: string): readonly T[] {
		const out: T[] = [];
		for (const name of readdirSync(this.colDir)) {
			if (!name.endsWith(".json")) continue;
			try {
				const item = JSON.parse(readFileSync(join(this.colDir, name), "utf8")) as T;
				if (item.tenant.tenantId === tenantId && item.tenant.workspaceId === workspaceId) {
					out.push(item);
				}
			} catch {
				// 跳过坏文件
			}
		}
		return out;
	}

	private writeAtomic(id: string, item: T): void {
		const final = this.path(id);
		const tmp = `${final}.tmp-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
		writeFileSync(tmp, JSON.stringify(item) + "\n", { encoding: "utf8" });
		renameSync(tmp, final);
	}
}
