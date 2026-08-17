# Edge MCP Runtime

## Status

Current target architecture for this workstation. It supersedes the dedicated remote-VM/OpenSSH cutover as the preferred steady-state direction before that cutover was executed.

The objective is to avoid a permanently managed external VM while still removing most resident MCP runtime components from the corporate Windows workstation.

## Target topology

```text
ChatGPT
  -> Cloudflare Worker (`mcp-edge-gateway`)
  -> Durable Object session
  <-> authenticated outbound WebSocket
  -> Windows MCP Connector
  -> local workspace execution boundary
```

GitHub remains authoritative for source, CI and immutable release artifacts. Cloudflare provides the public serverless edge and connection coordination.

## Windows boundary

The Windows workstation initiates the connection outbound. No public inbound SSH port is required for the edge design.

The target resident surface is a single bounded MCP Connector plus the normal developer tools already required by the workspaces. The connector must not become another general-purpose remote shell: authorization, workspace policy, bounded operations, cancellation and destructive confirmation remain mandatory.

The existing local Agent remains a temporary fallback until the edge path is proven end to end. Legacy cleanup is a later gate.

## Edge gateway

`services/mcp-edge-gateway` provides:

- `/mcp` public edge route;
- `/connector` authenticated WebSocket route;
- a singleton Durable Object coordinating the active connector;
- WebSocket Hibernation-compatible connector state;
- bounded request/response relay;
- header allowlists;
- request/response size limits;
- relay timeout;
- fail-closed deployment with `MCP_EDGE_ENABLED=false` by default.

The initial deployment is intentionally non-operational for workspace access until a connector secret exists, the Windows connector is implemented and the `/mcp` activation gate is explicitly executed.

## Migration boundaries

1. deploy the disabled edge gateway from Git and validate Cloudflare health;
2. implement and authenticate the outbound Windows connector;
3. validate MCP relay, cancellation, filesystem/Git/shell/background operations and Browser strategy;
4. enable the edge `/mcp` route only after the security and connector gates pass;
5. keep the current local runtime as fallback until the new path is stable;
6. retire obsolete resident MCP components only in a separate cleanup gate.

## Browser

Browser execution remains a separate decision. A local Browser Worker preserves access to corporate-only destinations; a remote/browser-managed option reduces Windows residency but may lose that reachability. Do not remove the current Browser Worker before empirical qualification.

## SSH implementation

The previously implemented `SshWorkspaceExecutor`, remote compose and OpenSSH bootstrap remain valid code and fallback options, but are not the preferred cutover path for this workstation while the edge-connector architecture is being adopted.
