# Pi 架构基线（官方信源核实版）

> 信源：官网 https://pi.dev/ （WebFetch 正文）+ 多个独立技术资料交叉验证
> 核实时间：2026-09-24
> ⚠️ 本文件取代早前基于内部文档的推断性理解。早前误认为 Pi 自带 subagent 等能力，实为错误。

## 一句话定位

**Pi 是一个极简的 coding agent harness（runtime 层），不是产品，也不是模型。**

官网原话：
- "There are many agent harnesses but this one is yours"
- "a minimal agent harness"
- "Adapt Pi to your workflows, not the other way around"
- "Pi isn't a sealed product"
- 设计哲学：**"Primitives, not features"**

## 归属与授权

| 项 | 内容 |
|---|---|
| 原作者 | Mario Zechner（libGDX 作者），2025 年末发布 |
| 当前归属 | **2026 年 4 月被 Earendil Inc. 收购**；Earendil 另推商业云平台 **Lefos** |
| 官方包 | `@earendil-works/pi-coding-agent`（npm） |
| 仓库 | `earendil-works/pi`（Earendil 版）、`badlogic/pi-mono`（原始 monorepo） |
| 许可 | **MIT** |
| 模型成本 | 自带 provider 凭据（API key 或 OAuth），直接付给模型厂商 |

> ⚠️ **商业授权需注意**：MIT 协议本身允许商业闭源使用与再分发（保留版权声明即可），但 Pi 已被 Earendil 收购并推出竞争性商业云平台 Lefos，需确认所使用版本的协议状态未变更。

## 核心设计：刻意的极简

### 仅 4 个内置工具

| 工具 | 说明 |
|------|------|
| `read` | 读文件、图片、目录、glob 模式，支持行范围 |
| `write` | 创建文件及父目录 |
| `edit` | 精确字符串搜索替换，输出 unified diff |
| `bash` | Shell 命令执行，带超时处理（Windows 下换 powershell） |

另有只读的 `grep` / `find` / `ls`。**系统提示词不到 1000 token**（部分资料称约 200）。

### ⚠️ 官方明确「没有做」的能力（每项都需自建）

| 缺失能力 | 官方给的替代路径 |
|---|---|
| **MCP 支持** | 带 README 的 CLI 工具，或写 extension 加 MCP |
| **SubAgent** | tmux 起多个 Pi 实例、写 extension、或用第三方 package |
| **权限弹窗** | 容器隔离，或自定义确认流 |
| **Plan mode** | plan 文件、extension、或 package |
| **内置 TodoList** | TODO.md 文件，或 extension |
| **后台 bash** | tmux（理由：完整可观测性 + 可直接交互） |

**设计论点**：RL 训练的前沿模型推理能力已足够，**厚脚手架是给弱模型的权宜之计**；真正的瓶颈是 context window，框架开销反而有害。作者举例反对 MCP 的理由：某些 MCP server 会往 context 里塞 13,700+ token。

## 可复用的能力与原语

### 分层包结构（可单独取用，不必整套采纳）

| 包 | 作用 |
|---|---|
| `pi-ai` | **统一多 provider LLM API**：归一化 4 种 wire protocol（OpenAI Completions / OpenAI Responses / Anthropic Messages / Google GenAI），15+ provider、数百模型，支持中途换模型与跨 provider 上下文交接 |
| `pi-agent-core` | Agent loop 本身（刻意极简）、Agent 类、状态管理 |
| `pi-coding-agent` | 完整 CLI 运行时：JSONL 会话持久化、上下文压缩、Skill 系统、extension 系统 |
| `pi-tui` | 终端 UI 框架（retained-mode 差分渲染） |
| `pi-web-ui` | **Lit 实现的 Web 聊天界面组件库** |
| `pi-pods` | 管理 GPU pod 上 vLLM 部署的 CLI |
| `pi-mom` | Slack bot，把消息委派给 coding agent |

> 💡 **对本产品的价值**：`pi-ai` 的 provider 归一化层可直接解决「模型可热替换」需求；`pi-web-ui` 可作为 Web 前端起点。

### 四种运行模式（决定如何嵌入自有产品）

1. **Interactive** — 完整 TUI 体验
2. **Print / JSON** — `pi -p "query"` 供脚本调用，`--mode json` 输出事件流
3. **RPC** — **stdin/stdout 上的 JSON 协议，供非 Node 集成**
4. **SDK** — 把 Pi 嵌入其他应用

> 💡 **对本产品的价值**：SDK 与 RPC 两种模式是把 Pi 作为内层 runtime 嵌入自有服务的官方路径。

### Session：树状 append-only DAG

- 存储为 `.jsonl`，每条含唯一 ID 与可选 parent ID
- `/tree` 可回到任意历史点并从那里分叉，**所有分支存在同一文件内**
- 支持按消息类型过滤、bookmark 标签
- `/export` 导出 HTML；`/share` 上传 gist 并返回渲染 URL
- 支持**会话中途跨 provider 换模型**

### Extension 系统（能力扩展的唯一正道）

