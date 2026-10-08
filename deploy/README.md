# 单机部署指南

面向客户 IT 人员。目标是**2 小时内独立装成**，不需要开发背景。

若中途卡住，先跑自检（第 4 步），它会指出具体是哪一项不满足以及怎么修。

---

## 0 · 先确认机器够用

| 项目 | 最低 | 建议 |
|---|---|---|
| CPU | 2 核 | 4 核 |
| 内存 | 4 GB | 8 GB |
| 可用磁盘 | 5 GB | 20 GB |
| 操作系统 | 装得上 Docker 的 Linux | Ubuntu 22.04 / CentOS 7+ |

还需要：
- Docker 20.10 以上、Docker Compose v2
- **一个可用的模型服务**（见第 2 步，二选一）

内存 4-8 GB 之间可以跑，但要把并发调低 —— 自检会提示具体配置项。

---

## 1 · 取得部署包

```bash
# 若已拿到离线包，跳过这步
git clone <仓库地址> tao-agent
cd tao-agent/deploy
```

离线环境请向供应方索取包含 `node_modules` 的完整包，避免容器构建时联网拉依赖。

---

## 2 · 选择模型服务

**这一步决定数据是否出网。**

### 方案 A · 公有云模型 API（配置最简单）

数据会发给模型服务商。适合对数据外发无特别要求的场景。

```bash
cp .env.example .env
vi .env
```

按服务商填 `MODEL_BASE_URL` 与 `MODEL_NAME`：

| 服务商 | MODEL_BASE_URL | MODEL_NAME 示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode` | `qwen-plus` |
| Kimi | `https://api.moonshot.cn` | `moonshot-v1-32k` |
| 豆包 | `https://ark.cn-beijing.volces.com/api/v3` | 按控制台的接入点填 |

`MODEL_API_KEY` 填服务商控制台生成的密钥。

### 方案 B · 内网自建推理服务（数据不出网）

适合高校数据分级要求、制造业图纸工艺不出厂的场景。**容器不需要出网权限。**

先在内网部署 vLLM 或 Ollama，然后：

```bash
MODEL_BASE_URL=http://192.168.1.100:8000/v1
MODEL_API_KEY=local          # 多数自建服务不校验，填任意非空值
MODEL_NAME=qwen2.5-14b-instruct
```

---

## 3 · 启动

```bash
docker compose up -d
```

首次启动要构建镜像，约 3-8 分钟（取决于机器与网络）。

看日志确认起来了：

```bash
docker compose logs -f
```

正常的启动日志长这样：

```
服务配置
────────────────────────────────────────────────
  端口          8080
  工作区        /data/workspace
  模型服务      https://api.deepseek.com
  模型          deepseek-chat
  API Key       已配置
  任务并发上限   3
  ...
服务已启动，监听 8080 端口。
```

**若配置有问题，服务会拒绝启动并列出全部问题**（不是只报第一个）：

```
配置有 2 处问题：
────────────────────────────────────────────────
  ✗ MODEL_API_KEY：未配置
      → 在 .env 里填 API Key。内网自建推理服务多数不校验，填任意非空值即可（如 local）
  ✗ PORT：不是整数：80 80
      → 填 1-65535 之间的端口号。1024 以下的端口需要 root 权限
────────────────────────────────────────────────
  修改 .env 后重新启动。
```

按提示改 `.env`，然后 `docker compose up -d` 重来。

---

## 4 · 自检

```bash
docker compose exec tao-agent node scripts/doctor.mjs
```

它会逐项检查并**给出可执行的修复建议**：

```
部署自检
────────────────────────────────────────────────
  ✓ Node 版本：v22.19.0
  ! 内存：6.0 GB，低于建议值 8.0 GB
      → 可以运行，但并发任务较多时可能 OOM。建议把并发上限调低
        （配置项 MAX_CONCURRENT_TASKS=2），或扩容内存
  ✓ 可用磁盘：45.2 GB
  ✗ 端口 8080：已被占用
      → 换一个端口（配置项 PORT=8081），或先停掉占用方：
        lsof -i :8080 查进程，然后 kill
  ✓ 工作区可写：/data/workspace
  ✓ 模型 API 连通性：可达（api.deepseek.com）
────────────────────────────────────────────────
  自检未通过：1 项必须修复。
```

标记含义：

| 标记 | 含义 | 要做什么 |
|---|---|---|
| ✓ | 通过 | 无 |
| ! | 能跑但有风险 | 按建议优化，不阻塞使用 |
| ✗ | 装不成 | 必须修 |

---

## 5 · 验证能用

