#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'mcp-linux-install: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: Install-McpAccessStack.sh
  --source-root PATH
  --project-root PATH
  --installation-root PATH
  --release-id ID
  --edge-runtime-root PATH
  --edge-base-url HTTPS_ORIGIN
  --connector-token-file PATH
  --owner-token-file PATH
  --policy-path PATH
  --allowed-origins VALUE
  --owner-oauth-scopes VALUE
  --mcp-session-mode stateless|stateful-experiment
  [--edge-task-name NAME]
  [--max-concurrent-requests N]
  [--handover-delay-seconds N]
  [--activate]
  --execute
EOF
  exit 2
}

source_root=""
project_root=""
installation_root=""
release_id=""
edge_runtime_root=""
edge_base_url=""
connector_token_file=""
owner_token_file=""
policy_path=""
allowed_origins=""
owner_oauth_scopes=""
mcp_session_mode=""
edge_task_name="mcp-access-stack-edge-connector.service"
max_concurrent_requests=8
handover_delay_seconds=2
activate=false
execute=false

while (($#)); do
  case "$1" in
    --source-root) shift; source_root="${1:-}" ;;
    --project-root) shift; project_root="${1:-}" ;;
    --installation-root) shift; installation_root="${1:-}" ;;
    --release-id) shift; release_id="${1:-}" ;;
    --edge-runtime-root) shift; edge_runtime_root="${1:-}" ;;
    --edge-base-url) shift; edge_base_url="${1:-}" ;;
    --connector-token-file) shift; connector_token_file="${1:-}" ;;
    --owner-token-file) shift; owner_token_file="${1:-}" ;;
    --policy-path) shift; policy_path="${1:-}" ;;
    --allowed-origins) shift; allowed_origins="${1:-}" ;;
    --owner-oauth-scopes) shift; owner_oauth_scopes="${1:-}" ;;
    --mcp-session-mode) shift; mcp_session_mode="${1:-}" ;;
    --edge-task-name) shift; edge_task_name="${1:-}" ;;
    --max-concurrent-requests) shift; max_concurrent_requests="${1:-}" ;;
    --handover-delay-seconds) shift; handover_delay_seconds="${1:-}" ;;
    --activate) activate=true ;;
    --execute) execute=true ;;
    *) usage ;;
  esac
  shift
done

