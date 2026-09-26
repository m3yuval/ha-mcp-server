# https://developers.home-assistant.io/docs/apps/configuration#app-dockerfile
# Home Assistant base image (Alpine + s6-overlay v3 + bashio), pinned as the
# docs recommend. Alpine 3.23 ships Node.js 24 (>= 22 needed for global WebSocket).
ARG BASE_IMAGE=ghcr.io/home-assistant/base:3.23

# ---- build: compile TypeScript, keep only production deps
FROM ${BASE_IMAGE} AS build
RUN apk add --no-cache nodejs npm
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime
FROM ${BASE_IMAGE}
RUN apk add --no-cache nodejs
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# s6-overlay service + entrypoint script
COPY rootfs /
RUN chmod a+x /usr/bin/ha-mcp-run /etc/services.d/ha-mcp/run /etc/services.d/ha-mcp/finish

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/health" > /dev/null || exit 1

LABEL \
  org.opencontainers.image.title="Home Assistant MCP" \
  org.opencontainers.image.description="MCP server for Home Assistant (read-only by default)" \
  org.opencontainers.image.source="https://github.com/m3yuval/ha-mcp-server" \
  org.opencontainers.image.licenses="MIT"
