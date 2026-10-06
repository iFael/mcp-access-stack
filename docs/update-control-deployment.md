# Update Control deployment

Status: versioned deployment preparation only. This documentation does not provision Cloudflare resources, write secrets, dispatch workflows, activate Oracle services, register a Microsoft application, or enroll users.

## Public endpoint and Oracle channel

- The dedicated Worker is `mcp-v3-update-control`, configured in `services/update-control-worker/wrangler.jsonc` with `workers_dev: true` and `preview_urls: false`. Its production public origin is the configured `MCP_UPDATE_CONTROL_PUBLIC_URL` under `workers.dev`; no custom domain is required.
- The Worker hosts the independent MCP endpoint, Microsoft callback `/auth/microsoft/callback`, the fixed administrative bootstrap operation `/_operations/admin/bootstrap`, and the fixed OAuth reprovision operation `/_operations/oauth/reprovision`. Operation URLs are derived from the same public origin; there is no generic administrative mutation endpoint.
- The Oracle read API remains bound only to `127.0.0.1:9381` and uses the local `UPDATE_CONTROL_ORCHESTRATOR_TOKEN` credential. The Oracle connector initiates authenticated WSS outbound to the Worker using `UPDATE_CONTROL_ORACLE_CHANNEL_URL` and the dedicated `UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN` credential. The Worker does not initiate connections to Oracle.
- SQLite in the Oracle Orchestrator remains the sole authority for runs and events. The channel Durable Object holds only the active socket and in-flight RPC correlations; it does not persist run state.
- The public MCP catalog remains exactly `update_list_runs`, `update_get_run`, and `update_wait_events`; all three remain read-only. Identity and user administration are outside the MCP tool catalog.

## Microsoft identity and local authorization

- Human authentication uses Microsoft Identity Platform authorization-code flow with PKCE. The Worker exchanges the Microsoft code with the protected `MICROSOFT_CLIENT_SECRET`, resolves the authenticated identity through Microsoft UserInfo, and does not persist Microsoft access tokens or the Microsoft application secret.
- Required Microsoft configuration is `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT`, and `MICROSOFT_CLIENT_SECRET`. `UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL` pins the first enrollment to the intended Microsoft account. The Microsoft application redirect URI must be the exact public callback `<MCP_UPDATE_CONTROL_PUBLIC_URL>/auth/microsoft/callback`.
- Local authorization is independent from Microsoft authentication. The Worker persists a local `userId`, Microsoft subject binding, status, and role. Canonical roles are `admin`, `operator`, and `viewer`.
- There is no human `Access password`, `MCP_OWNER_TOKEN`, replacement owner token, or password-recovery flow in the canonical Update Control login path.
- The first local admin can only be enrolled while a short administrative bootstrap window is active **and** the verified Microsoft UserInfo e-mail matches `UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL` case-insensitively. A racing Microsoft identity cannot claim the bootstrap window merely by authenticating first. After the first user exists, unknown Microsoft identities fail closed unless they follow a one-time invite created by an authenticated local admin.
- The authenticated `/admin` surface is outside MCP. It uses a secure HttpOnly/SameSite session cookie plus CSRF protection for invitation creation, role changes, user revocation, and sign-out. The final active admin cannot be demoted or revoked.
- Revoking a user immediately makes existing Update Control MCP access/refresh tokens unusable because token validation resolves the current local user state on every authorization.

## GitHub Actions deploy boundary

