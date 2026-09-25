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

# 提交一个任务（TOKEN 可以是任意非空字符串，见下方说明）
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
| **鉴权是单租户退化形态**：任何非空 token 都映射到同一个默认租户 | 不能用于多部门隔离或对外提供服务 | M5 接入真实账号体系 |
| **会话存在内存里**，进程重启后丢失 | 重启会让进行中的任务失去上下文 | M5 落盘 |
| **计量数据也在内存里** | 重启后用量归零，配额失效 | M5 落盘 |
| **配额熔断挂在工具执行前** | 拦不住「只生成文本、不调工具」的消耗 | M5 |
| **无管理后台** | 用量与任务只能通过 API 查 | M4-3 |
| **无前端界面** | 目前只有 HTTP API | M5 |

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
