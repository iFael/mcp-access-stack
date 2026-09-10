FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae

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
