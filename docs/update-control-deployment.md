# Update Control deployment preparation

Status: configuration and service templates only. No Cloudflare Worker, Tunnel, Access application, hostname, route, or secret is provisioned by this preparation.

## GitHub Actions deployment boundary

- Workflow: `.github/workflows/update-control-deploy.yml`.
- PRs run locked dependency installation, Worker check/dry-run, Worker tests, Orchestrator build/tests, and static/systemd template validation. The PR job has no GitHub Environment and reads no secrets or variables.
- A deployment can run only for a `push` to `main` and uses the protected GitHub Environment `update-control-production`.
- The push path filter watches only the Update Control Worker and its build/runtime dependencies. It deliberately excludes the workflow file and Oracle service-preparation files, so merging this preparation PR cannot dispatch a deploy.
- Wrangler comes from `services/update-control-worker`'s locked workspace dependency (`wrangler` 4.135.0). The deploy command names only `services/update-control-worker/wrangler.jsonc`; it does not call Public release, `release.yml`, `edge-breakglass.yml`, or the Edge Worker.
- The deploy step fails before Wrangler if the GitHub Environment secret `UPDATE_CONTROL_CF_API_TOKEN` is absent or if variable `CLOUDFLARE_ACCOUNT_ID` is absent/invalid. The token is mapped to Wrangler's `CLOUDFLARE_API_TOKEN` process environment without printing it.
- Configure the GitHub Environment with main-only deployment restrictions and required reviewers before placing its token. YAML references the Environment; it cannot create or prove its external reviewer/branch protection rules.

## Configuration and secret destinations

| Name | Destination | Type / purpose |
| --- | --- | --- |
| `UPDATE_CONTROL_CF_API_TOKEN` | GitHub Environment `update-control-production` | Secret, scoped only to the Update Control Worker/account deployment permissions; never stored on Oracle or reused from Edge/Public release. |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Environment `update-control-production` | Non-secret Environment variable for the target Cloudflare account. |
| `ORACLE_ACCESS_CLIENT_ID` | Cloudflare Worker runtime secret | Access service-token client ID used by the Worker when calling the protected Oracle origin. |
| `ORACLE_ACCESS_CLIENT_SECRET` | Cloudflare Worker runtime secret | Access service-token client secret. |
| `UPDATE_CONTROL_ORCHESTRATOR_TOKEN` | Cloudflare Worker runtime secret and Oracle protected credential file | Same high-entropy bearer on both ends of the read API; generated once through a secure channel, never committed, logged, or sent in chat. |
| `MCP_OWNER_TOKEN` | Cloudflare Worker runtime secret and the owner's password manager | OAuth owner credential. It is not an Oracle secret. Real OAuth use remains blocked by the recovery/rotation gate below. |
| `ORCHESTRATOR_READ_API_URL` | Cloudflare Worker runtime variable/config | HTTPS hostname routed through Cloudflare Tunnel and Access to the Oracle loopback origin. Never point it at a public Oracle port. |
| Cloudflare Tunnel token | Oracle protected source file `/etc/mcp-access-stack/update-control/credentials/cloudflared-tunnel-token` | Separate from the Worker deploy token and Access service token; consumed through systemd credentials, never an ExecStart value. |
| Oracle read API bearer | Oracle protected source file `/etc/mcp-access-stack/update-control/credentials/orchestrator-token` | Same value as the Worker `UPDATE_CONTROL_ORCHESTRATOR_TOKEN`; systemd injects it as a credential file. |

The source credential directory is root-owned mode `0700`; each source secret file is root-owned mode `0600`. systemd `LoadCredential` provides each service a read-only per-service credential file. Ledger/artifact state is under `/var/lib/mcp-access-stack-update-control` with mode `0700`, outside immutable code releases. The dedicated Orchestrator code root is `/opt/mcp-access-stack/update-control/current`, independent of the Edge runtime release path.

## Oracle services

- `mcp-v3-oracle-read-api.service` starts the Orchestrator read API on explicit `127.0.0.1:9381`, using the durable state directory above. It uses the credential-file input added to `start:read-api`; its bearer is not a process argument or environment literal.
- `mcp-v3-update-control-cloudflared.service` runs the outbound Cloudflare Tunnel connector with `--token-file` pointing to systemd's protected credential directory. It has no inbound listener and uses a separate DynamicUser from the API.
- Both units have bounded restart behavior and systemd hardening. Missing credentials or binaries fail closed; the units are versioned but are not installed, enabled, or started in this change.
- Do not create a firewall rule or bind the Oracle API to a public/interface address. Tunnel/Access hostname and service-auth policy require a later separately authorized provisioning step.

## OAuth recovery/rotation gate — unresolved

The Update Control Durable Object is pinned to one ID (`update-control-auth-v1`) and stores the owner credential verifier/signing material, registered OAuth clients, and token state. `MCP_OWNER_TOKEN` seeds the stored owner credential material when identity is first initialized; after that, changing the Worker secret alone does not rotate the persisted credential. The shared `EdgeOwnerOAuth` exposes `rotateOwnerPassword`/`recoverAccess`, but the Update Control Worker has no route or typed operation that invokes them.

No recovery route or generic admin endpoint is added here. Before the first real OAuth authorization/tool use, choose and implement a reviewed recovery model. Candidate designs:

1. **Controlled state-generation reset (recommended for the current single-owner Update Control):** change the pinned OAuth Durable Object identity in a reviewed deployment and set a newly generated `MCP_OWNER_TOKEN` in the Worker runtime. This deliberately invalidates stored OAuth clients/tokens and requires clients to re-register/authorize. No public recovery route or second controller is added. Define retention/cleanup of the dormant prior DO and test rollback behavior before adopting it.
2. **Typed owner-password rotation/recovery operation:** add one narrowly scoped operation that calls the existing `recoverAccess`/`rotateOwnerPassword`, protected by an independently authenticated Cloudflare Access administrative channel and explicit audit/rate limits. It must not accept arbitrary storage keys or become a generic admin route. This preserves client registration but is a new administrative surface and needs its own threat review.

Until that gate is closed and tested, keep `MCP_OWNER_TOKEN` held in a password manager and do not register/authorize a real Update Control MCP client. The current Worker remains fail-closed when required secrets/config are missing.

## Provisioning sequence after authorization

1. Create/protect GitHub Environment `update-control-production`; restrict deployment to `main` and require review.
2. Create a dedicated Cloudflare API token for the Update Control Worker only; store it as `UPDATE_CONTROL_CF_API_TOKEN` in that GitHub Environment. Store the target account ID there as `CLOUDFLARE_ACCOUNT_ID`.
3. Create the Cloudflare Access service token and service-auth policy for the Oracle origin; store its client ID/secret only as Worker runtime secrets.
4. Create the Cloudflare Tunnel and hostname/route to `http://127.0.0.1:9381` behind Access. Store its tunnel token only in the Oracle protected file.
5. Generate a separate high-entropy `UPDATE_CONTROL_ORCHESTRATOR_TOKEN`; provision the same value in the Worker secret and Oracle credential file using a secure secret manager/admin channel.
6. Set Worker variable `ORCHESTRATOR_READ_API_URL` to the HTTPS Access-protected hostname. Provision `MCP_OWNER_TOKEN` in the Worker runtime and password manager only after the recovery gate is selected.
7. Install the versioned Oracle units and code under the independent Update Control root, then run preflight/auth-negative/auth-positive/read-only API checks before enabling real OAuth or refreshing the MCP plugin.

No step in this branch creates Cloudflare resources or starts either service.
