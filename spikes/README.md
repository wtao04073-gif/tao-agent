# M0 技术验证 Spike

技术方案定的硬门禁：**三项全部通过才进 M1**。

这些不是单元测试，而是**用可执行代码回答「这条路走不走得通」**。每个 spike 回答一个会改变架构决策的问题，结论直接写回 [tech-design.md](../docs/tech-design.md) 与 [PATCHES.md](../vendor/pi/PATCHES.md)。

## 运行

```bash
npm run spike              # 全部
npx vitest --run --config vitest.spikes.config.ts spikes/01-concurrency-isolation
```

Spike 全程离线 —— 用 `fauxProvider()` 或内联 mock `streamFn` 替代真实模型，不发任何网络请求。

## 编写约定

1. **每个 spike 必须包含反向验证用例**。断言若在任何情况下都通过，它就只是装饰。反向用例故意构造出「应该失败」的情形，证明检测逻辑真的有效。
   > 这条规则在 Spike 1b 上立刻见效：反向用例失败暴露了 `findEntries` 的用法错误（它是异步且接收查询对象，不是谓词函数）。没有它，三个「不含对方内容」的断言会因为读到空数据而全部假通过。
2. **注释写「为什么验」而非「怎么验」**。怎么验代码自己说得清；为什么验、结论影响哪个决策，只能写下来。
3. **结论落到文档**。spike 的价值在于把猜测换成事实，跑完即更新 tech-design 与 PATCHES。

## 三项验证 —— 全部通过（22/22），M1 门禁已开

| # | 验什么 | 为什么是门禁 | 结果 |
|---|---|---|---|
| 1 | 并发隔离 | 一个进程跑多会话若串台，就是跨租户泄漏 —— 商业上最不可接受的缺陷 | ✅ 10/10 |
| 2 | 检查点续跑 | 长任务崩溃后能否接力，且不重复消耗模型调用（直接关系成本目标） | ✅ 5/5 |
| 3 | 权限门与工具注册 | 默认拒绝能否真正拦住执行；能否用结构化工具替代自由 shell | ✅ 7/7 |

**三项的共同结论：审计阶段判断「需要改内核」的三处，实测全部不需要改。** 详见 [PATCHES.md](../vendor/pi/PATCHES.md) 的最终判定。这直接降低了长期升级成本 —— 没有补丁就没有冲突。

### Spike 1 · 并发隔离 ✅ 10/10

**结论：隔离在底层与 Harness 层均成立，无跨租户泄漏。**

两个文件分别覆盖两层，因为产品实际走 Harness 层，结论必须在实际要用的那一层成立：

- `isolation.spike.ts` —— 底层 `Agent` 类，6 项
- `harness-isolation.spike.ts` —— `Harness + Session`（产品真实形态），4 项

验证手段上刻意做了两件事：让 A 慢 B 快以产生真实的时间交错（共享状态最容易在交错时暴露）；并检查**模型侧收到的 transcript**，而不只是本地历史 —— 上下文若混入对方内容，等于泄漏已经发生在出网请求里。

**两条由此确立的 M1 设计约束**：

1. **多用户必须一人一 Session。** 同一 Session 下的多个 lane 在 Session 的 mutation line 上串行执行，「一租户一 Session、每用户一 lane」会让用户互相排队。
2. **适配层必须显式传 `streamFn`。** `vendor/pi/agent/src/stream-fn.ts:3` 的 `defaultStreamFn` 是全包唯一的进程级可变状态，省略 `streamFn` 就会落到它上面，多会话共用同一模型入口。它在**构造期**解析，缺省时是启动即崩而非运行中崩。

附带确认：`AgentEvent` 上没有任何会话标识字段（无 `sessionId`/`agentId`），跨会话区分只能靠订阅闭包归属；Harness 层事件带 `lane` 字段。事件投递经 `structuredClone`，listener 拿到深拷贝，无法通过事件对象引用泄漏状态。

### Spike 2 · 检查点续跑 ✅ 5/5

**结论：续跑成立，且已完成任务重启后零模型调用。**

两个关键设计决定，都来自实读源码后对最初假设的修正：

1. **不能用底层 agent-loop 验证。** 那一层无持久化，且 `runAgentLoop` 被调一次就必然发起至少一次模型请求（`hasMoreToolCalls` 初值为 `true`，`streamAssistantResponse` 在任何 tool-call 检查之前）。`Agent.continue()` 在历史尾部是 assistant 时**抛错**而非幂等跳过 —— 抛错 ≠ 续跑。「不重复消耗」只在 harness 层成立。
2. **必须用真实文件后端。** 上游 harness 层的 resume 测试**全部跑在 `MemoryStorage` 上**，没有一个跑在 `JsonlSessionRepo` 上 —— 「真进程重启」这条端到端路径是上游测试的空白，而它恰恰是我们的验收标准。本 spike 填的就是这个空白。

模拟进程重启的方式：丢弃全部内存对象（repo / harness / lane / faux），用同一磁盘目录重新构造，并换一个**全新的假模型**（调用计数从 0 开始）。恢复过程若试图调模型，计数立刻暴露。

**幂等性的根源（实读落盘文件确认）**：任务完成时会 `delete` 掉 `pi.op.meta` 与 `pi.op.state`，因此恢复时 `restoreLaneState` 得到 `operation: null`，`resume()` 直接返回 `NothingToResume`。落盘内容还确认了 `pi.pending.assistant_frame` 机制 —— 崩溃在等模型响应时，恢复靠已落盘的流式增量帧重建部分响应，**不重新调模型**。

采用了上游自己的黄金不变量：`expect(lane.state).toEqual(await restoreLane(session, "main", ctx))`，含义是「任意时刻拔电，恢复后状态一致」。它比逐字段断言更强 —— 覆盖全部字段，而非我们想到的那几个。

### Spike 3 · 权限门与工具注册 ✅ 7/7

**结论：默认拒绝 + 白名单可真正拦住执行；结构化工具可完全替代自由 shell。**

钩子机制就在 agent 包内（`src/harness/hooks.ts`，11 个钩子），不在 chord，也不依赖未完整 vendor 的 coding-agent。权限门用 `before_tool`：返回 `{ block: { reason } }` 即拦截。

四条经验证的关键性质：

| 性质 | 意义 |
|---|---|
| 被拒调用的 `execute` **零次**被调用 | 不是「返回错误」，是真的没执行 |
| handler 抛异常 → **fail-closed**（拒绝） | 权限逻辑有 bug 时行为是拒绝，不是放行 |
| 被拒调用**不写执行意图** | 崩溃恢复不会重放曾被拒绝的高危调用 |
| 内置工具是工厂函数，**源码无任何自动注册** | 不调 `createBashTool()` 就没有 bash |

生产建议两层叠加：`activeToolNames` 让工具在**模型侧不可见**，`before_tool` 在**执行侧兜底**（防历史 transcript 里的旧工具名被重放）。另订阅 `handler_error` 事件监控权限代码自身的异常。

> 注意一处与 legacy 接口的差异：harness 的 `before_tool` 返回 `{ args }` 会**重新做 schema 校验**（legacy `beforeToolCall` 不校验）。若想在钩子里注入默认值，注入后必须仍满足 schema。

**A1 用例做过变异测试**：注释掉权限门钩子后，`tool.calls` 变为 1、用例失败 —— 证明该断言真的在测权限门，而非恰好通过。
