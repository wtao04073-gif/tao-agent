import { checkAccess, KeywordRetriever, type Chunk, type Membership, type SearchHit } from "@tao/core";
import { type EmbeddingProvider, normalizeVector } from "./embeddings.ts";
export interface VectorIndex {
    space: string;
    dimensions: number;
    chunkIds: string[];
    vectors: number[][];
}
export interface VectorDocument {
    chunks: readonly Chunk[];
    index?: VectorIndex;
}
export class RagIndexError extends Error {
}
export async function indexChunks(provider: EmbeddingProvider, chunks: readonly Chunk[], signal?: AbortSignal): Promise<VectorIndex> {
    const rows = await provider.embed(chunks.map(c => c.text), "document", signal);
    if (rows.length !== chunks.length || !rows.length)
        throw new RagIndexError("嵌入数量不匹配");
    const dimensions = rows[0]!.length;
    return { space: provider.space, dimensions, chunkIds: chunks.map(c => c.id), vectors: rows.map(v => normalizeVector(v, dimensions)) };
}
/** 精确向量索引适用于当前单进程规模；先鉴权，再计算相似度和融合名次。 */
export async function retrieveVectors(input: {
    provider: EmbeddingProvider;
    documents: readonly VectorDocument[];
    membership: Membership;
    query: string;
    limit?: number;
    mode?: "semantic" | "hybrid";
    minScore?: number;
    knowledgeBaseIds?: readonly string[];
    signal?: AbortSignal;
}): Promise<SearchHit[]> {
    const { provider, membership } = input, limit = input.limit ?? 6, threshold = input.minScore ?? 0.35;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isFinite(threshold) || threshold < -1 || threshold > 1)
        throw new RagIndexError("检索参数无效");
    const candidates: {
        chunk: Chunk;
        vector: number[];
    }[] = [];
    for (const document of input.documents) {
        const visible = document.chunks.map((chunk, i) => ({ chunk, i })).filter(({ chunk }) => checkAccess(membership, chunk, "read").allowed && (!input.knowledgeBaseIds || input.knowledgeBaseIds.includes(chunk.knowledgeBaseId)));
        if (!visible.length)
            continue;
        const index = document.index;
        if (!index || index.space !== provider.space || index.chunkIds.length !== document.chunks.length || index.vectors.length !== document.chunks.length)
            throw new RagIndexError("知识向量缺失或模型已变更，请先重建索引");
        for (const { chunk, i } of visible) {
            if (index.chunkIds[i] !== chunk.id)
                throw new RagIndexError("片段与向量版本不一致，请重建索引");
            candidates.push({ chunk, vector: normalizeVector(index.vectors[i], index.dimensions) });
        }
    }
    if (!candidates.length || !input.query.trim())
        return [];
    const queryRows = await provider.embed([input.query], "query", input.signal);
    if (queryRows.length !== 1)
        throw new RagIndexError("查询嵌入数量不匹配");
    const query = normalizeVector(queryRows[0]);
    const semantic = candidates.map(({ chunk, vector }) => {
        if (vector.length !== query.length)
            throw new RagIndexError("嵌入维度已变化，请重建索引");
        return { chunk, score: Math.max(-1, Math.min(1, vector.reduce((sum, v, i) => sum + v * query[i]!, 0))) };
    }).filter(h => h.score >= threshold).sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id)).slice(0, Math.max(20, limit * 3));
    if (input.mode === "semantic")
        return semantic.slice(0, limit);
    const keyword = await new KeywordRetriever(candidates.map(c => c.chunk)).search(membership, { query: input.query, limit: Math.max(20, limit * 3) });
    const merged = new Map<string, SearchHit>();
    for (const list of [semantic, keyword])
        list.forEach((hit, rank) => { const prior = merged.get(hit.chunk.id); merged.set(hit.chunk.id, { chunk: hit.chunk, score: (prior?.score ?? 0) + 1 / (60 + rank + 1) }); });
    return [...merged.values()].sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id)).slice(0, limit);
}
