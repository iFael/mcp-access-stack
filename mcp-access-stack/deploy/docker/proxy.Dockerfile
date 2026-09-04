FROM node:26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e

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