```bash
# 存活检查
curl http://localhost:8080/healthz
# 期望：{"status":"ok"}

# 提交一个任务（token 在工作区 accounts.json 里配置，见下方「账号与权限」）
curl -X POST http://localhost:8080/api/tasks \
  -H "Authorization: Bearer 你的token" \
  -H "Content-Type: application/json" \
  -d '{
    "scenarioId": "univ.official-notice",
    "fields": {
      "noticeType": "通知",
      "subject": "关于开展教学检查的通知",
      "audience": ["全校各单位"],
      "keyPoints": ["检查时间为下周", "各单位须提交自查报告"]
    }
  }'
# 期望：{"taskId":"task-..."}

# 查任务状态
curl http://localhost:8080/api/tasks/<taskId> -H "Authorization: Bearer 你的token"

# 看实时进度（Ctrl+C 退出）
curl -N http://localhost:8080/api/events?taskId=<taskId> \
  -H "Authorization: Bearer 你的token"
```

任务状态到 `SUCCEEDED` 说明链路通了。产出文件在工作区里：

```bash
docker compose exec tao-agent ls /data/workspace/default/default/
```

---

## 6 · 管理接口（用量与审计）

需要**管理员账号的 token** —— 是否管理员由账号文件里该账号的 `role` 决定，
不再有 `admin:` 前缀约定。把下面示例里的 `$ADMIN_TOKEN` 换成 accounts.json 中
`role` 为 `TENANT_ADMIN` 的账号 token。

```bash
# 用量看板（默认当月）
curl http://localhost:8080/api/admin/usage \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 指定周期
curl "http://localhost:8080/api/admin/usage?from=2026-08-01&to=2026-09-01" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 审计日志（工具调用的放行/拒绝记录）
curl http://localhost:8080/api/admin/audit \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 全部任务
curl http://localhost:8080/api/admin/tasks \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 账号与权限

账号在工作区根目录的 **`accounts.json`**。服务首次启动时会自动生成一份种子，
含一个管理员和一个普通成员，token 都是 `change-me-...` 占位值 —— **上线前必须改**，
启动日志也会持续警告。

```json
{
  "accounts": [
    {
      "name": "教务管理员",
      "token": "换成足够长的随机字符串",
      "tenantId": "default",
      "workspaceId": "default",
      "userId": "admin",
      "role": "TENANT_ADMIN"
    }
  ]
}
```

- `role` 取 `TENANT_ADMIN`（可看用量/审计）、`WORKSPACE_ADMIN` 或 `MEMBER`；
- token 至少 16 个字符、全局唯一，客户端用 `Authorization: Bearer <token>` 传；
- 改完重启服务生效。文件格式不对或缺字段时服务会拒绝启动并列出具体问题；
- 私有化默认单租户（`tenantId: "default"`），但用户、工作区、角色模型完整保留。

用量看板返回的内容：

| 字段 | 含义 |
|---|---|
| `totals` | 总 token、任务数 |
| `costMicroYuan` | 费用（微元，1 元 = 1000000）|
| `unpricedModels` | **未配单价的模型。有值说明费用不完整** |
| `byUser` | 按工作区下钻（不是按用户，见下方限制）|
| `byModel` | 按模型下钻 |
| `byDay` | 按天趋势，可发现用量突增 |
| `quota` | 配额已用/上限与进度比例 |

用量数据落在 `<工作区>/.metering/usage-YYYY-MM.jsonl`，**重启不丢**。按月分片，归档直接删旧文件即可。

---

## 常见问题

### 服务起不来，日志里是配置问题

按日志里的 `→` 提示改 `.env`。全部问题会一次列出，不需要反复试。

### 所有任务都失败

跑自检（第 4 步）。最常见是模型 API 不通：

- 公有云：确认服务器能出网（`curl https://api.deepseek.com`）；若需代理，在 `.env` 里加 `HTTPS_PROXY=http://你的代理:端口`
- 内网自建：确认从容器内能访问推理服务
  ```bash
  docker compose exec tao-agent curl -s http://192.168.1.100:8000/v1/models
  ```

### 任务报「鉴权失败」

`MODEL_API_KEY` 不对、已过期，或该 Key 没有所填模型的调用权限。到服务商控制台核对。

### 任务跑完但找不到产出文件

检查挂载卷权限。默认用具名卷不会有这个问题；若改成了绑定挂载宿主目录，宿主目录的属主要是 uid 1000：

```bash
chown -R 1000:1000 /你的宿主目录
```

### 任务莫名被杀、日志里没有错误

内存不足被 OOM kill。降低并发：

