FROM node:26.7.0-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341

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
