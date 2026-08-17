# MCP Edge Gateway

Cloudflare Worker used as the public serverless edge for the MCP.

```text
ChatGPT -> Cloudflare Worker -> Durable Object <-> MCP Connector (Windows, outbound)
```

The Worker is deployed **disabled by default** (`MCP_EDGE_ENABLED=false`). Public MCP/OAuth relay is enabled only in a later activation gate.

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
Root directory: /mcp-access-stack/services/mcp-edge-gateway
Build command:   (empty)
Deploy command:  npx wrangler deploy
Version command: npx wrangler deploy --dry-run
```

The `wrangler.jsonc` in this directory is the Worker source of truth. The Durable Object uses SQLite storage and WebSocket Hibernation.
