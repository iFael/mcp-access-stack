FROM node:26.6.0-bookworm-slim@sha256:81502e860176e63695d769d3d1a2d3a403abc1c27c6a02169b765f3e43b60ede

WORKDIR /app
ENV NODE_ENV=production \
    PROXY_HOST=0.0.0.0 \
    PROXY_PORT=3300 \
    TARGET_HOST=gateway \
    TARGET_PORT=3310 \
    MCP_PATH=/mcp

COPY --chown=node:node operations/runtime/gpt-mcp-proxy.mjs ./gpt-mcp-proxy.mjs

USER node
EXPOSE 3300

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PROXY_PORT||3300)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "gpt-mcp-proxy.mjs"]
