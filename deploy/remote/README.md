# Remote MCP Runtime

This is the target production layout for `mcp-access-stack`.

## Boundary

The corporate Windows PC remains the development workstation and workspace authority. It keeps repositories and normal developer tools, but no resident MCP runtime.

The remote host owns:

- MCP Gateway and public MCP transport;
- workspace policy and confirmation state;
- SSH workspace execution;
- Browser Worker and its persistent browser profile;
- Browser credentials and private-site policy;
- background-task state;
- Proxy and Tunnel/public ingress.

The Windows PC exposes only standard OpenSSH Server. Workspace operations are transported through OpenSSH and execute with the explicitly configured Windows user identity.

## Runtime topology

```text
ChatGPT -> public /mcp -> tunnel/proxy -> Gateway
                                      |-> SSH -> Windows workspace
                                      `-> Browser Worker -> Chromium
```

No `McpHost.exe`, Workspace Agent, Browser Worker, MCP-managed Node runtime, credential broker, release supervisor or MCP Scheduled Task is required on Windows after cutover and cleanup.

## Files that stay outside Git

Create a private deployment directory on the remote host and populate these files from GitHub Environment secrets or the server secret store:

- `gateway.env`;
- `browser.env`;
- `tunnel.env`;
- `workspace-ssh-key`;
- `workspace-known-hosts`;
- `workspace-policy.json`;
- `browser-credentials.json`;
- `browser-site-policies.json`.

`remote-runtime.example`, `gateway.example` and `browser.example` document the non-secret shape. Never commit populated copies.

Browser credentials use this schema:

```json
{
  "version": 1,
  "credentials": [
    {
      "siteId": "private-site-id",
      "accountId": "default",
      "username": "<secret>",
      "password": "<secret>"
    }
  ]
}
```

The credential file is copied to a mode-0600 temporary file before Browser Worker starts. The broker reads it only when a configured private site requests credential authentication and zeroes credential buffers after use through the existing `CredentialSecret` lifecycle.

## Images

The release workflow publishes three immutable GHCR image families:

- `mcp-access-stack-gateway`;
- `mcp-access-stack-browser-worker`;
- `mcp-access-stack-proxy`.

Production should pin a release tag or digest, never build application code on the runtime host.
`.github/workflows/deploy-remote.yml` is the GitHub-owned deployment entrypoint. It requires the `remote-production` Environment and these deployment secrets:

- `MCP_REMOTE_DEPLOY_HOST`;
- `MCP_REMOTE_DEPLOY_PORT` (optional, defaults to 22);
- `MCP_REMOTE_DEPLOY_USER`;
- `MCP_REMOTE_DEPLOY_PATH`;
- `MCP_REMOTE_DEPLOY_SSH_KEY`;
- `MCP_REMOTE_DEPLOY_KNOWN_HOSTS`.

The workflow transfers only the versioned deployment definition. Runtime secrets remain pre-provisioned under the remote deployment path and are never copied from the repository. The selected workflow version overrides image references so GitHub controls the immutable release being deployed.

## Windows bootstrap

`deploy/windows/Configure-McpSshWorkspaceHost.ps1` is the only Windows installation bootstrap required by this architecture. It installs/enables the Windows OpenSSH Server capability and installs the authorized public key. It does not install MCP binaries or modify endpoint protection.

Do not run the bootstrap until the explicit cutover gate. Direct inbound TCP/22 is optional; if network topology prevents inbound reachability, the same SSH backend can target an approved forwarded/reverse-tunnel endpoint without restoring a resident MCP runtime.

## Cutover rule

Keep the temporary beta.8 recovery Agent running until the remote Gateway proves the SSH workspace backend and Browser Worker through the canonical `/mcp`. Only then stop and remove the legacy local MCP runtime in a separate cleanup boundary.
