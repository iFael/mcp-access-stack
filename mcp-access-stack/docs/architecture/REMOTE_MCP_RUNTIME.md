# Remote MCP Runtime

## Status

Target architecture for production after the Bitdefender ATC incident on the corporate Windows workstation.

The workstation remains the normal development machine. The MCP runtime moves to remote infrastructure. Windows exposes only standard OpenSSH Server for authorized workspace access.

## Target topology

```text
GitHub
  -> CI / tests / builds / GHCR images / release metadata

Remote host
  -> Tunnel / Proxy
  -> MCP Gateway
     |-> SSH WorkspaceExecutor -> corporate Windows OpenSSH
     `-> Browser Worker -> remote persistent Chromium
  -> remote policy / task state / browser secrets

Corporate Windows PC
  -> OpenSSH Server
  -> repositories
  -> Git / PowerShell / WSL / Docker / developer tools
```

## GitHub authority

GitHub is authoritative for:

- MCP source;
- CI and tests;
- Gateway image;
- Browser Worker image;
- Proxy image;
- deployment manifests and scripts;
- release identity and immutable image tags/digests;
- Windows OpenSSH bootstrap source.

Secrets never enter Git history. They are materialized through GitHub Environment secrets or the remote host secret store.

## Windows boundary

After cutover and cleanup, Windows does not require a resident MCP execution node.

The following are removed from the steady-state Windows architecture:

- `McpHost.exe`;
- `McpNodeHostLauncher.exe`;
- `McpCredentialBroker.exe`;
- `Run-DockerHostComponent.mjs`;
- resident Workspace Agent;
- resident Browser Worker;
- MCP-managed Node runtime;
- MCP execution-node state and release supervisor;
- MCP Agent/Browser/cutover/promotion Scheduled Tasks.

The only MCP-related machine integration is standard Windows OpenSSH configuration and its authorized public key.

## Workspace transport

The public MCP tool contract remains based on `WorkspaceExecutor`.

Legacy path:

```text
Gateway -> RelayWorkspaceExecutor -> resident Workspace Agent
```

Remote path:

```text
Gateway -> SshWorkspaceExecutor -> OpenSSH -> pwsh.exe -> workspace
```

`SshWorkspaceExecutor` keeps authorization on the remote runtime side and transports only bounded operations to Windows. SSH uses:

- key authentication;
- `BatchMode=yes`;
- strict host-key checking;
- an explicit `known_hosts` file;
- an explicit private key;
- bounded connect and operation deadlines;
- PowerShell 7 (`pwsh.exe`) on Windows.

No helper binary or script is installed for request execution. The bounded PowerShell RPC script is sent over the authenticated SSH session on demand.

## Workspace security

The SSH backend continues to enforce the existing workspace policy model before dispatch:

- workspace identity and enabled state;
- permission profile;
- allowed roots;
- write roots;
- shell roots and allowed shells;
- mandatory blocked globs;
- traversal/absolute-path rejection;
- destructive-command confirmation;
- protected Git push policy;
- file-size/search/list limits.

The Windows RPC boundary independently rejects path traversal, root escape and reparse-point traversal before filesystem access.

## Browser

Browser Worker moves to the remote runtime and runs Chromium headless with a persistent MCP-owned profile.

The Gateway reaches Browser Worker only on the private Docker network. The Worker may bind `0.0.0.0` inside its container only when explicitly configured; the Browser port is not published to the host by `deploy/remote/compose.yml`.

Private-site credentials are no longer read through the Windows Credential Manager. The remote deployment mounts a mode-0600 secret JSON file and `FileCredentialBroker` adapts it to the existing disposable `CredentialSecret` contract. Credentials are not logged and secret buffers are zeroed after authentication.

## Runtime deployment

The remote production bundle is `deploy/remote/compose.yml`:

- Gateway;
- Browser Worker;
- Proxy;
- Tunnel.

The GitHub release workflow publishes immutable Gateway, Browser Worker and Proxy GHCR images. The runtime host pulls images; it does not build application source.

## Migration

Migration has only three operational milestones:

1. implement and validate the remote runtime in Git/CI;
2. configure OpenSSH and execute a controlled cutover while the temporary beta.8 recovery Agent remains available as fallback;
3. after remote `/mcp`, workspace and Browser validation, retire the legacy local MCP runtime.

The beta.12 Minimal Windows Execution Node is not the target steady-state architecture for this workstation. Its supply-chain/build/signing work remains useful, but the resident execution-node ownership/cutover model is superseded here by the remote runtime.

## Network reachability

SSH transport supports any host/port supplied by deployment configuration. The cutover gate must first test whether the remote host can reach Windows directly. If corporate NAT/firewall prevents inbound reachability, use an approved SSH forwarding path while keeping the same `SshWorkspaceExecutor` contract. Do not restore a resident MCP Agent merely to solve routing.
