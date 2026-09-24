# vendor/pi —— Pi 内核源码（已纳入本仓库管理）

## 这是什么

这里是 [Pi](https://pi.dev/) 的源码，**已作为本产品的一部分纳入 git 管理**。不是 npm 依赖，不从外网拉取。

**为什么这么做**（三个理由，按重要性排序）：

1. **完全自主可控** —— 本产品是要商业售卖的生产级系统。上游项目的任何状态变化（删库、下架、停止维护、公司解散）都不影响本产品。`git clone` 本仓库即可完整编译。
2. **可随时二开** —— 有些必要改动无法通过扩展点实现（见下方「为什么必须能改内核」），必须直接改源码。
3. **私有化交付不依赖外网** —— 客户机房常无外网，构建过程不能依赖 npm registry。

## 基线版本（锁定）

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/earendil-works/pi |
| 版本 tag | **v0.87.1** |
| commit | `f07218c4d4bbc12bef056a7058c3dd49dfe41abe` |
| 发布时间 | 2026-09-22 |
| 许可协议 | MIT（见 [LICENSE](./LICENSE)，声明见仓库根 [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md)） |

> ⚠️ **锁的是正式 tag，不是主干 HEAD。** 当初审计时用的是 `v0.87.1-17-g8676a0dc`（tag 之后第 17 个提交），那 17 个提交未经发布验证，生产系统不应采用中间状态。

## 目录构成与改动政策

| 目录 | 来源 | 用途 | 改动政策 |
|---|---|---|---|
| `agent/` | `packages/agent` | Agent Loop、状态管理、会话原语 | **可改** —— 子 Agent 并行、检查点续跑需要 |
| `ai/` | `packages/ai` | 多提供方模型接入（15+ 提供方） | **承诺不改** —— 这是最想白拿上游更新的部分（新模型支持），不改则升级为无痛覆盖 |
| `chord/` | `packages/chord` | `agent` 的内部依赖 | 不改 |
| `telemetry/` | `packages/telemetry` | `agent` 与 `ai` 的内部依赖 | 不改 |
| `coding-agent/src/core/tools/` | 同路径 | `bash`/`read`/`write`/`edit` 等工具实现 | **可改** —— 工具行为需按安全策略调整 |
| `coding-agent/src/core/extensions/` | 同路径 | 40 个生命周期钩子的实现 | **可改** —— 权限门依赖此处 |
| `tsconfig.base.json` | 仓库根 | 各包构建配置的共享基础 | 不改 |

**刻意未纳入**（约 6.7 万行，本产品用不到）：

- `packages/tui`（终端字符界面）—— 本产品前端是 Web，不需要在终端画界面
- `packages/coding-agent` 的其余部分（TUI 集成、斜杠命令、终端渲染器、交互模式）
- `packages/durable`、`evals`、`server`、`protocol`、`client`

> 若后续需要上述任一部分，按同样流程从锁定 tag 补充拷入，并在本文件登记。

## ⚠️ vendor 时必须一并纳入的三项（实际踩坑记录）

**这三项在首次 vendor 时全部遗漏，导致无法编译。** 记录在此以免重犯，也供将来升级时核对。

### 1. 内部依赖包 `chord` 与 `telemetry`

`agent` 依赖 `@earendil-works/chord`、`@earendil-works/pi-ai`、`@earendil-works/pi-telemetry`；`ai` 依赖 `@earendil-works/pi-telemetry`。只拷 `agent` 与 `ai` 会缺两个内部包（合计约 8600 行）。二者自身无内部依赖，补入即闭环。

### 2. 共享构建配置 `tsconfig.base.json`

各包的 `tsconfig.build.json` 均 `extends "../../tsconfig.base.json"`。缺失时编译器回退默认选项，会产生大量 TS5097（`allowImportingTsExtensions` 未开）等报错，且**仍会产出内容不正确的 dist**，极易误判为成功。已置于 `vendor/tsconfig.base.json`。

### 3. 模型清单数据 `ai/src/providers/data/`（最隐蔽）

**上游 `.gitignore` 排除了该目录** —— 它由 `npm run generate-models` 从 `models.dev` 等外部服务**联网拉取后生成**，正式构建流程是 `generate-models && build:offline`。

**后果**：仅 clone 上游仓库，在离线环境下 `ai` 包编译不出完整产物 —— 这与本产品「私有化交付不依赖外网」的要求直接冲突。

**解法**：从已发布的 npm 包 `@earendil-works/pi-ai@0.87.1` 的 `dist/providers/data/` 取出内容，纳入 vendor 源码树。该来源是离线可复现的固定快照，优于联网生成。

**共 42 个文件 = 41 个提供方清单 + 1 个隐藏的 `.manifest.json`**：

- `.manifest.json` 记录了每个文件的 sha256 与 `structureHash`，**是完整性校验的依据，不可遗漏**
- 它是**隐藏文件**，`ls`、`cp *` 等常规操作都会跳过它 —— 拷贝时务必确认
- 本仓库的 `.gitignore` 已显式取反使其入库；改动忽略规则后应复核：
  ```bash
  # 应输出 42
  git ls-files -o --exclude-standard vendor/pi/ai/src/providers/data/ | wc -l
  ```

> ⚠️ 上游用 `npm run check:model-data` 校验该目录，但那个脚本位于 `ai/scripts/` 下、**未纳入 vendor**。本仓库在 `scripts/build-vendor.mjs` 中实现了等价校验（按 manifest 逐文件比对 sha256），构建时自动执行，已用「篡改内容 / 删除文件 / 删除 manifest」三种情况反向验证确实能拦住。

> 💡 **升级时注意**：新版本的模型清单需重新从对应版本的发布包提取，不要沿用旧数据（会缺新模型），`.manifest.json` 也要一并更新。

## 构建

**依赖顺序**：`telemetry` / `chord`（无依赖）→ `ai` → `agent`

```bash
# 首次构建或升级后执行
node scripts/build-vendor.mjs

# 验证 vendor 自包含且可用
node scripts/verify-vendor.mjs
```

> ⚠️ `ai` 包编译后需额外把 `src/providers/data` 拷入 `dist/providers/data` —— 编译器不搬运 JSON 文件。构建脚本已处理。

## 为什么必须能改内核

这些是[接口审计](../../docs/pi-interface-audit.md)确认的、**无法通过扩展点绕过**的问题：

| 问题 | 走扩展点的代价 |
|---|---|
| `SessionManager` 私有构造 + 硬依赖 `node:fs`，存储层不可替换 | 只能 `inMemory()` 注水 + 事件镜像，绕一大圈 |
| session 文件零加锁、无 fsync、迁移时截断、首写抛 EEXIST | 只能在外层套分布式租约兜底 |
| `SessionManager.list()` 复杂度 O(所有文件所有字节) | 该能力彻底弃用，自建索引 |
| `bash` 工具无默认超时 | 可用 `tool_call` 钩子注入，但治标不治本 |

## 改动纪律（务必遵守）

升级时的痛苦程度**不取决于 vendor 本身，而取决于改了多少、改在哪里**。因此：

1. **能在外面包一层解决的，绝不改内核。** 优先顺序：扩展钩子 > 包装层 > 改源码。
2. **必须改时，统一标记。** 每处改动加注释 `// [TAO-PATCH] <原因>`，便于 `grep -rn "TAO-PATCH" vendor/` 一次列全。
3. **每处改动登记到 [PATCHES.md](./PATCHES.md)。** 不登记的改动视为技术债。
4. **保留测试目录。** 改了内核后靠它验证没改坏——这是 vendor 相比纯依赖多出来的安全网。
5. **不在 `ai/` 下做任何改动。** 若确实必需，先评估能否在调用侧解决。

## 季度升级流程

**节奏：每季度评估一次，不跟随上游主干。**

> 实测上游迭代速度：近 30 天 443 个提交，13 个月发 293 个版本（约每 1.4 天一个）。跟随主干需要长期专职人力，不符合本产品的投入结构。**变更时机由我们决定**，这是 to B 生产系统的核心能力。

```bash
# 1. 拉取上游最新状态（只看，不合并）
git -C /path/to/pi-upstream fetch --tags

# 2. 查看自当前基线以来的变更规模
git -C /path/to/pi-upstream log --oneline v0.87.1..<新tag> -- packages/agent packages/ai
git -C /path/to/pi-upstream diff --stat v0.87.1..<新tag> -- packages/agent packages/ai

# 3. 检查我们的补丁点是否被上游改动波及
grep -rn "TAO-PATCH" vendor/    # 列出全部自有改动
# 对每个补丁点，检查上游对应文件的 diff

# 4. 评估决策：整体升级 / 只捞特定改进 / 本季跳过
```

**升级检查清单**：

- [ ] 阅读上游 CHANGELOG 与 breaking change 说明
- [ ] 确认 `PATCHES.md` 中每处补丁在新版本上仍适用（或给出替代实现）
- [ ] `ai/` 无自有改动 → 可直接覆盖
- [ ] 跑通 vendor 自带测试
- [ ] 跑通自有回归用例集（覆盖两个行业核心场景）
- [ ] 更新本文件的基线版本信息
- [ ] 更新 `THIRD-PARTY-NOTICES.md` 中的版本号

> ⚠️ **注意上游是 0.x 版本。** 语义化版本规范允许 1.0 之前的版本在任意小版本破坏兼容性，因此**每次升级都必须视为可能有 breaking change**，不可因"只是小版本"而跳过回归测试。

## 与自有代码的边界

业务代码**不直接 import vendor**，而是经由自有适配层（`RunnerAdapter`）。这样：

- 上游怎么变，只影响适配层实现，不波及业务逻辑
- 将来若要更换内核或转为自研，改适配层即可

这是「自主可控」的完整含义 —— 不只是"代码在我仓库里"，而是**"我随时能换掉它而不动业务代码"**。
