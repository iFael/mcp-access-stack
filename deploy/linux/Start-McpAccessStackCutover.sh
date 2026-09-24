#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'mcp-linux-cutover: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: Start-McpAccessStackCutover.sh
  --installation-root PATH
  --project-root PATH
  --expected-release-id ID
  --edge-runtime-root PATH
  --edge-base-url HTTPS_ORIGIN
  --connector-token-file PATH
  --owner-token-file PATH
  --policy-path PATH
  --allowed-origins VALUE
  --owner-oauth-scopes VALUE
  --mcp-session-mode stateless|stateful-experiment
  --edge-task-name NAME
  --max-concurrent-requests N
  --handover-delay-seconds N
  --execute
EOF
  exit 2
}

installation_root=
project_root=
expected_release_id=
edge_runtime_root=
edge_base_url=
connector_token_file=
owner_token_file=
policy_path=
allowed_origins=
owner_oauth_scopes=
mcp_session_mode=
edge_task_name=
max_concurrent_requests=
handover_delay_seconds=
execute=false

while (($#)); do
  case "$1" in
    --installation-root) shift; installation_root="${1:-}" ;;
    --project-root) shift; project_root="${1:-}" ;;
    --expected-release-id) shift; expected_release_id="${1:-}" ;;
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
    --execute) execute=true ;;
    *) usage ;;
  esac
  shift
done

$execute || fail 'Cutover is intentionally gated. Re-run with --execute.'
[[ "$expected_release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail 'Expected release id is invalid.'
[[ "$edge_base_url" =~ ^https://[^/?#@]+$ ]] || fail 'Edge base URL must be a credential-free HTTPS origin.'
[[ "$mcp_session_mode" == stateless || "$mcp_session_mode" == stateful-experiment ]] || fail 'Invalid MCP session mode.'
[[ "$max_concurrent_requests" =~ ^[0-9]+$ ]] || fail 'maxConcurrentRequests must be an integer.'
(( max_concurrent_requests >= 1 && max_concurrent_requests <= 64 )) || fail 'maxConcurrentRequests must be between 1 and 64.'
[[ "$handover_delay_seconds" =~ ^[0-9]+$ ]] || fail 'handoverDelaySeconds must be an integer.'
(( handover_delay_seconds >= 0 && handover_delay_seconds <= 30 )) || fail 'handoverDelaySeconds must be between 0 and 30.'

for command in jq sha256sum readlink systemd-run pwsh; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command is unavailable: $command"
done

installation_root="$(readlink -f -- "$installation_root")"
project_root="$(readlink -f -- "$project_root")"
edge_runtime_root="$(readlink -f -- "$edge_runtime_root")"
connector_token_file="$(readlink -f -- "$connector_token_file")"
owner_token_file="$(readlink -f -- "$owner_token_file")"
policy_path="$(readlink -f -- "$policy_path")"

state_root="$installation_root/state"
state_path="$state_root/lifecycle-state.v1.json"
[[ -f "$state_path" ]] || fail 'Lifecycle state is unavailable.'

active_id="$(jq -r '.active.releaseId // empty' "$state_path")"
candidate_id="$(jq -r '.candidate.releaseId // empty' "$state_path")"
candidate_sha="$(jq -r '.candidate.manifestSha256 // empty' "$state_path")"
[[ -n "$active_id" ]] || fail 'Cutover requires an active release.'
[[ "$candidate_id" == "$expected_release_id" ]] || fail 'Cutover candidate does not match expected release.'

candidate_root="$installation_root/releases/$expected_release_id"
manifest="$candidate_root/linux-release-manifest.json"
launcher="$candidate_root/deploy/linux/Start-McpEdgeConnector.sh"
broker="$candidate_root/deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1"
[[ -f "$manifest" && -x "$launcher" && -f "$broker" ]] || fail 'Candidate Linux release artifacts are incomplete.'
observed_manifest_sha="$(sha256sum "$manifest" | awk '{print $1}')"
[[ "$observed_manifest_sha" == "$candidate_sha" ]] || fail 'Candidate Linux release manifest hash mismatch.'

for file in "$connector_token_file" "$owner_token_file" "$policy_path"; do
  [[ -f "$file" ]] || fail "Required runtime file is missing: $file"
done
[[ -d "$project_root" && -d "$edge_runtime_root" ]] || fail 'Project/runtime root is unavailable.'

request_id="$(cat /proc/sys/kernel/random/uuid)"
handover_root="$state_root/linux-cutover-runs/$request_id"
request_path="$handover_root/request.json"
result_path="$handover_root/result.json"
mkdir -p "$handover_root"
chmod 700 "$handover_root"

jq -n \
  --arg requestId "$request_id" \
  --arg releaseId "$expected_release_id" \
  --arg installationRoot "$installation_root" \
  --arg projectRoot "$project_root" \
  --arg edgeRuntimeRoot "$edge_runtime_root" \
  --arg edgeBaseUrl "$edge_base_url" \
  --arg connectorTokenFile "$connector_token_file" \
  --arg ownerTokenFile "$owner_token_file" \
  --arg policyPath "$policy_path" \
  --arg allowedOrigins "$allowed_origins" \
  --arg ownerOAuthScopes "$owner_oauth_scopes" \
  --arg mcpSessionMode "$mcp_session_mode" \
  --arg edgeTaskName "$edge_task_name" \
  --argjson maxConcurrentRequests "$max_concurrent_requests" \
  --argjson handoverDelaySeconds "$handover_delay_seconds" \
  '{
    schemaVersion:1,
    requestId:$requestId,
    releaseId:$releaseId,
    installationRoot:$installationRoot,
    projectRoot:$projectRoot,
    edgeRuntimeRoot:$edgeRuntimeRoot,
    edgeBaseUrl:$edgeBaseUrl,
    connectorTokenFile:$connectorTokenFile,
    ownerTokenFile:$ownerTokenFile,
    policyPath:$policyPath,
    allowedOrigins:$allowedOrigins,
    ownerOAuthScopes:$ownerOAuthScopes,
    mcpSessionMode:$mcpSessionMode,
    edgeTaskName:$edgeTaskName,
    maxConcurrentRequests:$maxConcurrentRequests,
    handoverDelaySeconds:$handoverDelaySeconds
  }' > "$request_path"
chmod 600 "$request_path"

unit_suffix="${request_id//-/}"
transient_unit="mcp-access-stack-cutover-$unit_suffix"
systemd-run --user \
  --quiet \
  --collect \
  --unit "$transient_unit" \
  --property=Type=exec \
  --property=RuntimeMaxSec=600 \
  pwsh -NoLogo -NoProfile -NonInteractive -File "$broker" -RequestPath "$request_path" -ResultPath "$result_path"

jq -cn \
  --arg requestId "$request_id" \
  --arg releaseId "$expected_release_id" \
  --arg brokerTaskName "systemd-user:$transient_unit" \
  --arg requestPath "$request_path" \
  --arg resultPath "$result_path" \
  '{status:"started",detached:true,requestId:$requestId,releaseId:$releaseId,brokerTaskName:$brokerTaskName,requestPath:$requestPath,resultPath:$resultPath}'