```bash
# .env
MAX_CONCURRENT_TASKS=1
MAX_SUBTASK_CONCURRENCY=1
```

然后 `docker compose up -d` 重启。

### 磁盘满了

产物与日志会持续累积。日志已配轮转（最多 5 × 50MB）。清理产物：

```bash
docker compose exec tao-agent du -sh /data/workspace/*
```

### 前端看到「进度卡住」

服务在反代（nginx）后面时，反代可能缓冲了 SSE。nginx 配置需要：

```nginx
location /api/events {
    proxy_pass http://localhost:8080;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
}
```

---

## 当前版本的限制

写在这里而不是藏起来，因为它们会影响使用方式：

| 限制 | 影响 | 计划 |
|---|---|---|
| **鉴权是单租户退化形态**：任何非空 token 都映射到同一个默认租户 | 不能用于多部门隔离或对外提供服务 | M5-2 接入真实账号体系 |
| **重启后进行中的任务需手动续跑** | 任务记录、事件、审计已落盘重启不丢；但重启时正在执行的任务会标记为**中断**，需从检查点重试（会话上下文不续跑） | M5 后续接会话存储续跑 |
| **配额熔断挂在工具执行前** | 拦不住「只生成文本、不调工具」的消耗 | M5-5 |
| **按用户下钻实际是按工作区** | 无法按人追责 | M5-2 把 userId 带进用量记录 |
| **管理员靠 token 前缀判定** | 不是真实账号体系 | M5-2 |
| **无前端界面** | 目前只有 HTTP API | M5-3 / M5-4 |
| **看板每次查询全量读分片** | 数据量大时变慢（十万条内无感）| SaaS 形态换聚合表 |

---

## 运维

```bash
# 查看日志
docker compose logs -f --tail 100

# 重启
docker compose restart

# 停止
docker compose down

# 停止并清空数据（谨慎 —— 会删掉全部产出与知识库）
docker compose down -v

# 升级
git pull && docker compose up -d --build
```

## 网页管理后台（首版）

推荐新部署使用图形化配置。部署方设置随机的 `TAO_BOOTSTRAP_TOKEN`（至少 16 字符），模型地址和 Key 可以留空。启动后打开 `/admin-login.html`，用一次性认领凭据建立管理员账号；密码至少 12 字符。认领后移除初始化凭据并重启。无需把模型 Key 写入前端或提交到 Git。

管理员在聊天页点击左下头像 → 管理后台。普通成员菜单不提供管理入口，服务端也拒绝管理 API。后台支持：

- 模型：旗舰、轻量、独立评测模型，兼容 OpenAI Chat Completions 的服务地址、Key、输出限制和价格。服务商选项只作兼容协议标识，模型 ID 需按服务商实际支持填写。
- 配额：模型出口 RPM、TPM、请求并发和超时，任务及子任务并发，月度 Token、费用、任务数。TPM 按输入 UTF-8 字节数加最大输出保守预留，成功按 usage 结算，失败保留预留。
- 知识库：Embedding、维度、版本、切片、重叠、检索方式和召回数；后台查看索引并提交重建，查看完成或失败状态。模型或切片参数变化后禁止混用旧向量。历史文件没有原始分段数据时，建议重新入库以完整按新切片规则生成。
- 扩展：Tavily、Brave 搜索；单个 Streamable HTTP MCP 服务、认证头和工具白名单；子智能体开关。MCP 调用继续受工具确认约束，连接测试只查询工具目录。
- 账号：创建、展示名/工作区/角色修改、启停、密码重置和会话撤销。停用、修改权限、重置或撤销会话会取消该账号在途任务，使旧 Token 和未使用票据失效，并使事件流重新鉴权。
- 观测：任务状态、工具步骤、模型请求耗时/首字延迟/Token、用量与费用、采样和保留期，可选 OTLP HTTP JSON 导出。首版只采集脱敏元数据，不提供完整提示词正文采集；OTLP 为模型请求跨度，尚不等同于跨服务完整链路追踪。
- 评测：图形化维护输入及预期关键词，独立工作区真实执行，规则评分与人工复核，最多 5 并发，可取消。每次模型请求前共享预留 Token/费用预算；费用按配置的最高单价保守估算。未配置价格显示未知；模型评审未接通。
- 品牌：名称、简称、PNG/JPEG/WebP Logo、欢迎语、说明文字；同步登录、聊天、管理页和浏览器标题。Logo 限 512KB、2048×2048。SVG/ICO 不在首版上传范围内。

### 发布、生效与紧急暂停

