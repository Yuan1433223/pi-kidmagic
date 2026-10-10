# Kidmagic 部署镜像
# 构建上下文必须是 pi-kidmagic 仓库根目录：
#   cd F:\kidmagic\pi-kidmagic
#   docker build -f packages/kidmagic/deploy/Dockerfile -t kidmagic .
#
# 说明：kidmagic 依赖 pi 的本地 workspace 包（agent-core / ai / session-backends/sqlite-node 等），
# 因此必须在 monorepo 根做 npm ci + 全量 build，再跑 kidmagic 的 server。
# 首次构建较慢；若某一无关包构建失败，可在 build:offline 后追加 --ignore-scripts 或跳过该包。
# 此镜像基于本地源码直跑（node --experimental-strip-types），无需 TS 编译产物。

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="kidmagic" \
      org.opencontainers.image.description="Kidmagic 儿童创造力故事机（Pi 二开）"

WORKDIR /app
ENV NODE_ENV=production

# 1) 拷贝清单并安装依赖（善用层缓存）
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts

# 2) 构建 pi 本地 workspace 包（agent-core/ai/session-backends 等，runtime import 走各包 dist）
RUN npm run build:offline

EXPOSE 8787

# 运行时配置经 .env 注入（勿把生产 key 写进镜像）
CMD ["node", "--env-file-if-exists=/app/packages/kidmagic/.env", "--experimental-strip-types", "/app/packages/kidmagic/src/server.ts"]
