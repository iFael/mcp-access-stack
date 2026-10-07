# Update Control deployment

Status: versioned deployment preparation only. This documentation does not provision Cloudflare resources, write secrets, dispatch workflows, activate Oracle services, or enroll users.

## Public endpoint and Oracle channel

- The dedicated Worker is `mcp-v3-update-control`, configured in `services/update-control-worker/wrangler.jsonc` with `workers_dev: true` and `preview_urls: false`. Its production public origin is the configured `MCP_UPDATE_CONTROL_PUBLIC_URL` under `workers.dev`; no custom domain is required.
- The Worker hosts the independent MCP endpoint, local human-auth/enrollment pages, the fixed administrative bootstrap operation `/_operations/admin/bootstrap`, and the fixed OAuth reprovision operation `/_operations/oauth/reprovision`. Operation URLs are derived from the same public origin; there is no generic administrative mutation endpoint.
- The Oracle read API remains bound only to `127.0.0.1:9381` and uses the local `UPDATE_CONTROL_ORCHESTRATOR_TOKEN` credential. The Oracle connector initiates authenticated WSS outbound to the Worker using `UPDATE_CONTROL_ORACLE_CHANNEL_URL` and the dedicated `UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN` credential. The Worker does not initiate connections to Oracle.
- SQLite in the Oracle Orchestrator remains the sole authority for runs and events. The channel Durable Object holds only the active socket and in-flight RPC correlations; it does not persist run state.
- The public MCP catalog remains exactly `update_list_runs`, `update_get_run`, and `update_wait_events`; all three remain read-only. Identity and user administration are outside the MCP tool catalog.

## Local TOTP identity and authorization

- The Update Control itself is the authority for human identities. ChatGPT still uses OAuth authorization-code + PKCE, while the human proof is local e-mail plus RFC 6238 TOTP; no external IdP, tenant, app registration, Graph or Entra dependency participates in login.
- `UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL` pins the first local admin. `UPDATE_CONTROL_TOTP_ENCRYPTION_KEY` is a dedicated infrastructure secret used only to encrypt per-user TOTP seeds at rest with AES-GCM.
- Microsoft Authenticator may be used only as a generic RFC 6238 client through the local `otpauth://` QR; the runtime does not contact or trust Microsoft. Other compatible authenticator apps work with the same provisioning URI.
- The Worker persists local `userId`, e-mail, status and role. Canonical roles are `admin` and `user`; legacy `operator`/`viewer` records are read compatibly as `user`, while unknown roles fail closed. TOTP replay is blocked with the last accepted counter, and repeated failures cause a bounded temporary lockout.
- Enrollment emits one-time recovery codes exactly once; only their hashes are persisted. A recovery code is consumed after successful use.
- There is no human `Access password`, `MCP_OWNER_TOKEN`, replacement owner token, or password-recovery credential in the canonical login path.
- The first admin can only enroll while a short HMAC-opened bootstrap window is active and the submitted e-mail matches `UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL` case-insensitively. After the first user exists, new identities require a one-time invitation created by an authenticated local admin.
- The authenticated `/admin` surface is outside MCP. It uses a secure HttpOnly/SameSite session cookie plus CSRF protection for invitation creation, user revocation, and sign-out. The bootstrap admin remains the unique administrator; invited/enrolled non-bootstrap identities are always `user`, and the bootstrap admin cannot be demoted or revoked.
- Revoking a user immediately makes existing Update Control MCP access/refresh tokens unusable because token validation resolves the current local user state on every authorization.

## GitHub Actions deploy boundary

- Workflow: `.github/workflows/update-control-deploy.yml`. Pull requests run validation without entering the Environment or reading secrets/variables. Deployment is `workflow_dispatch` only on `main`, has no magic confirmation input, and uses the `update-control-production` Environment for secrets plus the `main` deployment branch policy. The Environment must not require a human reviewer for an already delegated deploy objective. There is no push-triggered deployment.
- Wrangler is the locked workspace dependency. The workflow deploys only `services/update-control-worker/wrangler.jsonc`, passes the public URL plus bootstrap-admin e-mail variable, and installs protected Worker secrets through Wrangler stdin. It does not participate in the Edge release workflow.
- Before Wrangler runs, the preflight validates all required Environment inputs and reports setting names/status only. Required **secrets** are `UPDATE_CONTROL_CF_API_TOKEN`, `UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN`, `UPDATE_CONTROL_ADMIN_HMAC_KEY`, and `UPDATE_CONTROL_TOTP_ENCRYPTION_KEY`. Required **variables** are `CLOUDFLARE_ACCOUNT_ID`, `MCP_UPDATE_CONTROL_PUBLIC_URL`, and `UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL`.
- The public URL must be a valid HTTPS root origin on the canonical Worker subdomain under `workers.dev`; both administrative HMAC and TOTP encryption key must satisfy their 64-hex contracts. Missing or malformed inputs stop before deployment; secret values are never printed.
- A published Worker with missing local-identity/admin-HMAC/channel configuration is not healthy. Stop and reconcile the same deploy before any bootstrap, OAuth reprovision, plugin connection, or Oracle connector activation.