$execute || fail 'Installation is intentionally gated. Re-run with --execute.'
[[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail 'Release id is invalid.'
[[ "$edge_base_url" =~ ^https://[^/?#@]+$ ]] || fail 'Edge base URL must be a credential-free HTTPS origin.'
[[ "$mcp_session_mode" == stateless || "$mcp_session_mode" == stateful-experiment ]] || fail 'Invalid MCP session mode.'
[[ "$max_concurrent_requests" =~ ^[0-9]+$ ]] || fail 'maxConcurrentRequests must be an integer.'
(( max_concurrent_requests >= 1 && max_concurrent_requests <= 64 )) || fail 'maxConcurrentRequests must be between 1 and 64.'
[[ "$handover_delay_seconds" =~ ^[0-9]+$ ]] || fail 'handoverDelaySeconds must be an integer.'
(( handover_delay_seconds >= 0 && handover_delay_seconds <= 30 )) || fail 'handoverDelaySeconds must be between 0 and 30.'
[[ -n "$edge_task_name" ]] || fail 'Edge task/service name is required.'

for command in git node sha256sum jq tar systemctl readlink mktemp; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command is unavailable: $command"
done

for directory in "$source_root" "$project_root" "$installation_root" "$edge_runtime_root"; do
  [[ -d "$directory" ]] || fail "Required directory is missing: $directory"
done
for file in "$connector_token_file" "$owner_token_file" "$policy_path"; do
  [[ -f "$file" ]] || fail "Required runtime file is missing: $file"
done

source_root="$(readlink -f -- "$source_root")"
project_root="$(readlink -f -- "$project_root")"
installation_root="$(readlink -f -- "$installation_root")"
edge_runtime_root="$(readlink -f -- "$edge_runtime_root")"
connector_token_file="$(readlink -f -- "$connector_token_file")"
owner_token_file="$(readlink -f -- "$owner_token_file")"
policy_path="$(readlink -f -- "$policy_path")"

[[ "$(git -C "$source_root" status --porcelain=v1 --untracked-files=all)" == "" ]] ||
  fail 'Initial Linux release requires a clean source checkout.'
source_commit="$(git -C "$source_root" rev-parse HEAD)"
[[ "$source_commit" =~ ^[a-f0-9]{40}$ ]] || fail 'Unable to resolve source commit.'

required_files=(
  "services/mcp-gateway/dist/edge-connector-cli.js"
  "services/workspace-agent/dist/index.js"
  "packages/mcp-core/dist/index.js"
  "packages/edge-protocol/dist/index.js"
  "deploy/linux/Start-McpEdgeConnector.sh"
  "deploy/linux/Install-McpAccessStack.sh"
  "deploy/linux/Update-McpAccessStack.sh"
  "deploy/linux/Start-McpAccessStackCutover.sh"
  "deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1"
  "deploy/linux/mcp-access-stack-edge-connector.service"
)
for required in "${required_files[@]}"; do
  [[ -f "$source_root/$required" ]] || fail "Built source is missing required Linux runtime file: $required"
done

state_root="$installation_root/state"
state_path="$state_root/lifecycle-state.v1.json"
releases_root="$installation_root/releases"
staging_root="$installation_root/staging"
final_root="$releases_root/$release_id"
current_path="$installation_root/current"
manifest_path="$final_root/linux-release-manifest.json"

mkdir -p "$state_root" "$releases_root" "$staging_root"
if [[ -f "$state_path" ]]; then
  existing_active="$(jq -r '.active.releaseId // empty' "$state_path")"
  [[ "$existing_active" == "$release_id" ]] ||
    fail "Lifecycle state is already initialized with active release: $existing_active"
fi

if [[ ! -d "$final_root" ]]; then
  stage_parent="$(mktemp -d "$staging_root/bootstrap-$release_id.XXXXXXXX")"
  stage_release="$stage_parent/release"
  mkdir -p "$stage_release"
  cleanup_stage=true
  cleanup() {
    if [[ "${cleanup_stage:-false}" == true && -n "${stage_parent:-}" && -d "$stage_parent" ]]; then
      rm -rf -- "$stage_parent"
    fi
  }
  trap cleanup EXIT

  tar -C "$source_root" --exclude='./.git' -cf - . | tar -C "$stage_release" -xf -

  node_version="$(node --version)"
  materialized_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
  export MCP_MANIFEST_ROOT="$stage_release"
  export MCP_MANIFEST_RELEASE_ID="$release_id"
  export MCP_MANIFEST_COMMIT="$source_commit"
  export MCP_MANIFEST_NODE_VERSION="$node_version"
  export MCP_MANIFEST_CREATED_AT="$materialized_at"
  node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.env.MCP_MANIFEST_ROOT;
const files = [
  "services/mcp-gateway/dist/edge-connector-cli.js",
  "services/workspace-agent/dist/index.js",
  "packages/mcp-core/dist/index.js",
  "packages/edge-protocol/dist/index.js",
  "deploy/linux/Start-McpEdgeConnector.sh",
  "deploy/linux/Install-McpAccessStack.sh",
  "deploy/linux/Update-McpAccessStack.sh",
  "deploy/linux/Start-McpAccessStackCutover.sh",
  "deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1",
  "deploy/linux/mcp-access-stack-edge-connector.service",
];
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const manifest = {
  schemaVersion: 1,
  platform: "linux-x64",
  releaseId: process.env.MCP_MANIFEST_RELEASE_ID,
  tag: null,
  commit: process.env.MCP_MANIFEST_COMMIT,
  nodeVersion: process.env.MCP_MANIFEST_NODE_VERSION,
  materializedAt: process.env.MCP_MANIFEST_CREATED_AT,
  artifacts: files.map((relativePath) => ({ path: relativePath, sha256: sha256(path.join(root, relativePath)) })),
};
fs.writeFileSync(path.join(root, "linux-release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
NODE

  mv -- "$stage_release" "$final_root"
  cleanup_stage=false
  rm -rf -- "$stage_parent"
  trap - EXIT
else
  [[ -f "$manifest_path" ]] || fail 'Existing initial release is missing its Linux manifest.'
  observed_commit="$(jq -r '.commit // empty' "$manifest_path")"
  [[ "$observed_commit" == "$source_commit" ]] || fail 'Existing initial release does not match source commit.'
fi

manifest_sha="$(sha256sum "$manifest_path" | awk '{print $1}')"
materialized_at="$(jq -r '.materializedAt' "$manifest_path")"
updated_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"

tmp_link="$installation_root/.current.bootstrap.$$"
ln -s "$final_root" "$tmp_link"
mv -Tf -- "$tmp_link" "$current_path"

jq -n   --arg releaseId "$release_id"   --arg manifestSha256 "$manifest_sha"   --arg materializedAt "$materialized_at"   --arg updatedAt "$updated_at"   '{version:1,active:{releaseId:$releaseId,manifestSha256:$manifestSha256,materializedAt:$materializedAt},candidate:null,previous:null,updatedAt:$updatedAt}'   > "$state_path.tmp"
mv -f -- "$state_path.tmp" "$state_path"
chmod 600 "$state_path"

jq -n   --arg taskName "$edge_task_name"   --arg projectRoot "$project_root"   --arg runtimeRoot "$edge_runtime_root"   --arg edgeBaseUrl "$edge_base_url"   --arg connectorTokenFile "$connector_token_file"   --arg ownerTokenFile "$owner_token_file"   --arg policyPath "$policy_path"   --arg allowedOrigins "$allowed_origins"   --arg ownerOAuthScopes "$owner_oauth_scopes"   --arg mcpSessionMode "$mcp_session_mode"   --argjson maxConcurrentRequests "$max_concurrent_requests"   --argjson delaySeconds "$handover_delay_seconds"   --arg updatedAt "$updated_at"   '{schemaVersion:1,taskName:$taskName,projectRoot:$projectRoot,runtimeRoot:$runtimeRoot,edgeBaseUrl:$edgeBaseUrl,connectorTokenFile:$connectorTokenFile,ownerTokenFile:$ownerTokenFile,policyPath:$policyPath,allowedOrigins:$allowedOrigins,ownerOAuthScopes:$ownerOAuthScopes,mcpSessionMode:$mcpSessionMode,maxConcurrentRequests:$maxConcurrentRequests,delaySeconds:$delaySeconds,browserEnabled:false,browserWorkerUrl:null,browserWorkerTokenFile:null,updatedAt:$updatedAt}'   > "$state_root/edge-task-config.v1.json.tmp"
mv -f -- "$state_root/edge-task-config.v1.json.tmp" "$state_root/edge-task-config.v1.json"
chmod 600 "$state_root/edge-task-config.v1.json"

env_path="$installation_root/edge-connector.env"
cat > "$env_path.tmp" <<EOF
VS_CODE_GPT_STACK_ROOT=$project_root
MCP_RELEASE_ROOT=$installation_root/current
MCP_ACCESS_STACK_RUNTIME_ROOT=$edge_runtime_root
MCP_ACCESS_STACK_INSTALLATION_ROOT=$installation_root
MCP_EDGE_BASE_URL=$edge_base_url
MCP_CONNECTOR_TOKEN_FILE=$connector_token_file
MCP_OWNER_TOKEN_FILE=$owner_token_file
VS_CODE_GPT_POLICY_PATH=$policy_path
MCP_NODE_BINARY=/usr/local/bin/node
MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS=$max_concurrent_requests
MCP_SESSION_MODE=$mcp_session_mode
OWNER_OAUTH_SCOPES=$owner_oauth_scopes
ALLOWED_ORIGINS=$allowed_origins
EOF
mv -f -- "$env_path.tmp" "$env_path"
chmod 600 "$env_path"

user_unit_root="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$user_unit_root"
cp -- "$final_root/deploy/linux/mcp-access-stack-edge-connector.service" "$user_unit_root/$edge_task_name"
chmod 644 "$user_unit_root/$edge_task_name"
systemctl --user daemon-reload
systemctl --user enable "$edge_task_name" >/dev/null

if $activate; then
  systemctl --user restart "$edge_task_name"
fi

jq -nc   --arg releaseId "$release_id"   --arg manifestSha256 "$manifest_sha"   --arg service "$edge_task_name"   --argjson activated "$activate"   '{status:"installed",releaseId:$releaseId,manifestSha256:$manifestSha256,service:$service,activated:$activated}'
