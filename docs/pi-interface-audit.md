# Pi 可编程接口审计（v0.87.1 源码一手核实）

> 核实基准：`earendil-works/pi` @ `8676a0dc`（tag `v0.87.1`，2026-09-24）本地 clone + npm 包 `@earendil-works/pi-coding-agent@0.87.1` 拆包
> 核实方式：读源码，非读文档。所有接口签名与字段名均有源码位置。
> 本文件是技术方案的事实基础。**凡与本文件冲突的设计一律以本文件为准。**

## 仓库身份（重要）

- `badlogic/pi-mono` **已重定向到 `earendil-works/pi`**，同一 HEAD、同一批包，全部 `@earendil-works/*`。不存在独立的 pi-mono 源码可交叉验证。
- 旧 npm 名 `@mariozechner/pi-coding-agent` 冻结在 **0.73.1**，落后 14 个小版本。**一律使用 `@earendil-works/*`。**
- 运行时要求 **Node ≥ 22.19.0**（当前环境 Node 24，满足）。
- npm 包**不含 `src/`**，故 `./client` 与 `./experimental/plugin` 的 export map 指向不存在的路径，**从 npm 装无法使用这两个入口**。

---

## 1. SDK 嵌入

**主工厂** — `packages/coding-agent/src/core/sdk.ts:175`

```typescript
export async function createAgentSession(
  options: CreateAgentSessionOptions = {}
): Promise<CreateAgentSessionResult>   // { session, extensionsResult, modelFallbackMessage? }
```

`CreateAgentSessionOptions`（`sdk.ts:41-90`）全部注入点：`cwd`、`agentDir`、`modelRuntime`、`model`、`thinkingLevel`、`scopedModels`、`noTools: "all"|"builtin"`、`tools?: string[]`、`excludeTools`、`customTools?: ToolDefinition[]`、`resourceLoader`、`sessionManager`、`settingsManager`、`sessionStartEvent`。

另导出分阶段构造：`createAgentSessionServices()` / `createAgentSessionFromServices()` / `createAgentSessionRuntime()`；`AgentSessionRuntime` 有 `newSession()` / `switchSession()` / `fork()` / `importFromJsonl()`。

**最小可运行示例**（`examples/sdk/01-minimal.ts`，CI 内有类型检查）：

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();
try {
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  await session.prompt("What files are in the current directory?");
  console.log(session.getLastAssistantText());
} finally {
  session.dispose();
}
```

### 事件体系

基础联合 `AgentEvent`（`packages/agent/src/types.ts:485`），**恰好 11 个成员**：

`agent_start` / `agent_end{messages}` / `turn_start` / `turn_end{message, toolResults}` / `message_start{message}` / `message_update{message, assistantMessageEvent}` / `message_end{message}` / `tool_execution_start{toolCallId, toolName, args}` / `tool_execution_update{..., partialResult}` / `tool_execution_end{toolCallId, toolName, result, isError}`

`AgentSessionEvent`（`core/agent-session.ts:164-205`）把 `agent_end` 加上 `willRetry: boolean`，并新增 14 个 session 事件：`agent_settled`、`queue_update{steering, followUp}`、`compaction_start{reason}`、`compaction_end{...}`、`entry_appended{entry}`、`session_info_changed{name}`、`thinking_level_changed{level}`、`auto_retry_start/end`、`summarization_retry_*`、`bash_execution_update{id?, delta}`。

嵌套 `assistantMessageEvent` 类型：`start`、`text_start|text_delta|text_end`、`thinking_start|thinking_delta|thinking_end`、`toolcall_start|toolcall_delta|toolcall_end`、`done`、`error`，按 `contentIndex` 归组。

> ⚠️ **两条不能搞错的语义**：
> 1. **`agent_end` ≠ 结束**。重试、溢出恢复、压缩、steering、follow-up 都会越过它继续。**`agent_settled` 才是「Pi 不会再自动继续」的唯一信号。**
> 2. **`message_end.message` 是权威值**，不要用增量 delta 自行拼接的结果。

### 系统提示 / 工具 / Provider 注入

三者都走 `ResourceLoader`，**不是 session option**：

```typescript
new DefaultResourceLoader({ cwd, agentDir, systemPromptOverride,
  appendSystemPromptOverride, skillsOverride, agentsFilesOverride,
  additionalExtensionPaths, extensionFactories });