## Administrative HMAC boundary

- `UPDATE_CONTROL_ADMIN_HMAC_KEY` is infrastructure authority only. It does not represent Rafael or any other human identity and cannot produce a local `userId`.
- Administrative operations use HMAC-SHA-256 with separate domain separators and bind method, fixed path, operation UUID, and a short timestamp. The Worker strips client-supplied internal markers and injects trusted markers only after successful top-level verification.
- `.github/workflows/update-control-admin-bootstrap.yml` is `workflow_dispatch`, main-only and Environment-backed. It takes a stable operation UUID plus functional `mode=diagnose|bootstrap`; there is no confirmation phrase. `bootstrap` opens only the bounded first-admin enrollment window, while `diagnose` is read-only. Once any user exists, bootstrap fails closed.
- `.github/workflows/update-control-oauth-reprovision.yml` is `workflow_dispatch`, main-only and Environment-backed. It takes a stable operation UUID plus functional `mode=diagnose|apply`; there is no confirmation phrase. The same UUID must be preserved while reconciling a single operation.
- OAuth reprovision invalidates Update Control OAuth clients, pending authorizations, access-token signing material, refresh state, revocations, and admin web sessions while preserving local identities, encrypted TOTP credentials, recovery hashes, roles, status, bootstrap history, and invitation state. Ambiguous or `outcome_unknown` operations must be reconciled with the same UUID; there is no blind retry or secret rotation.
- Neither administrative workflow uses GitHub OIDC/JWKS, `id-token: write`, `MCP_OWNER_TOKEN`, or `UPDATE_CONTROL_OWNER_TOKEN_NEXT`.

## Oracle service boundary

- `mcp-v3-oracle-read-api.service` listens only on `127.0.0.1:9381`, reads the protected Orchestrator bearer from systemd credentials, and stores its ledger outside the versioned release tree.
- `mcp-v3-update-control-oracle-channel.service` is a separate outbound connector. It reads the WSS URL from `/etc/mcp-access-stack/update-control/oracle-channel.env` and channel/API credentials through protected systemd credential files. It has no inbound listener, offline RPC queue, or run cache.
- The units and credential paths are versioned templates only. They are not installed, enabled, started, or restarted by this code-only change.

## Operational sequence

1. Provision the protected GitHub Environment values for the local identity model without exposing secret contents, including a dedicated random `UPDATE_CONTROL_TOTP_ENCRYPTION_KEY`. No Microsoft/Entra application or tenant is required.
2. Reconcile `main`, confirm zero equivalent active runs, then dispatch exactly one Update Control deploy on `main`. There is no confirmation literal. Preserve the run identity and validate the exact run/head plus Worker readiness before continuing.
3. When production has no enrolled Update Control users, use a new UUID with `mode=bootstrap` to open the bounded first-admin window; use `mode=diagnose` for read-only reconciliation. The intended first admin opens `/enroll`, scans the local QR in a compatible authenticator, verifies the first TOTP, and stores the one-time recovery codes. HMAC is not the human login.
4. Use the authenticated `/admin` surface to create one-time invitations. Invited identities enroll as `user`; the bootstrap admin remains the unique `admin`. Unknown identities without an invitation remain denied.
5. If an OAuth reset is part of the delegated objective, use one stable reprovision UUID: `mode=diagnose` for read-only reconciliation and `mode=apply` for the mutation. Preserve the same UUID through reconciliation; never retry blindly on `outcome_unknown`.
6. Validate the independent `/mcp` endpoint and exactly three read-only tools. Existing OAuth clients may need a fresh plugin connection after reprovisioning. Because this change does not add or change MCP tool schemas, no catalog rematerialization is required solely for the code change; rematerialize/reload if a later gate changes public MCP tools or schemas.
7. Only after identity/MCP homologation should the separate Oracle runtime activation and later hardening gates proceed.

None of these operational steps are performed by this PR.
