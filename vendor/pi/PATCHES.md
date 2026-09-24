# vendor/pi 自有改动登记表

> **规则：对 `vendor/pi/` 下任何文件的改动都必须登记在此。未登记的改动视为技术债。**
>
> 每处改动须在源码中加注释标记 `// [TAO-PATCH] <原因>`，以便 `grep -rn "TAO-PATCH" vendor/` 一次列全。
>
> 基线版本：**v0.87.1**（commit `f07218c4`）。升级时逐条复核本表每项在新版本上是否仍适用。

## 当前状态

**暂无改动，且 M0 验证后确认「预计要改的三处全部不需要改」。** vendor 与上游 v0.87.1 逐字节一致（唯一差异是补入上游 gitignore 掉的 `ai/src/providers/data/`）。

这个结果比预期好得多，直接影响升级成本 —— 没有补丁就没有冲突，季度升级基本是覆盖即可。

## 登记格式

新增改动时按下表追加，并在正文补充详细说明：

| # | 文件 | 改动摘要 | 原因 | 能否用扩展点替代 | 日期 |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

### 详细说明模板

```
## P001 · <改动标题>

- **文件**：vendor/pi/<路径>
- **上游对应**：packages/<路径>（v0.87.1）
- **改动类型**：新增 / 修改 / 删除
- **原因**：为什么必须改内核，而不能用扩展钩子或包装层解决
- **改动内容**：具体改了什么（贴关键 diff 片段）
- **影响面**：可能影响哪些行为
- **测试覆盖**：哪个测试验证这处改动
- **升级注意**：上游若改动此处附近，需要注意什么
```

---

## 候选改动点的最终判定（M0 已验证，全部无需改动）

审计阶段基于**不完整的信息**识别出三处「预计需要改内核」的位置。M0 spike 实读源码后，三处全部推翻。这一节保留判定过程，供将来重新评估时参照。

### ~~候选 1 · bash 工具缺少默认超时~~（已失效）

- **判定：无需改动。** 随[安全策略决策 4](../../docs/security-policy.md) 失效 —— `bash` 工具默认不激活，所有能力改为结构化工具。
- **M0 补充证据**：内置工具全部是**工厂函数**（`createBashTool` 等），全量 grep 确认源码里**没有任何地方自动调用它们**。不放进 `tools: [...]` 就不存在 bash。见 [Spike 3 · B1](../../spikes/03-permission-gate/permission.spike.ts)。
- **若二期开放 bash 则重新生效**：届时优先用 `before_tool` 钩子注入默认 `timeout`，仍不改源码。注意该钩子返回的 `args` 会**重新做 schema 校验**，注入后必须仍满足 schema。

### ~~候选 2 · SessionManager 存储层不可替换~~（判定：与我们无关，无需改动）

- **原判断**：「私有构造函数、硬依赖 `node:fs`、以具体类而非接口暴露」，预计需 vendor 该文件并重写存储层。
- **判定：审计描述的问题都真实存在，但那是另一套实现，我们用的不是它。**

上游有**两套并行的会话实现**，这是审计阶段未区分清楚的关键事实：

| 实现 | 位置 | 状况 | 我们的取舍 |
|---|---|---|---|
| `SessionManager` | `coding-agent/src/core/session-manager.ts`（2010 行） | 私有构造（`:1000`）、`static inMemory()`（`:1801`）、零加锁、`list()` 为 O(所有字节) —— 审计所述问题**均属实** | **未 vendor，不使用** |
| `SessionRepo` + `Storage` | `agent/src/harness/session/` | 为可替换而设计的两层接口 | **产品采用** |

我们采用的那套，三项关键证据：

1. **生产代码零 node builtin 依赖** —— 文件系统是注入的 `FileSystem` 能力（`harness/types.ts:275`），`grep -rn "node:" src/harness/session/` 只命中 `testing/conformance/` 下的 `node:assert`。
2. **`SessionRepo` 与 `Storage` 都是接口**（`session/types.ts:592` / `:455`），`JsonlSessionRepo`、`MemorySessionRepo` 均为**公开构造函数**；`StorageBackedSession` 只吃 `Storage` 接口（`session/session.ts:235`）。
3. **上游导出了整套 conformance 测试套件**（`./harness/session/testing` 子路径，`createStorageConformance` / `createSessionRepoConformance`），专供第三方后端自检合规 —— 上游自己也把 SQLite 后端拆成了独立包。这是「存储层可替换」最强的工程证据。

**结论**：换数据库后端只需实现自己的 `Storage`，用上游 conformance 套件验证合规，**完全不改内核**。原设计里「`inMemory()` 注水 + 事件镜像」的绕行复杂度可直接删掉。

### ~~候选 3 · session 文件无并发保护~~（不适用，无需改动）

- **原判断**：「零加锁、无 fsync、迁移时用截断模式打开、首写用 `wx` 标志会抛 EEXIST」。
- **判定：不需要改内核，但需在架构上避免多写者。**

M0 发现的相关事实：

- **坏尾自愈已内建**：`JsonlStorage` 打开时若最后一行缺 `\n`，丢弃该行并原子重写（`jsonl/storage.ts:94-112`）—— 这正是「进程被 kill」的场景，上游有专门的 `describe("JsonlStorage torn tail")` 测试覆盖三种残损形态。
- **会话创建是原子发布**：先写临时文件再 rename（上游测试 `atomically publishes a branchless session header`）。
- **写入是纯 append，一事务一行**（`jsonl/io.ts:184`），且执行进度（`pi.op.state`）与消息历史在**同一次提交**里落盘。

**结论**：单写者前提下持久化是安全的。我们的架构本就是「一会话一进程」，天然满足单写者；SaaS 多副本场景用外层租约保证同一会话只有一个 Runner 持有，**这是编排层的责任，不是内核缺陷**。若将来换成数据库后端（见候选 2），该问题自然消失。

---

## 升级时的复核流程

1. `grep -rn "TAO-PATCH" vendor/` 列出全部改动点
2. 对每个改动点，查上游对应文件的 diff：
   ```bash
   git -C /path/to/pi-upstream diff v0.87.1..<新tag> -- packages/<对应路径>
   ```
3. 三种情况分别处理：
   - **上游未改动此处** → 直接保留补丁
   - **上游改动了附近但不冲突** → 手动合并，重新验证
   - **上游重构了此处** → 重新评估：补丁是否仍必要？上游是否已原生解决？
4. 跑 `npm run test:vendor`（上游自带 2338 个测试）与 `npm run spike`（我们的 M0 断言），两者都绿才算升级完成
5. 更新本表的「日期」列与适用性说明
