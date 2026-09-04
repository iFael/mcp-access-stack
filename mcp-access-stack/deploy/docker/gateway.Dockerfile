FROM node:26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS build

WORKDIR /app
ENV npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY services ./services
COPY packages ./packages

RUN npm ci --ignore-scripts
RUN npm run build -w @vs-code-gpt/shared \
    && npm run build -w @mcp-access-stack/edge-protocol \
    && npm run build -w @vs-code-gpt/local-agent \
    && npm run build -w @vs-code-gpt/remote-mcp-gateway \
    && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3310

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/edge-protocol/package.json ./packages/edge-protocol/package.json
COPY --from=build --chown=node:node /app/packages/edge-protocol/dist ./packages/edge-protocol/dist
COPY --from=build --chown=node:node /app/packages/mcp-core/package.json ./packages/mcp-core/package.json
COPY --from=build --chown=node:node /app/packages/mcp-core/dist ./packages/mcp-core/dist
COPY --from=build --chown=node:node /app/services/workspace-agent/package.json ./services/workspace-agent/package.json
COPY --from=build --chown=node:node /app/services/workspace-agent/dist ./services/workspace-agent/dist
COPY --from=build --chown=node:node /app/services/mcp-gateway/package.json ./services/mcp-gateway/package.json
COPY --from=build --chown=node:node /app/services/mcp-gateway/dist ./services/mcp-gateway/dist

USER node
EXPOSE 3310

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3310)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "services/mcp-gateway/dist/server.js"]