await loader.reload();
```

> ⚠️ **陷阱**（`examples/sdk/03-custom-prompt.ts`）：替换系统提示必须**同时**传 `appendSystemPromptOverride: () => []`，否则 Pi 仍会追加 `APPEND_SYSTEM.md`。

自定义 provider **仅限扩展内** `pi.registerProvider()`，不是 session option。`ResourceLoader` 是 11 个方法的纯接口（见 `examples/sdk/12-full-control.ts`），可为自建宿主完整实现。

### ⛔ 并发：进程内多租户不可行

多个 `AgentSession` 对象可构造（各自持有 `Agent`/`SessionManager`/`ResourceLoader`），但有 **4 个进程级全局单例**破坏隔离：

| # | 全局状态 | 源码位置 | 后果 |
|---|---|---|---|
| 1 | `setDefaultStreamFn(streamSimple)` 在**模块导入时**执行 | `sdk.ts:39` | 进程级默认值 |
| 2 | `configureHttpDispatcher()` 调 `undici.setGlobalDispatcher()` + `undici.install()`，**替换 `globalThis.fetch`** | `core/http-dispatcher.ts:107-112` | 一个租户的 HTTP 超时设置作用于所有租户 |
| 3 | `takeOverStdout()` 用模块级 `stdoutTakeoverState` 猴补 `process.stdout.write`/`stderr.write` | `core/output-guard.ts:7,45-52` | **一个进程只能有一个 RPC/TUI 模式，无例外** |
| 4 | 模块级凭据/模型缓存 `sharedAuthFileReadState`、`sharedModelsFileReadState`、扩展工厂缓存按单一 `extensionCacheCwd` 键 | `core/auth-storage.ts:39`、`core/models-store.ts:24`、`core/extensions/loader.ts:125-127` | 跨租户凭据与扩展串台 |

安全的部分：工具 `cwd` 按 tool factory 捕获（`createBashTool(cwd, …)`），**不是 `process.chdir`**，这块是按 session 隔离的。

**官方无任何并发 session 契约说明，仓库内无任何测试覆盖两个并发活跃 session。**

> **工程判断**：进程内多租户技术上勉强可行（每租户独立 `ModelRuntime`/`SettingsManager`/`SessionManager`/`ResourceLoader`、绝不调 `takeOverStdout`、接受共享 fetch 与共享凭据缓存），但**不是受支持的配置**。任一租户的 `registerProvider()` 或扩展会改动共享注册表。**真隔离只能一会话一进程。**

---

## 2. RPC 模式

**启动**：`pi --mode rpc --no-session`。常规 CLI flag 均可用（`--provider`、`--model`、`--thinking`、`--tools`、`--session-dir`、`--name`、`--approve`…）。**RPC 拒绝 `@file` 形式的 prompt 参数。** 另有专用入口 `@earendil-works/pi-coding-agent/rpc-entry` → `dist/bundle/rpc-entry.js`。

**分帧**：严格 JSONL，一行一个 JSON，LF 结尾。
> ⚠️ 文档明确警告**不要用 Node 的 `readline`**（`docs/rpc.md:54`）——它还会在 U+2028/U+2029 处断行，而这两个字符在 JSON 字符串里是合法的。必须用只按 LF 切分的字节/UTF-8 解码器。

**信封**：扁平结构，**不是 JSON-RPC**。命令 `{id?, type, ...fields}`，响应 `{id?, type:"response", command, success, data?|error}`。**无 `method`/`params`、无 handshake、无协议版本、无认证**——谁能写 stdin 就有完全控制权。

**完整命令集 28 类**（`modes/rpc/rpc-types.ts:20-74`）：
`prompt{message, images?, streamingBehavior?:"steer"|"followUp"}`、`steer{message,images?}`、`follow_up{...}`、`abort`、`clear_queue`、`new_session{parentSession?}`、`get_state`、`set_model{provider,modelId}`、`cycle_model`、`get_available_models`、`set_thinking_level{level}`、`cycle_thinking_level`、`get_available_thinking_levels`、`set_steering_mode{mode:"all"|"one-at-a-time"}`、`set_follow_up_mode{mode}`、`compact{customInstructions?}`、`set_auto_compaction{enabled}`、`set_auto_retry{enabled}`、`abort_retry`、`bash{command, excludeFromContext?}`、`abort_bash`、`get_session_stats`、`export_html{outputPath?}`、`switch_session{sessionPath}`、`fork{entryId}`、`clone`、`get_fork_messages`、`get_entries{since?}`、`get_tree`、`get_last_assistant_text`、`set_session_name{name}`、`get_messages`、`get_commands`。

**关联方式**：可选字符串 `id` 会在响应里回显。命令**异步处理且不 await 派发**，因此**必须按 id 关联，绝不能按顺序**。

**事件输出**：形状与 JSON 模式一致。RPC 特有：`bash_execution_update{id?, delta}`、`extension_error{extensionPath, event, error}`。线上 `message_update` 是**纯增量**——累积 `message` 与所有 `assistantMessageEvent.partial` 快照被剥离，保证流大小线性增长（`docs/json.md:72`）。

**扩展 UI 子协议**：`extension_ui_request{id, method}` 出 / `extension_ui_response{id, value|confirmed|cancelled}` 入，9 个方法：`select`、`confirm`、`input`、`editor`、`notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`。自定义 TUI 组件**不可转发**。

**内置类型化子进程客户端** `RpcClient`（主导出）：`new RpcClient({cliPath, cwd?, env?, provider?, model?, args?})`，然后 `start()`、`onEvent(cb)`、`prompt/steer/followUp/abort`、约 35 个类型化方法、`waitForIdle(timeout?)`、`promptAndWait()`、`stop()`。
> ⚠️ 必须自行提供 `cliPath`；就绪检测只是 100ms sleep + 退出码探测，不可靠。

### ⛔ RPC 的能力缺口（决定架构的关键）

RPC 暴露约 35 个操作；SDK 的 `AgentSession` 暴露约 **90 个成员**，含 `sendCustomMessage()`、`sendUserMessage()`、`setActiveToolsByName()`、`navigateTree()`、`bindExtensions()`、`recordBashResult()`、`getContextUsage()`、`createReplacedSessionContext()`，以及直接访问 `.agent` / `.sessionManager` / `.extensionRunner`。

**RPC 无法以编程方式注册自定义工具或扩展**——扩展必须是磁盘上的文件、由 Pi 自行发现。

> ⚠️ `packages/agent/docs/rpc.md` 是**另一份无关文档**（"Facet Service RPC"，实验性设计稿），不要拿它当本协议参考。

---

## 3. 扩展系统

**模块形态**：`.ts`/`.js` 文件（或含 `index.ts` 的目录），**默认导出工厂** `(pi: ExtensionAPI) => void | Promise<void>`。由 **jiti** 转译，无需构建步骤。异步工厂会在启动前 await，故其中注册的 provider 可用于启动期模型选择。

**钩子数量：恰好 40 个**（`core/extensions/types.ts:1370-1436` 逐个枚举）：

`project_trust`、`resources_discover`、`session_start`、`session_info_changed`、`session_before_switch`、`session_before_fork`、`session_before_compact`、`session_compact`、`session_compact_failed`、`session_shutdown`、`session_before_tree`、`session_tree`、`context`、`context_with_system`、`cache_warming_decision`、`before_provider_request`、`before_provider_headers`、`after_provider_response`、`provider_stream_event`、`before_agent_start`、`agent_start`、`agent_end`、`agent_before_settle`、`agent_settled`、`ui_prompt_start`、`ui_prompt_end`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`model_select`、`thinking_level_select`、`tool_call`、`tool_result`、`user_bash`、`input`

签名：`ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R|void> | R | void`。返回 `undefined` 表示无影响；只有声明了 `R` 的钩子能做变换。

### 本产品所需能力 → 确切钩子映射

| 需求 | 钩子 / API |
|---|---|
| 注入 pre-turn 消息 | `before_agent_start` → `BeforeAgentStartEventResult`；或 `pi.sendMessage(msg, {deliverAs:"nextTurn"})` |
| 过滤/改写历史 | **`context`** → `{messages?: AgentMessage[]}`（无系统消息视图，之后恢复）；`context_with_system` 可完全接管全量 transcript |
| 改系统提示 | `before_agent_start` — 改 `event.systemPromptOptions`，或返回 `systemPrompt`/`forceSystemPrompt` 整体替换 |
| **阻断/改写工具调用** | **`tool_call`** → `{block?: boolean, reason?: string, terminate?: boolean}`；`event.input` **可原地修改**以改参数。⚠️ **改后不再校验** |
| 后处理工具结果 | `tool_result` → `{content?, details?, isError?, usage?}`，多个 handler 可组合 |
| 注册自定义工具 | `pi.registerTool(ToolDefinition)` |
| 斜杠命令 | `pi.registerCommand(name, {description, handler})` |
| 状态持久化进 session | `pi.appendEntry(customType, data)`（不进 LLM 上下文）；`session_start` 时用 `ctx.sessionManager.getBranch()` 重建 |
| 编程式 steering | `pi.sendUserMessage(content, {deliverAs:"steer"｜"followUp"})` |
| 触发压缩 | `ctx.compact()` / `session_before_compact` |
| **动态 skill** | `resources_discover` → `{skillPaths?, promptPaths?, themePaths?}` |

其他：`registerShortcut`、`registerFlag`/`getFlag`、`registerMessageRenderer`、`registerEntryRenderer`、`registerMarkdownTransformer`、`registerProvider`/`unregisterProvider`、`setSessionName`、`setLabel`、`exec`、`getActiveTools`/`getAllTools`/`setActiveTools`、`pi.events`（扩展间总线）。

**加载路径**：`~/.pi/agent/extensions/`、`<cwd>/.pi/extensions/`、`settings.json` 的 `extensions[]`/`packages[]`、`--extension <path>`（`-e`）。项目级扩展**仅在 project trust 之后**加载；只有个人级 + CLI 级扩展能处理 `project_trust` 事件本身。

**`/reload`**：替换**整个**扩展运行时。`await ctx.reload()` 之后的代码不得触碰旧运行时状态；所有内存态扩展状态丢失。清理逻辑要放在**幂等的** `session_shutdown` 里。

### ⚠️ 关于 SubAgent 的重要纠正

官方示例（`examples/extensions/subagent/index.ts`，1038 行）**不是**创建进程内嵌套 session，而是 **spawn 一个子 `pi` 进程**：

```typescript
const args: string[] = ["--mode", "json", "-p", "--no-session"];
if (model) args.push("--model", model);
if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
args.push("--append-system-prompt", tmpPromptPath);   // 系统提示走临时文件
args.push(`Task: ${task}`);
const proc = spawn(invocation.command, invocation.args, {
  cwd: cwd ?? defaultCwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
});
```

随后解析子进程的 JSONL `message_end` 事件并累加用量。Agent 定义是 Markdown 文件（`agents/*.md`）。

**即「扩展可派生 subagent」的真实含义是：基于 `--mode json -p` 的子进程 fan-out。** 不共享任何东西——无 session、无工具、无模型配置、除继承的环境变量外无凭据。代价是每个 subagent 一次完整进程启动。

---

## 4. Session 持久化

**格式 v3 JSONL**，`CURRENT_SESSION_VERSION = 3`。第一行是头 `{type:"session", version, id, timestamp, cwd, parentSession?}`；其后每行是 `SessionEntry`，基础字段 `{type, id, parentId: string|null, timestamp}`，其中 **`id` 是 8 位十六进制**（`randomUUID().slice(0,8)`，做 100 次碰撞检查）。

11 种 entry 类型：`message`、`thinking_level_change`、`model_change`、`usage`、`compaction`、`branch_summary`、`custom`、`custom_message`、`context_edit`、`label`、`session_info`。

**树结构**：`parentId: null` 为根；追加时成为当前叶子的子节点并推进叶子；`branch(id)` 只移动叶子指针（不复制、不删除）；`resetLeaf()` 创建**第二个根**——多根是合法的。

**路径**：`~/.pi/agent/sessions/--<mangled-cwd>--/<ISO时间戳>_<sessionId>.jsonl`
> ⚠️ cwd 编码是**有损的**（`session-manager.ts:590-594`）：`/a/b-c` 与 `/a-b/c` 都塌缩成 `--a-b-c--`。头部的 `cwd` 字段才是权威值。
> 覆盖优先级：`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > settings 的 `sessionDir`。用自定义目录时 cwd 编码被丢弃，列表改为按头部 `cwd` 过滤。

### ⛔ 自定义存储后端：出货路径上不可行

`SessionManager` 硬 import `node:fs`（`appendFileSync`、`openSync`、`writeFileSync`、`readSync`…），**私有构造函数**，且对 SDK 暴露的是**具体类而非接口**：`sessionManager?: SessionManager`。没有可注入的文件系统或存储策略。换 Postgres 需要 fork 这个 2000 行文件。

**部分逃生口**：`SessionManager.inMemory(cwd, options, entries?)` 接受预加载的 `FileEntry[]`——可以从数据库**注水**，但 `persist = false` 意味着不回写。需自行监听 `entry_appended` 事件镜像写入。

**确实存在一套可插拔的 `Storage`/`SessionRepo` 接口**（`packages/agent/src/harness/session/`，格式 4，异步，3 个后端 Memory/JSONL/SQLite，有共享一致性测试套件，SQLite schema 已按 `session_id` 分片）。**但它只接进了 `src/experimental/`**，后端在两个 `new JsonlSessionRepo(...)` 调用点硬编码，**无任何配置/环境变量/flag 开关**，`SqliteSessionRepo` **零消费者**，Postgres 只作为"仅供参考、无规范性约束"的设计注记存在。`harness.md:0.9` 明确列为稳定化前状态：*"shapes may change in place without migrations."*

**恢复**：`--continue`/`-c`（按 mtime 取最近且头部 cwd 匹配的）、`--resume`/`-r`（选择器）、`--session <path|id>`、`--session-id <id>`、`--fork <path|id>`、`--no-session`。编程等价物是 8 个 `SessionManager` 静态方法：`create`、`open`、`continueRecent`、`inMemory`、`forkFrom`、`findById`、`list`、`listAll`。

### ⛔ 并发：硬阻塞

`SessionManager` **零加锁**（grep 验证：无 `lock`/`flock`/`mutex`）。具体隐患：

- 裸 `appendFileSync`，无栅栏、无 mtime 检查
- `_rewriteFile()` 用 `openSync(file, "w")`（**截断**），且在加载期迁移时触发——两个进程打开同一 v1/v2 session，其中一个会静默截断另一个
- 首条 assistant 消息的突发写用 `openSync(file, "wx")`，文件已存在时**直接抛 EEXIST**
- 全程无 `fsync`
- `loadEntriesFromFile` **读取时会追加一个换行**（读操作即写操作）
- 畸形行被静默跳过——撕裂的追加写是静默数据丢失

仓库内每个后端都假定**每个 session 恰好一个可写 owner，且由宿主强制保证**。SQLite 后端的 README 明说它不实现"跨进程 lease、lock、fence、heartbeat 或 takeover"。

**另：`SessionManager.list()` 通过流式读取每个 session 文件的每一行来计算 `allMessagesText`；`listAll()` 遍历每个项目目录。O(所有字节)——SaaS 规模下不可用，必须自建索引，Pi 侧无分页。**

---

## 5. Steering 编程接口

**TUI 来源**：运行中 `Enter` = steer（`app.message.submit`）；`Alt+Enter`（Windows/WSL 上是 `Ctrl+Q`）= follow-up；`Alt+Up` = 出队回编辑器；`Escape` = abort。abort 会把排队消息退回编辑器。

**SDK**（`core/agent-session.ts:1860,1872`）：

```typescript
await session.steer(text, images?, { source? });     // 当前 turn 及其工具调用之后
await session.followUp(text, images?, { source? });  // 整个 run 处理完待办之后
```

> ⚠️ 流式进行中调 `prompt()` 会**抛异常**，除非传 `streamingBehavior: "steer" | "followUp"`——Pi 拒绝猜测意图（`agent-session.ts:1655`）。
> 队列模式：`setSteeringMode("all" | "one-at-a-time")`，默认 `one-at-a-time`。

**RPC**：`{"type":"steer","message":...}` / `{"type":"follow_up",...}`，加 `set_steering_mode`、`clear_queue`（返回被清空的文本），以及携带**完整当前队列**的 `queue_update{steering, followUp}` 事件。

### 精确投递语义（对照 `packages/agent/src/agent-loop.ts:174-300` 验证）

**steering 不是工具执行中的打断。** 循环在 run 开始时轮询 `getSteeringMessages()`，之后在每个 `turn_end` 后轮询，然后仅当之前那次轮询为空时在 `prepareNextTurn` 后再轮询一次（防止 one-at-a-time 模式重复投递）。

因此 steering 消息**落在当前 assistant turn 及其全部工具调用完成之后、下一次 provider 请求之前**。**它永不取消执行中的工具——只有 `abort()` 能。** follow-up 仅在外层循环中、无更多工具调用且无 steering 时轮询。`prepareRequest` **不轮询队列**：在它执行期间入队的 steering 要等下一次常规轮询。

> 💡 **对产品的含义**：Spec 里「任务执行中可继续对话」若期望"立刻打断当前动作"，与 Pi 语义不符。正确的产品表达是「已插入，将在当前步骤完成后送达」——这恰好是原型里应当呈现的措辞。

---

## 6. 工具与权限

**内置 9 个注册、4 个默认激活**。默认激活：`read`、`bash`、`edit`、`write`。另有 `grep`、`find`、`ls`、`powershell`（Windows）。

确切 TypeBox schema（`core/tools/*.ts` 核实）：

| 工具 | 参数 |
|---|---|
| `bash` | `{command: string, timeout?: number}` —— 秒；**无默认超时** |
| `read` | `{path: string, offset?: number /*1-indexed*/, limit?: number}` |
| `write` | `{path: string, content: string}` |
| `edit` | `{path: string, edits: Array<{oldText, newText}>}` —— 每个 `oldText` 须在文件内唯一、对照**原始文件**匹配（非增量）、互不重叠 |
| `grep` | `{pattern, path?, glob?, ignoreCase?, literal?, context?, limit? /*100*/}` |
| `find` | `{pattern, path?, limit? /*1000*/}` |
| `ls` | `{path?, limit? /*500*/}` |

**自定义工具格式**（`core/extensions/types.ts:461`）—— 用 **TypeBox**（`typebox`），不是 zod：

```typescript
interface ToolDefinition<TParams extends TSchema, TDetails, TState> {
  name: string; label: string; description: string;
  parameters: TParams;                    // TypeBox schema
  promptSnippet?: string; promptGuidelines?: string[];
  executionMode?: "sequential" | "parallel";
  prepareArguments?: (args: unknown) => Static<TParams>;
  execute(toolCallId: string, params: Static<TParams>,
          signal: AbortSignal | undefined,
          onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
          ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>;
  renderCall?(...); renderResult?(...);
}
```

返回 `{content: [...], details}`。**抛异常**才产生错误结果——返回对象永不标记为错误。用 `defineTool()` 在数组中保留参数类型推导。

### 权限门：`tool_call` 是拦截点

返回 `{block?: boolean, reason?: string, terminate?: boolean}`；`event.input` 可原地改写参数。默认拒绝 + 白名单只需几行。

**两条对我们有利的 fail-safe 特性**：
1. **`tool_call` handler 抛异常即阻断工具**（文档明示的 fail-safe）
2. 官方 `permission-gate.ts` 示例在 `!ctx.hasUI` 时**默认阻断**——正是无头 SaaS 的正确行为

更底层：`pi-agent-core` 的 `Agent` config 还有 `beforeToolCall`/`afterToolCall`，若自行构建 agent 可用。

### ⛔ bash 沙箱：原生不存在

仓库 README 原话：*"Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it."*

`docs/security.md` 补充：观察 transcript 与 project trust *"do not create a security boundary"*，project trust *"does not limit what tool calls can access or affect."*

官方隔离选项（`docs/containerization.md`），**只有前两种隔离整个进程**：
1. **普通 Docker**（整进程；文档自带 Dockerfile）
2. **Docker Sandboxes**（整进程；代理让真实 provider key 留在宿主）
3. **OpenShell**（策略控制的沙箱）
4. **Gondolin 扩展**（仅工具跑微虚机，Pi 与其他扩展仍在宿主——边界更窄）

> 注意：整进程隔离也会把你的扩展一起搬进边界内。

**工具级重定向钩子**：每个内置工具都接受可插拔的 `*Operations`（`BashOperations`、`ReadOperations`…），文档明确说是*"to delegate to remote systems (for example SSH)"*；另有 `user_bash` → `{operations}|{result}` 处理 `!` 命令。
> 💡 **这是把执行路由到按租户沙箱的干净接缝，无需 fork。**

---

## 7. Skill 机制

**格式**：含 `SKILL.md`（YAML frontmatter）的目录。Pi 实现 [Agent Skills 规范](https://agentskills.io/specification)；多数非法字段告警而非失败。

解析字段（`core/skills.ts:67-81`）：`name`、`description`、`disable-model-invocation`，外加透传 `[key: string]: unknown`。规范另含 `license`、`compatibility`、`metadata`、`allowed-tools`（实验性）。内部 `Skill` = `{name, description, filePath, baseDir, sourceInfo, disableModelInvocation}`。

**校验**：name 须匹配 `/^[a-z0-9-]+$/`、无前后缀连字符与连续连字符、≤64 字符；description ≤1024。畸形文件与无 description 的 skill **不加载**。同名冲突保留首个发现者并告警。Pi **不要求** name 与父目录同名。

**发现路径**：`~/.pi/agent/skills/`、`<cwd>/.pi/skills/`，加 Agent Skills 标准位置 `~/.agents/skills/` 与 `.agents/skills/`（后者自 cwd 向上遍历至 repo root）。递归。项目级 skill 需 project trust。

### 渐进式披露的确切机制（`core/skills.ts:355-380`）

启动时 Pi 只把 name + description + **绝对路径**注入系统提示，XML 形式：

```xml
<available_skills>
  <skill><name>…</name><description>…</description><location>/abs/path/SKILL.md</location></skill>
</available_skills>
```

附指令 *"Use the read tool to load a skill's file when the task matches its description"*（`read` 未激活时用 bash）。

> ⚠️ **没有专门的 skill 加载工具——触发方式就是对所告知路径发起一次普通 `read` 工具调用。**
> 两个后果：① 禁用 `read`/`bash` 会使模型自主调用 skill 失效；② **skill 路径必须对工具所在的沙箱可读**。

强制调用是 `/skill:name [args]`，宿主侧展开（`agent-session.ts:1797`）为 `<skill name="…" location="…">…</skill>` 加参数作为用户请求。`disable-model-invocation: true` 限制该 skill 只能显式命令调用。

**动态注册：可以，两种方式，无需文件系统扫描**
1. **`resources_discover` 钩子** → `{skillPaths?, promptPaths?, themePaths?}`（`examples/extensions/dynamic-resources/index.ts`），reason 为 `"startup" | "reload"`
2. **`DefaultResourceLoader` 的 `skillsOverride`** —— 用 `createSyntheticSourceInfo()` 在内存中完整构造 `Skill` 对象（`examples/sdk/04-skills.ts`）

> ⚠️ 两者仍要求 `filePath` 指向 **`read` 工具能真正打开**的东西，因为正文是那样加载的。故"无需文件系统"只对一半——**发现过程可编程控制，但正文必须落在某个路径上**。

---

## ⚠️ 关键未知（按阻塞程度排序）

1. **进程内并发多 session 无文档、无测试**。无契约、无测试，且有 4 个进程级全局单例。**任何进程内多租户设计前必须先做 spike 验证**：写一个双并发 session 测试台，用不同凭据，断言无串台。
2. **出货路径上无存储抽象**。数据库化 session 要么 fork `session-manager.ts`（约 2000 行），要么押注实验性的格式 4 `Storage`/`SessionRepo`（其文档自称 shapes *"may change in place without migrations"*）。**二选一是最大的架构决策，无法从源码层面替你决定。**
3. **session 文件零加锁 + EEXIST/截断风险**。两个 worker 碰同一 session 文件必然静默截断或硬抛。**须自建分布式租约层，Pi 不提供任何东西。**
4. **`SessionManager.list()` 是 O(所有 session 的所有字节)**。租户的会话列表/浏览需自建索引，Pi 侧无分页。
5. **按租户凭据隔离未验证**。`ModelRuntime.create({authPath, modelsPath})` 加 `setRuntimeApiKey()` 暗示按租户 runtime 可行，但 `sharedAuthFileReadState`/`sharedModelsFileReadState` 是模块级全局、按单一路径键。N 个 runtime 未经测试。
6. **无按工具的超时/资源上限**。bash **无默认超时**（`timeout` 由模型提供且可选）。需外部墙钟与内存上限。
7. **扩展层面无租户隔离**。扩展天生进程级——`registerProvider` 改动共享注册表，reload 替换整个运行时。**共享进程内的按租户扩展不安全。**
8. **`packages/agent/docs/harness.md` §0.9 列出了活跃的契约债务**（`watchSession` 抛 `SliceNotImplemented`；WP08 运行中 fork；ownership 语义仍是 open TODO）。在锁定版本上使用格式 4 特性前须重读该节。

---

## 工程建议（审计结论）

### 选「每会话一个子进程」，而非进程内 SDK

理由按优先级：

1. **隔离是硬需求，而进程边界是 Pi 唯一真正提供的隔离**。Pi 无内部权限系统、无 bash 沙箱、有 4 个进程级全局单例。官方对"如何约束它"的回答就是容器化进程——README、`security.md`、`containerization.md` 三处都这么说。按会话一进程把隔离单元对齐到 Pi 唯一的真实边界，并可按租户再嵌套 Docker/gVisor/微虚机。
2. **仅 stdout 猴补一项就否决了替代方案**。`takeOverStdout()` 通过模块级状态改 `process.stdout.write`——一进程一个 RPC/TUI 模式是结构性限制，不是 bug。
3. **崩溃与泄漏收敛**。OOM、失控 bash、行为异常的扩展只杀掉一个租户的子进程，不会拖垮网关。进程内则全体遭殃。
4. **Pi 自己的 subagent 示例已验证该模式**——子进程 `pi --mode json -p` + JSONL 解析就是官方出货的 fan-out 机制。
5. **RPC 面覆盖了所需控制面**：prompt/steer/follow_up/abort/clear_queue、模型与思考档切换、压缩、session fork/clone/switch、`get_entries`/`get_tree` 做状态同步，以及直到 `agent_settled` 的完整事件流。

### 但子进程内部用 SDK，不用现成 CLI（混合模式，推荐终态）

因为 **RPC 无法编程注册自定义工具与权限门，而这两项对 SaaS 都是硬需求**。混合模式下：
- 保留一会话一进程的隔离
- 进程内可用 `registerTool`、`tool_call` 权限门、`ResourceLoader`、自定义 `SessionManager` 注水路径
- 代价是维护一个瘦宿主二进制；收益是拿到约 90 个成员的完整 `AgentSession` API 而非 RPC 的 35 个

### 必须显式接受的代价

- **每会话进程启动开销** —— 用按 租户+cwd 键的温池缓解
- **session 存储先维持 JSONL** —— 每租户独立 `--session-dir`，通过事件流镜像到数据库，**不要第一天就替换后端**
- **自建会话索引** —— 不要依赖 `SessionManager.list()`
- **自建分布式租约** —— 保证每个 session 文件同时只有一个可写 owner
