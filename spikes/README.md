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

## 三项验证

| # | 验什么 | 为什么是门禁 | 状态 |
|---|---|---|---|
| 1 | 并发隔离 | 一个进程跑多会话若串台，就是跨租户泄漏 —— 商业上最不可接受的缺陷 | ✅ 10/10 通过 |
| 2 | 检查点续跑 | 长任务执行到一半崩溃后能否接力，且不重复消耗模型调用（直接关系成本） | 🚧 进行中 |
| 3 | 权限门与工具注册 | 默认拒绝能否真正拦住执行；能否用结构化工具替代自由 shell（安全策略决策 4 的前提） | 🚧 进行中 |

### Spike 1 · 并发隔离 ✅

**结论：隔离在底层与 Harness 层均成立，无跨租户泄漏。**

两个文件分别覆盖两层，因为产品实际走 Harness 层，结论必须在实际要用的那一层成立：

- `isolation.spike.ts` —— 底层 `Agent` 类，6 项
- `harness-isolation.spike.ts` —— `Harness + Session`（产品真实形态），4 项

验证手段上刻意做了两件事：让 A 慢 B 快以产生真实的时间交错（共享状态最容易在交错时暴露）；并检查**模型侧收到的 transcript**，而不只是本地历史 —— 上下文若混入对方内容，等于泄漏已经发生在出网请求里。

**两条由此确立的 M1 设计约束**：

1. **多用户必须一人一 Session。** 同一 Session 下的多个 lane 在 Session 的 mutation line 上串行执行，「一租户一 Session、每用户一 lane」会让用户互相排队。
2. **适配层必须显式传 `streamFn`。** `vendor/pi/agent/src/stream-fn.ts:3` 的 `defaultStreamFn` 是全包唯一的进程级可变状态，省略 `streamFn` 就会落到它上面，多会话共用同一模型入口。它在**构造期**解析，缺省时是启动即崩而非运行中崩。

附带确认：`AgentEvent` 上没有任何会话标识字段（无 `sessionId`/`agentId`），跨会话区分只能靠订阅闭包归属；Harness 层事件带 `lane` 字段。事件投递经 `structuredClone`，listener 拿到深拷贝，无法通过事件对象引用泄漏状态。
