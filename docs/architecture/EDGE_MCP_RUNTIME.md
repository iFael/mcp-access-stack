# Edge MCP Runtime

## Status

The Cloudflare edge is the preferred steady-state architecture for this workstation. The Worker is already deployable from `main`, but workspace traffic remains fail-closed until the connector and activation gates are completed.

## Target topology

```text
ChatGPT
  -> Cloudflare Worker
  -> Durable Object session
  <-> authenticated outbound WebSocket
  -> Windows MCP Connector (single process)
       |- embedded MCP Gateway on ephemeral 127.0.0.1 only
       |- LocalAgent / workspace policy in-process
       `- optional current Browser Worker during the browser transition
  -> local workspaces
```

GitHub remains authoritative for source and CI. Cloudflare provides the public serverless edge and connection coordination.

## Windows boundary

The connector is the only new steady-state MCP process planned for Windows. It opens no public listener and requires no inbound SSH. Its embedded Gateway binds an ephemeral port on `127.0.0.1` only; all Internet-facing traffic arrives over the connector-initiated `wss://.../connector` session.

The connector reuses the existing `LocalAgent`, `InProcessWorkspaceExecutor` and MCP Gateway instead of duplicating their behavior. Therefore workspace permission profiles, destructive-command confirmation, audit logging, cancellation, background tasks, OAuth and MCP tool behavior remain implemented by the already-tested components.

The current resident runtime remains a fallback until the Edge path is proven end to end. Cleanup is a later gate.

## Edge gateway

`services/mcp-edge-gateway` provides:

- `GET /health` for edge/connector readiness;
- `/connector` as the Bearer-authenticated WebSocket boundary;
- a singleton Durable Object coordinating the connector;
- WebSocket Hibernation-compatible state;
- a strict HTTP relay allowlist for `/mcp` and the Owner OAuth endpoints only;
- explicit relay cancellation propagated to the connector;
- header allowlists, size limits, concurrency limits and relay deadline;
- fail-closed deployment with `MCP_EDGE_ENABLED=false` by default.

The shared protocol is versioned in `packages/edge-protocol`. Protocol mismatch fails closed during the WebSocket handshake.

## Owner OAuth preservation

Production currently uses the Gateway's Owner OAuth flow. The Edge therefore does not implement a second authentication system. It relays only the exact Gateway paths required by the existing flow:

- `/mcp`;
- `/authorize`;
- `/token`;
- `/register`;
- `/revoke`;
- `/.well-known/oauth-authorization-server`;
- `/.well-known/oauth-protected-resource`;
- `/.well-known/oauth-protected-resource/mcp`.

The `Origin` header is preserved so the Gateway's existing origin policy remains authoritative. Hop-by-hop, forwarding and arbitrary application headers are not relayed.

## Connector configuration

The connector is started only after its artifacts and secrets have been qualified. Required connector-specific settings are documented in `config/edge-connector.env.example`.

`MCP_CONNECTOR_TOKEN` exists only as a Cloudflare secret. The Windows side reads the same value from a bounded local secret file via `MCP_CONNECTOR_TOKEN_FILE`; the token is never accepted as a command-line argument and is never logged.

The embedded Gateway continues to consume its normal authentication and Browser settings from the process environment. `AUTH_MODE=none` is rejected by the connector.

## Persistent Windows ownership

The production connector is owned by a dedicated Scheduled Task instead of a terminal session or an FNM-managed shell. The task is installed by `deploy/windows/Install-McpEdgeConnectorTask.ps1`. PowerShell remains an installation-time validation surface only; the persistent task action executes the signed `compat/McpNodeHostLauncher.exe` Windows-GUI-subsystem launcher directly from the immutable release.

The persistence contract is deliberately bounded:

- the task runs as the current interactive user with `Limited` run level, while the persistent owner is a signed `winexe` launcher that starts bundled Node.js with `CreateNoWindow=true`; no PowerShell process or console window owns the steady-state runtime;
- it starts at logon, uses `MultipleInstances=IgnoreNew`, has no execution time limit and uses the Task Scheduler restart policy;
- the task pins the SHA-256 of `execution-node-manifest.json` and refuses a release whose critical artifacts changed after installation;
- the connector CLI, PowerShell validation launcher and native GUI launcher are explicit critical artifacts in native-Edge execution-node manifests; four-artifact legacy and six-artifact PowerShell-Edge manifests remain valid only for historical rollback compatibility;
- Node.js is the bundled runtime from the immutable release; the task never depends on FNM, `PATH` resolution or a developer shell;
- `MCP_CONNECTOR_TOKEN` remains a file path in the child environment and the embedded Gateway Owner token is injected by the native launcher from a bounded private file. The Owner token plaintext is never placed in Scheduled Task arguments, source, manifests or logs;
- Owner OAuth registration and session state is durable under the same private runtime root. Registered public clients and SHA-256 hashes of access/refresh tokens are persisted atomically; Owner, access and refresh token plaintext values are never written to the state file;
- the launcher forces `BROWSER_WORKER_ENABLED=false` during the initial Edge persistence qualification. Browser ownership remains a later migration gate;
- installation runs the signed `Start-McpEdgeConnector.ps1 -ValidateOnly` preflight before task registration; PowerShell is not the persistent runtime owner;
- `deploy/windows/Test-McpEdgeConnectorTerminalIndependence.ps1` is the mandatory persistence gate. It identifies any console/terminal window associated with the Edge launcher, closes the real terminal window when one exists, records the original launcher and Node PIDs, and rejects a result where Task Scheduler merely restarts the connector after the original process tree dies;
- terminal independence passes only when no Edge terminal is present, the original native launcher PID and original Node PID remain alive, the task remains `Running`, Worker health remains `connectorReady=true`, and a real V3 operation succeeds afterward;
- Edge production cutovers use the existing lifecycle broker in `EdgeOnly` mode: lifecycle pointers still promote/rollback atomically, but the redundant `McpHost` Scheduled Task is retired instead of recreated.

The persistent task may be installed and qualified while `MCP_EDGE_ENABLED=false`. Enabling the public Edge relay remains a separate explicit gate after startup, restart and reconnect behavior are proven.

## Migration boundaries

1. deploy and validate the disabled Edge gateway;
2. implement and qualify the outbound connector in Git/CI;
3. materialize the connector secret in Cloudflare and Windows outside Git;
4. run the connector and prove `/health` reports `connectorReady=true` while `MCP_EDGE_ENABLED=false`;
5. explicitly enable the Edge relay and validate Owner OAuth plus MCP filesystem/Git/shell/background operations;
6. qualify Browser reachability separately;
7. keep the current local runtime as fallback until the Edge path is stable;
8. retire obsolete resident components only in a separate cleanup gate.

## SSH fallback

The previously implemented `SshWorkspaceExecutor`, remote compose and OpenSSH bootstrap remain valid fallback code. They are not required by the Edge steady state.
