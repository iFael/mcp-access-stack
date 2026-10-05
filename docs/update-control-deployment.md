# Update Control deployment

Status: versioned deployment preparation only. This documentation does not provision Cloudflare resources, write secrets, dispatch workflows, or activate Oracle services.

## Public endpoint and Oracle channel

- The dedicated Worker is `mcp-v3-update-control`, configured in `services/update-control-worker/wrangler.jsonc` with `workers_dev: true` and `preview_urls: false`. Its production public origin is the configured `MCP_UPDATE_CONTROL_PUBLIC_URL` under `workers.dev`; no custom domain is required.
- The Worker hosts the MCP endpoint and the fixed OAuth reprovision operation at `/_operations/oauth/reprovision`. The operation URL is derived from the public origin in both the Worker and GitHub operator; there is no separately configured operations hostname.
- The Oracle read API remains bound only to `127.0.0.1:9381` and uses the local `UPDATE_CONTROL_ORCHESTRATOR_TOKEN` credential. The Oracle connector initiates authenticated WSS outbound to the Worker using `UPDATE_CONTROL_ORACLE_CHANNEL_URL` and the dedicated `UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN` credential. The Worker does not initiate connections to Oracle.
- SQLite in the Oracle Orchestrator remains the sole authority for runs and events. The channel Durable Object holds only the active socket and in-flight RPC correlations; it does not persist run state.

## GitHub Actions deploy boundary

- Workflow: `.github/workflows/update-control-deploy.yml`. Pull requests run validation without entering the protected Environment or reading secrets/variables. Deployment is `workflow_dispatch` only, on `main`, requires the literal `DEPLOY_UPDATE_CONTROL`, and uses the protected `update-control-production` Environment. There is no push-triggered deployment.
- Wrangler is the locked workspace dependency. The workflow deploys only `services/update-control-worker/wrangler.jsonc`, passes the public URL variable, and installs the Oracle channel token via Wrangler stdin. It does not participate in the Edge release workflow.
- Before Wrangler runs, the preflight validates all required Environment inputs and reports setting names/status only. Required **secrets** are `UPDATE_CONTROL_CF_API_TOKEN` and `UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN`. Required **variables** are `CLOUDFLARE_ACCOUNT_ID` and `MCP_UPDATE_CONTROL_PUBLIC_URL`.
- The public URL must be a valid HTTPS root origin on a Worker subdomain under `workers.dev`. Values containing credentials, a nonstandard port, a path, query, fragment, or control characters fail closed. Missing or malformed inputs stop before deployment; values are not printed.
- The channel secret is installed after the Worker code deploy. If that write fails, the workflow fails and Oracle RPC remains unavailable; stop and reconcile the deployment before any connector activation. Do not treat a published but unconfigured Worker as healthy.

## OAuth controlled reprovision

- `.github/workflows/update-control-oauth-reprovision.yml` remains manual, main-only, protected by the same Environment, and requires the explicit `REPROVISION_OAUTH_AND_INVALIDATE_ALL_SESSIONS` confirmation plus a stable UUID. Only its reprovision job receives `id-token: write`.
- The operator uses `MCP_UPDATE_CONTROL_PUBLIC_URL` and derives the exact HTTPS path `/_operations/oauth/reprovision`. Worker and operator reject invalid/non-HTTPS public origins, credentials, ports, paths, query strings, fragments, and malformed URLs. The operation is restricted to the existing typed OAuth reprovision behavior; there is no generic admin route.
- GitHub OIDC validation remains fail closed for the fixed GitHub issuer/JWKS, repository, workflow reference, `main` ref, allowed event, protected Environment, UUID-bound audience, and token time claims. Reconciliation must reuse the same operation UUID and replacement token; `outcome_unknown` does not trigger blind retry or rollback.
- The operation invalidates persisted OAuth clients, authorizations, refresh tokens, access-token signing state, and sessions; a new explicit authorization is required. It does not touch the Orchestrator SQLite ledger, run evidence, Edge Worker, or its catalog.

## Oracle service boundary

- `mcp-v3-oracle-read-api.service` listens only on `127.0.0.1:9381`, reads the protected Orchestrator bearer from systemd credentials, and stores its ledger outside the versioned release tree.
- `mcp-v3-update-control-oracle-channel.service` is a separate outbound connector. It reads the WSS URL from `/etc/mcp-access-stack/update-control/oracle-channel.env` and channel/API credentials through protected systemd credential files. It has no inbound listener, offline RPC queue, or run cache.
- The units and credential paths are versioned templates only. They have not been installed, enabled, started, or restarted in this change. No Cloudflare resource, Environment secret, deployment, or OAuth operation is created or run by these files.

## Operational sequence after separate authorization

1. Confirm the target account remains on the Free plan and the required protected GitHub Environment values exist; stop if the UI requests billing, a card, an upgrade, or overage consent.
2. Manually dispatch the dedicated Update Control deploy workflow on `main` with its explicit confirmation. Verify the resulting Worker URL, configured channel secret, and health before enabling the Oracle connector.
3. Provision the protected Oracle runtime credentials/configuration and install the versioned read API and outbound connector units through the authorized host lifecycle. Keep the API bound to loopback.
4. Start the connector only after the Worker channel is healthy; validate read-only list/get/wait behavior against a synthetic run and preserve `afterSeq`, ordering, replay, and timeout distinctions.
5. Before the first OAuth authorization, run the separate protected OIDC reprovision workflow with a new UUID, replacement owner token, and explicit confirmation. Reconcile ambiguity with the same UUID/token.
6. Validate the independent MCP endpoint and then stop at the plugin refresh/reload gate before ChatGPT homologation.

None of these operational steps are performed by this PR.
