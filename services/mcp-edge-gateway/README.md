# MCP Edge Gateway

Cloudflare Worker used as the public serverless edge for the MCP.

```text
ChatGPT -> Cloudflare Worker -> Durable Object <-> MCP Connector (Windows, outbound)
```

The public Edge relay is enabled in production (`MCP_EDGE_ENABLED=true`) and published from `main` through Cloudflare Workers Builds. Non-production branches run a Wrangler dry-run and do not change the live Worker deployment.

## Routes

- `GET /health`: Worker health plus connector readiness.
- `/connector`: authenticated WebSocket upgrade for the outbound Windows connector.
- `/mcp`: MCP relay when the Edge is explicitly enabled.
- Owner OAuth routes: only the exact paths listed in `docs/architecture/EDGE_MCP_RUNTIME.md`.

## Security

- `MCP_CONNECTOR_TOKEN` is a Cloudflare secret and is never versioned.
- Connector protocol/version, request paths and methods fail closed.
- Only allowlisted request/response headers cross the Edge boundary.
- Request/response sizes, relay time and connector concurrency are bounded.
- Edge cancellation is propagated to the connector and the embedded Gateway.
- `Origin` is forwarded so Gateway origin policy is preserved.

## Cloudflare Workers Builds

```text
Root directory:        /mcp-access-stack
Build command:         (empty)
Production (`main`):   npx wrangler deploy --config services/mcp-edge-gateway/wrangler.jsonc
Non-production:        npx wrangler deploy --dry-run --config services/mcp-edge-gateway/wrangler.jsonc
```

The production trigger includes only `main`. The non-production trigger includes all other branches and excludes `main`.

The `wrangler.jsonc` in this directory is the Worker source of truth. The Durable Object uses SQLite storage and WebSocket Hibernation.