- Workflow: `.github/workflows/update-control-deploy.yml`. Pull requests run validation without entering the protected Environment or reading secrets/variables. Deployment is `workflow_dispatch` only, on `main`, requires the literal `DEPLOY_UPDATE_CONTROL`, and uses the protected `update-control-production` Environment. There is no push-triggered deployment.
- Wrangler is the locked workspace dependency. The workflow deploys only `services/update-control-worker/wrangler.jsonc`, passes the public URL plus Microsoft client/tenant variables, and installs protected Worker secrets through Wrangler stdin. It does not participate in the Edge release workflow.
- Before Wrangler runs, the preflight validates all required Environment inputs and reports setting names/status only. Required **secrets** are `UPDATE_CONTROL_CF_API_TOKEN`, `UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN`, `UPDATE_CONTROL_ADMIN_HMAC_KEY`, and `MICROSOFT_CLIENT_SECRET`. Required **variables** are `CLOUDFLARE_ACCOUNT_ID`, `MCP_UPDATE_CONTROL_PUBLIC_URL`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT`, and `UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL`.
- The public URL must be a valid HTTPS root origin on the canonical Worker subdomain under `workers.dev`. Microsoft client ID must be a GUID; tenant is `common`, `organizations`, `consumers`, or a tenant GUID. Missing or malformed inputs stop before deployment; secret values are never printed.
- A published Worker with missing Microsoft/admin-HMAC/channel configuration is not healthy. Stop and reconcile the same deploy before any bootstrap, OAuth reprovision, plugin connection, or Oracle connector activation.

## Administrative HMAC boundary

- `UPDATE_CONTROL_ADMIN_HMAC_KEY` is infrastructure authority only. It does not represent Rafael or any other human identity and cannot produce a local `userId`.
- Administrative operations use HMAC-SHA-256 with separate domain separators and bind method, fixed path, operation UUID, and a short timestamp. The Worker strips client-supplied internal markers and injects trusted markers only after successful top-level verification.
- `.github/workflows/update-control-admin-bootstrap.yml` is manual, main-only, protected by the Environment, and requires the literal `BOOTSTRAP_UPDATE_CONTROL_ADMIN` plus a UUID. It opens only the bounded first-admin enrollment window; once any user exists, bootstrap fails closed.
- `.github/workflows/update-control-oauth-reprovision.yml` is manual, main-only, protected by the Environment, and requires `REPROVISION_OAUTH_AND_INVALIDATE_ALL_SESSIONS` plus a stable UUID.
- OAuth reprovision invalidates Update Control OAuth clients, pending authorizations, access-token signing material, refresh state, revocations, and admin web sessions while preserving local identities, Microsoft bindings, roles, status, and invitation state. Ambiguous or `outcome_unknown` operations must be reconciled with the same UUID; there is no blind retry or secret rotation.
- Neither administrative workflow uses GitHub OIDC/JWKS, `id-token: write`, `MCP_OWNER_TOKEN`, or `UPDATE_CONTROL_OWNER_TOKEN_NEXT`.

## Oracle service boundary

- `mcp-v3-oracle-read-api.service` listens only on `127.0.0.1:9381`, reads the protected Orchestrator bearer from systemd credentials, and stores its ledger outside the versioned release tree.
- `mcp-v3-update-control-oracle-channel.service` is a separate outbound connector. It reads the WSS URL from `/etc/mcp-access-stack/update-control/oracle-channel.env` and channel/API credentials through protected systemd credential files. It has no inbound listener, offline RPC queue, or run cache.
- The units and credential paths are versioned templates only. They are not installed, enabled, started, or restarted by this code-only change.

## Operational sequence after separate authorization

1. Create/configure the Microsoft application outside this PR, including the exact callback URI, and provision the protected GitHub Environment values without exposing secret contents.
2. Reconcile `main`, confirm zero equivalent active runs, then manually dispatch exactly one Update Control deploy with `DEPLOY_UPDATE_CONTROL`. Validate the exact run/head and Worker readiness before continuing.
3. When production has no enrolled Update Control users, use a new UUID and the literal `BOOTSTRAP_UPDATE_CONTROL_ADMIN` to open the bounded first-admin window. The intended first admin then authenticates with Microsoft; do not treat HMAC as the human login.
4. Use the authenticated `/admin` surface to create one-time invitations and assign `admin`, `operator`, or `viewer` roles. Unknown identities without an invitation remain denied.
5. If a deliberate OAuth reset is required, use a new explicitly authorized reprovision UUID. Preserve the same UUID through reconciliation; never retry blindly on `outcome_unknown`.
6. Validate the independent `/mcp` endpoint and exactly three read-only tools. Existing OAuth clients may need a fresh plugin connection after reprovisioning. Because this change does not add or change MCP tool schemas, no catalog rematerialization is required solely for the code change; rematerialize/reload if a later gate changes public MCP tools or schemas.
7. Only after identity/MCP homologation should the separate Oracle runtime activation and later hardening gates proceed.

None of these operational steps are performed by this PR.
