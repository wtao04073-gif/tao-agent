# 单机部署镜像
#
# 两阶段构建：编译产物与运行时分开，运行镜像不含 devDependencies 与源码。
# 这不只是为了体积 —— 客户环境里少一份源码就少一处被误改的可能。

# ── 构建阶段 ──────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /build

# 先只拷依赖清单，让 npm ci 这一层能被缓存。
# 全量拷贝会让任何源码改动都触发重装依赖，构建从 1 分钟变 5 分钟。
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/office/package.json ./packages/office/
COPY packages/knowledge/package.json ./packages/knowledge/
COPY packages/agent-host/package.json ./packages/agent-host/
COPY packages/orchestrator/package.json ./packages/orchestrator/
COPY packages/server/package.json ./packages/server/
COPY vendor/pi/agent/package.json ./vendor/pi/agent/
COPY vendor/pi/ai/package.json ./vendor/pi/ai/
COPY vendor/pi/chord/package.json ./vendor/pi/chord/
COPY vendor/pi/telemetry/package.json ./vendor/pi/telemetry/

RUN npm ci --no-audit --no-fund

COPY . .

# 构建 vendor 与自有包
RUN npm run build:vendor && npm run build

# ── 运行阶段 ──────────────────────────────────────────
FROM node:22-slim AS runtime

# 以非 root 运行。
#
# node 镜像自带 uid 1000 的 node 用户。
# 绑定挂载宿主目录时，宿主目录属主要是 1000 —— 这条写进了
# docker-compose.yml 的注释与自检脚本的修复建议里。
WORKDIR /app

# 只拷运行时需要的东西
COPY --from=builder --chown=node:node /build/package.json ./
COPY --from=builder --chown=node:node /build/node_modules ./node_modules
COPY --from=builder --chown=node:node /build/packages ./packages
COPY --from=builder --chown=node:node /build/vendor ./vendor
COPY --from=builder --chown=node:node /build/scripts ./scripts

# 工作区目录。提前建好并给对属主 ——
# 否则首次启动时以非 root 身份建目录会失败
RUN mkdir -p /data/workspace && chown -R node:node /data

USER node

ENV NODE_ENV=production
ENV WORKSPACE_DIR=/data/workspace

EXPOSE 8080

# 启动前先自检。
#
# 配置错误在启动时就报出来，而不是等第一个任务失败 ——
# 后者让客户以为是产品不好用。自检失败则不启动（exit 1），
# Compose 的 restart: unless-stopped 会重试，日志里能看到明确原因。
CMD ["sh", "-c", "node scripts/doctor.mjs && node packages/server/dist/main.js"]
