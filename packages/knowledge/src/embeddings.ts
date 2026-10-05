import { createHash } from "node:crypto";
export interface EmbeddingProvider {
    readonly space: string;
    embed(texts: readonly string[], kind: "document" | "query", signal?: AbortSignal): Promise<number[][]>;
}
export class EmbeddingError extends Error {
}
export function normalizeVector(value: unknown, dimensions?: number): number[] {
    if (!Array.isArray(value) || !value.length || value.length > 8192 || (dimensions !== undefined && value.length !== dimensions) || value.some(v => typeof v !== "number" || !Number.isFinite(v)))
        throw new EmbeddingError("嵌入向量维度或数值无效");
    const norm = Math.hypot(...value);
    if (!Number.isFinite(norm) || norm === 0)
        throw new EmbeddingError("嵌入向量不能为零或非有限值");
    return value.map(v => v / norm);
}
/** OpenAI 兼容 Embeddings 协议；服务商和模型由部署方明确配置。 */
export class HttpEmbeddings implements EmbeddingProvider {
    readonly space: string;
    private active = 0;
    private readonly waiting: (() => void)[] = [];
    private readonly options: {
        endpoint: string;
        model: string;
        apiKey?: string;
        dimensions?: number;
        revision?: string;
        queryPrefix?: string;
        documentPrefix?: string;
        timeoutMs?: number;
        fetch?: typeof fetch;
    };
    constructor(options: HttpEmbeddings["options"]) {
        const url = new URL(options.endpoint);
        if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
            throw new EmbeddingError("嵌入服务地址须为 HTTPS 或本机 HTTP，且不含凭据与查询参数");
        if (!options.model.trim() || (options.dimensions !== undefined && (!Number.isInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 8192)))
            throw new EmbeddingError("嵌入模型或维度配置无效");
        this.options = { ...options };
        this.space = createHash("sha256").update(JSON.stringify([url.href, options.model, options.dimensions ?? null, options.revision ?? "1", options.queryPrefix ?? "", options.documentPrefix ?? ""])).digest("hex");
    }
    async embed(texts: readonly string[], kind: "document" | "query", signal?: AbortSignal): Promise<number[][]> {
        signal?.throwIfAborted();
        if (this.waiting.length >= 64)
            throw new EmbeddingError("嵌入请求队列已满，请稍后重试");
        await new Promise<void>((resolve, reject) => {
            const abort = () => { const i = this.waiting.indexOf(start); if (i >= 0)
                this.waiting.splice(i, 1); reject(signal?.reason); };
            const start = () => { signal?.removeEventListener("abort", abort); this.active++; resolve(); };
            if (this.active < 2)
                start();
            else {
                this.waiting.push(start);
                signal?.addEventListener("abort", abort, { once: true });
                if (signal?.aborted)
                    abort();
            }
        });
        try {
            signal?.throwIfAborted();
            return await this.run(texts, kind, signal);
        }
        finally {
            this.active--;
            this.waiting.shift()?.();
        }
    }
    private async run(texts: readonly string[], kind: "document" | "query", signal?: AbortSignal): Promise<number[][]> {
        if (texts.some(t => typeof t !== "string" || !t.trim() || t.length > 16000))
            throw new EmbeddingError("嵌入文本为空或超出长度限制");
        const output: number[][] = [];
        let dimensions = this.options.dimensions;
        for (let i = 0; i < texts.length; i += 16) {
            const batch = texts.slice(i, i + 16), prefix = kind === "query" ? this.options.queryPrefix ?? "" : this.options.documentPrefix ?? "";
            const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30000);
            const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
            try {
                const res = await (this.options.fetch ?? fetch)(this.options.endpoint, { method: "POST", redirect: "error", signal: abort, headers: { "Content-Type": "application/json", ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) }, body: JSON.stringify({ model: this.options.model, input: batch.map(t => prefix + t), encoding_format: "float", ...(this.options.dimensions === undefined ? {} : { dimensions: this.options.dimensions }) }) });
                if (!res.ok) {
                    await res.body?.cancel();
                    throw new EmbeddingError(`嵌入服务返回 HTTP ${res.status}，请检查服务配置或限额`);
                }
                if (!res.body)
                    throw new EmbeddingError("嵌入服务返回空内容");
                const reader = res.body.getReader();
                const buffers: Uint8Array[] = [];
                let size = 0;
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        size += value.byteLength;
                        if (size > 8 * 1024 * 1024)
                            throw new EmbeddingError("嵌入响应超过限制");
                        buffers.push(value);
                    }
                }
                finally {
                    await reader.cancel().catch(() => { });
                }
                const json = JSON.parse(Buffer.concat(buffers).toString("utf8")) as {
                    data?: {
                        index: number;
                        embedding: unknown;
                    }[];
                };
                if (!Array.isArray(json.data) || json.data.length !== batch.length)
                    throw new EmbeddingError("嵌入响应条数不匹配");
                const rows = [...json.data].sort((a, b) => a.index - b.index);
                for (let j = 0; j < rows.length; j++) {
                    const row = rows[j]!;
                    if (row.index !== j)
                        throw new EmbeddingError("嵌入响应序号无效");
                    const vector = normalizeVector(row.embedding, dimensions);
                    dimensions ??= vector.length;
                    output.push(vector);
                }
            }
            catch (error) {
                if (signal?.aborted)
                    throw signal.reason;
                if (error instanceof EmbeddingError)
                    throw error;
                throw new EmbeddingError("嵌入服务不可用、超时或响应无效，请重试；当前有效索引保持不变");
            }
        }
        return output;
    }
}
