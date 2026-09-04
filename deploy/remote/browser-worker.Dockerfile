FROM node:26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e

WORKDIR /app
ENV npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY services ./services
COPY packages ./packages

RUN npm ci --ignore-scripts \
    && npm run build -w @vs-code-gpt/shared \
    && npm run build -w @vs-code-gpt/browser-worker \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && npm prune --omit=dev --workspaces --include-workspace-root

RUN mkdir -p /var/lib/mcp-access-stack/browser /var/lib/mcp-access-stack/browser-private \
    && chown -R node:node /var/lib/mcp-access-stack

ENV NODE_ENV=production \
    BROWSER_WORKER_HOST=0.0.0.0 \
    BROWSER_WORKER_PORT=3350 \
    BROWSER_WORKER_HEADLESS=true \
    BROWSER_WORKER_RUNTIME_DIR=/var/lib/mcp-access-stack/browser \
    BROWSER_WORKER_PRIVATE_DIR=/var/lib/mcp-access-stack/browser-private

USER node
EXPOSE 3350

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BROWSER_WORKER_PORT||3350)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "services/browser-worker/dist/server.js"]