- **20+ 生命周期钩子**：修改送达 LLM 前的消息、阻断工具调用、加自定义工具与斜杠命令、注册快捷键、把状态持久化进 session
- 可实现：**注入 pre-turn 消息（feedforward context）、过滤消息历史（上下文管理）、实现 RAG、构建长期记忆**
- 官方示例列举：sub-agents、plan mode、权限门、路径保护、SSH 执行、沙箱、MCP 集成、自定义编辑器、状态栏、overlay
- **运行时 TypeScript 编译，无需预编译**；`/reload` 热加载、不重启
- 社区 extension 目录 2026 年初已超 2,000 个 package（`未核实`）

### Skill：渐进式披露

- 遵循 Agent Skills 标准，`/skill:name` 手动调用或由 agent 按上下文自动触发
- **按需加载 —— "Progressive disclosure without busting the prompt cache"**

### Steering：中途插话机制（⭐ 对本产品关键）

| 操作 | 行为 |
|---|---|
| `Enter` | 发送 steering 消息，**在当前工具执行完后送达，打断剩余工具** |
| `Alt+Enter` | 排队一条追问，等 agent 完成后再处理 |

> 💡 **对本产品的价值**：这正是「任务执行中可继续对话」的底层原语，有官方支持而非纯自建。

### 上下文工程其他能力

- **AGENTS.md** — 启动时从 `~/.pi/agent/`、父目录、工作目录加载项目指令
- **SYSTEM.md** — 按项目替换或追加默认系统提示
- **Compaction** — 接近上下文上限时自动摘要旧消息，可定制（按主题、代码感知、或用其他模型做摘要）
- **Prompt templates** — Markdown 文件，输入 `/name` 展开
- **models.json** — 自定义 provider 与模型
- **Themes** — 支持热重载

### Provider 支持（15+）

Anthropic、OpenAI、Google、Azure、Bedrock、Mistral、Groq、Cerebras、xAI、Hugging Face、Kimi For Coding、MiniMax、NVIDIA、OpenRouter、**Ollama**，以及任何 OpenAI 兼容端点。可通过 `pi.registerProvider` 在运行时注册自定义 provider。

中途换模型：`/model` 或 `Ctrl+L`；收藏轮换 `Ctrl+P`。

## 安装与分发

```bash
curl -fsSL https://pi.dev/install.sh | sh
powershell -c "irm https://pi.dev/install.ps1 | iex"
npm  install -g --ignore-scripts @earendil-works/pi-coding-agent
pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent
bun  add -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi package 可从 npm 或 git 安装：`pi install npm:@foo/pi-tools`、`pi install git:github.com/...`，支持锁定版本与 HTTPS 源。

## 与 Claude Code 的关系

官网**未提及任何竞品名称**，只泛指"其他 agent"。独立资料的对比结论：

> **Claude Code** 是产品化环境（编辑器集成、IDE 插件、MCP、hooks、定时任务、企业特性）；**Pi 是可魔改的 harness** —— 多 provider、无厂商强制行为、开箱无企业特性。

## OpenClaw 的关系（修正早前理解）

OpenClaw 是**构建在 Pi SDK 之上的多平台通信 agent**，2026 年 1 月一周内达到 145,000 GitHub stars（`星数为单一来源，未核实`）。官网两次把 OpenClaw 列为 "a real-world integration / real-world example"。

> ⚠️ **关键修正**：内部文档《基于 OpenClaw(Pi) 构建云端多集群智能体》里那套**多租户、记忆外置、Skill 分发、统一网关、tenant_id 贯穿**的设计，**不是 Pi 自带的能力，而是他们在 Pi/OpenClaw 之外自己包的一层云服务化改造**。本产品要做的正是这一层。

## 对本产品需求的三处实质影响

### 1. SubAgent 并行需自建（原判断有误）
Pi 官方明确不提供 subagent。需通过 extension 实现，或起多实例。这意味着「支持 subagent 执行」是**本产品的工程量，不是底座赠品**。

### 2. 「任务执行中可继续对话」有官方原语依托
Pi 的 steering（Enter 插话 / Alt+Enter 排队）提供了会话内的中途介入能力。但**跨会话的异步长任务管理（task_id、持久化、checkpoint 接力、任务中心看板）仍需自建** —— Pi 只有会话级 steering，没有任务级编排。

### 3. 极简哲学与「面向不会写 prompt 的行业用户」存在张力，需自己补全整层
Pi 假设使用者是能自己写 extension 的开发者（"ask Pi itself to write the extension"）。本产品的目标用户完全相反。因此：

| 层 | 归属 |
|---|---|
| Agent loop / 工具原语 / provider 归一化 / session 树 / skill 渐进加载 / steering | **Pi 提供**（通过 SDK 或 RPC 嵌入） |
| 多租户与权限、异步任务编排、记忆与知识资产、场景工作台、Office 产出、计量计费、管理后台、多端前端、私有化交付 | **本产品自建** |

**结论：Pi 是可靠的内核选择（MIT、多 provider、可热换模型、会话树、热加载扩展），但它只覆盖最内层。产品价值与工程量的绝大部分在外层，这与「不与通用 Agent 拼功能、把差异化压在行业深度与交付形态上」的定位是一致的。**
