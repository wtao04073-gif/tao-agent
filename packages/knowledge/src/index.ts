/**
 * @tao/knowledge —— 知识库检索与入库
 *
 * 不接触 vendor/pi —— 工具经 @tao/core 的 PlatformTool 接口暴露。
 *
 * 与 @tao/office 的分工：office 管文件格式读写，knowledge 管检索与权限。
 * 混在一起会让 office 包依赖租户模型，边界就糊了。
 */

export {
	createKnowledgeToolset,
	ingestIntoStore,
	KNOWLEDGE_TOOL_POLICIES,
	type KnowledgeStore,
	type KnowledgeToolsetOptions,
} from "./toolset.ts";
export { MemoryKnowledgeStore } from "./memory-store.ts";

// ── 修改意见回写（M3-3）──
export { MemoryLessonStore } from "./memory-lesson-store.ts";
export {
	extractDocumentRevisions,
	extractTableRevisions,
	REWRITE_THRESHOLD,
	type ComparableParagraph,
	type ComparableTable,
	type ExtractResult,
} from "./revision-extract.ts";

// ── 模板与口径资产（M3-4）──
export { MemoryAssetStore } from "./memory-asset-store.ts";

// ── 计量与配额（M4-1）──
export { MemoryMeteringStore } from "./memory-metering-store.ts";
