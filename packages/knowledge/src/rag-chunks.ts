import type { Chunk } from "@tao/core";
/** 在原文段落/标题切片基础上限制嵌入输入长度，保留来源与版本。字符预算不是token预算。 */
export function boundRagChunks(chunks: readonly Chunk[], maxChars = 800, overlapChars = 100): Chunk[] {
    if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 8000 || !Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars)
        throw new Error("RAG切片长度或重叠配置无效");
    return chunks.flatMap(chunk => {
        const chars = Array.from(chunk.text);
        if (chars.length <= maxChars)
            return [chunk];
        const result: Chunk[] = [];
        for (let offset = 0; offset < chars.length; offset += maxChars - overlapChars) {
            result.push({ ...chunk, id: `${chunk.id}:s${offset}`, text: chars.slice(offset, offset + maxChars).join("") });
            if (offset + maxChars >= chars.length)
                break;
        }
        return result;
    });
}