填写表单 → 保存草稿 → 主动测试连接 → 应用配置。测试会发送少量固定测试文本，可能消耗供应商额度，不会发送客户文档。保存草稿不改变运行配置；并发保存发生版本冲突时应刷新，不能覆盖别人的版本。历史页可回退非密钥配置；当前密钥不会被历史版本覆盖。脱敏导出包含配置与密钥是否已配置，不包含明文 Key，也不能代替备份。

当前发布采用单进程安全切换：有任务运行/排队、知识入库或评测运行时拒绝应用，需等待完成。因此不会在同一在途任务中切换模型。需要立即止损时，使用“暂停模型调用”：后续模型请求被阻止，在途任务取消，暂停状态跨重启保留；核对并重新应用配置后恢复。

### 网络与基础设施

默认只允许公网 HTTPS 和本机地址。自建服务需要私网时，由部署管理员在“允许访问的私有网段”显式填写 IP/CIDR（逗号分隔），并使用 HTTPS；本机 HTTP 可用于本机推理服务。元数据、link-local、组播等地址即使加入网段仍拒绝。实际连接固定经过校验的 DNS 结果，拒绝重定向；响应有大小上限。生产反向代理应提供 HTTPS，并正确覆盖 `X-Forwarded-Proto`，不要信任客户端直传的代理头。

端口、工作区目录、TLS、操作系统账号、磁盘备份与防火墙仍由部署方管理，不属于在线表单。后台面向单机单进程部署：平台管理员管理部署全局配置；仅一个租户时租户管理员可管理全局配置。多租户时租户管理员只管理本租户账号，不提供租户模型/连接器/品牌覆盖。多副本分布式限流与高可用、企业 SSO、任意连接器、代码执行沙箱不在首版范围。

`/healthz` 是存活探测，不访问外部模型，Compose 使用此探测避免首次待配置时重启循环。`/readyz` 表示模型已配置且未被暂停，不承诺供应商实时可达。`npm run doctor` 读取已发布后台配置；真实模型调用能力以后台“测试模型”及实际任务为准。

### 密钥、迁移与恢复

配置位于工作区 `.admin-config/`，Key 使用 AES-256-GCM 加密。推荐部署时独立提供 `TAO_MASTER_KEY`（Base64 编码的 32 字节随机值）；未提供时生成权限受限的 `.admin-config/master.key`，这种模式不防止取得整块磁盘的人同时获取密钥。主密钥丢失或不匹配时拒绝解密，不静默生成替代密钥。

账号密码使用 scrypt，Token/会话仅保存哈希，账号文件为工作区 `admin-identity.json`。升级时首次从旧 `accounts.json` 导入，后续以新账号文件为准；为可回退，旧源文件不会自动删除，里面仍可能含旧明文 Token。部署方应在确认迁移成功后将该源文件移出在线目录，安全归档或删除，限制旧备份访问；回退旧版本会恢复旧账号语义，必须重新核对禁用账号与令牌。

停止服务后备份整个工作区（包含 `.admin-config`、`admin-identity.json`、`.admin`、知识索引、任务/计量/审计文件）。外部主密钥单独保管并保留其对应版本；还原时先放回相同主密钥和完整数据，再启动相同版本进行检查。配置写入失败保留旧版本，主配置损坏尝试恢复上一份有效文件。评测在重启后标为中断，不自动重放；停机前应等待业务结束。不要用脱敏导出恢复凭据。

### 管理功能补充

评测集条目现支持标签、关键词、JSON 顶层字段和工具成功执行规则；未填写额外规则时仍检查任务成功状态。评分依据逐项显示，工具规则只认可真实完成事件，权限允许或模型声称调用不计成功。同一评测集的两次运行可按稳定用例编号比较改善、退化或未验证状态。单条执行异常记录失败并继续后续用例，异常原文不会进入结果。

头像菜单的“个人设置”可修改本人显示名和密码。密码变更必须验证原密码，并撤销全部旧会话及令牌；存量纯令牌账号需先由管理员设置初始密码。旗舰、轻量与独立评测模型均可分别测试连接，结果绑定配置指纹。

本轮仍未接入企业SSO、分布式限流、通用代码沙箱、模型裁判和租户独立模型运行时；这些项目不作为当前试用可用能力。

### 反向代理来源校验

代理改变 Host 或终止 TLS 时，部署方须设置 `TAO_PUBLIC_ORIGINS=https://agent.example.com`（多来源逗号分隔）并重启。仅填写本部署实际公开地址，不能填写通配符。后台、密码登录、Cookie 写请求与图标上传共享此策略，仍保留身份和 CSRF 校验；不会根据请求中的 X-Forwarded-Host 自动放行来源。
