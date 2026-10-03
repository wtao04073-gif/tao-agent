export interface RagConfig {
    chunkChars: number;
    overlapChars: number;
    endpoint: string;
    model: string;
    apiKey?: string;
    dimensions?: number;
    revision: string;
    queryPrefix: string;
    documentPrefix: string;
    mode: "semantic" | "hybrid";
    minSimilarity: number;
}
export function parseRagConfig(env: Record<string, string | undefined>): RagConfig | undefined {
    if (env.RAG_REQUIRED !== undefined && env.RAG_REQUIRED !== "true" && env.RAG_REQUIRED !== "false")
        throw new Error("RAG_REQUIRED 必须为 true 或 false");
    const endpoint = env.EMBEDDING_ENDPOINT?.trim(), model = env.EMBEDDING_MODEL?.trim();
    if (!endpoint && !model && !env.EMBEDDING_API_KEY && !env.RAG_MODE && env.RAG_REQUIRED !== "true")
        return undefined;
    if (!endpoint || !model)
        throw new Error("必须同时配置 EMBEDDING_ENDPOINT 与 EMBEDDING_MODEL");
    let url: URL;
    try {
        url = new URL(endpoint);
    }
    catch {
        throw new Error("EMBEDDING_ENDPOINT 地址无效");
    }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
        throw new Error("嵌入地址须为 HTTPS 或本机 HTTP，不能含凭据和查询参数");
    const dimensions = env.EMBEDDING_DIMENSIONS ? Number(env.EMBEDDING_DIMENSIONS) : undefined;
    if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192))
        throw new Error("EMBEDDING_DIMENSIONS 须为1至8192的整数");
    const mode = env.RAG_MODE ?? "hybrid", minSimilarity = Number(env.RAG_MIN_SIMILARITY ?? 0.35);
    if (mode !== "hybrid" && mode !== "semantic")
        throw new Error("RAG_MODE 仅支持 hybrid 或 semantic");
    if (!Number.isFinite(minSimilarity) || minSimilarity < -1 || minSimilarity > 1)
        throw new Error("RAG_MIN_SIMILARITY 须在-1至1之间");
    const chunkChars = Number(env.RAG_CHUNK_CHARS ?? 800), overlapChars = Number(env.RAG_CHUNK_OVERLAP_CHARS ?? 100);
    if (!Number.isInteger(chunkChars) || chunkChars < 100 || chunkChars > 8000 || !Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= chunkChars)
        throw new Error("RAG切片长度和重叠配置无效");
    return { chunkChars, overlapChars, endpoint, model, ...(env.EMBEDDING_API_KEY ? { apiKey: env.EMBEDDING_API_KEY } : {}), ...(dimensions === undefined ? {} : { dimensions }), revision: env.EMBEDDING_REVISION ?? "1", queryPrefix: env.EMBEDDING_QUERY_PREFIX ?? "", documentPrefix: env.EMBEDDING_DOCUMENT_PREFIX ?? "", mode, minSimilarity };
}
