#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'mcp-edge-connector: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: Start-McpEdgeConnector.sh --from-environment [--validate-only]

Required environment:
  VS_CODE_GPT_STACK_ROOT
  MCP_ACCESS_STACK_RUNTIME_ROOT
  MCP_EDGE_BASE_URL
  MCP_CONNECTOR_TOKEN_FILE
  MCP_OWNER_TOKEN_FILE
  VS_CODE_GPT_POLICY_PATH

Optional environment:
  MCP_RELEASE_ROOT
  MCP_NODE_BINARY
  MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS
  MCP_SESSION_MODE
  OWNER_OAUTH_SCOPES
  ALLOWED_ORIGINS
  MCP_WINDOWS_COMPANION_ENABLED
  MCP_WINDOWS_COMPANION_HOST
  MCP_WINDOWS_COMPANION_PORT
  MCP_WINDOWS_COMPANION_USERNAME
  MCP_WINDOWS_COMPANION_PRIVATE_KEY_PATH
  MCP_WINDOWS_COMPANION_KNOWN_HOSTS_PATH
  MCP_WINDOWS_COMPANION_POLICY_PATH
  MCP_WINDOWS_COMPANION_CONNECT_TIMEOUT_MS
  MCP_WINDOWS_COMPANION_BACKGROUND_STATE_DIR
EOF
  exit 2
}

from_environment=false
validate_only=false
while (($#)); do
  case "$1" in
    --from-environment) from_environment=true ;;
    --validate-only) validate_only=true ;;
    *) usage ;;
  esac
  shift
done
$from_environment || usage

require_value() {
  local name="$1"
  local value="${!name:-}"
  [[ -n "${value//[[:space:]]/}" ]] || fail "$name is required."
}

resolve_dir() {
  local value="$1"
  [[ -d "$value" ]] || fail "Directory was not found: $value"
  readlink -f -- "$value"
}

resolve_file() {
  local value="$1"
  [[ -f "$value" ]] || fail "File was not found: $value"
  readlink -f -- "$value"
}

assert_private_readable_file() {
  local path="$1"
  local name="$2"
  local max_bytes="$3"
  local resolved size mode mode_value
  resolved="$(resolve_file "$path")"
  [[ -r "$resolved" ]] || fail "$name file is not readable."
  size="$(stat -c '%s' -- "$resolved")"
  (( size > 0 && size <= max_bytes )) || fail "$name file size is invalid."
  mode="$(stat -c '%a' -- "$resolved")"
  mode_value=$((8#$mode))
  (( (mode_value & 077) == 0 )) || fail "$name file must not be readable/writable/executable by group or others."
  printf '%s' "$resolved"
}

read_token() {
  local path="$1"
  local name="$2"
  local min_length="$3"
  local token
  token="$(cat -- "$path")"
  (( ${#token} >= min_length && ${#token} <= 2048 )) || fail "$name file contains an invalid token length."
  [[ "$token" != *$'\r'* && "$token" != *$'\n'* ]] || fail "$name file contains an invalid token."
  printf '%s' "$token"
}

require_value VS_CODE_GPT_STACK_ROOT
require_value MCP_ACCESS_STACK_RUNTIME_ROOT
require_value MCP_EDGE_BASE_URL
require_value MCP_CONNECTOR_TOKEN_FILE
require_value MCP_OWNER_TOKEN_FILE
require_value VS_CODE_GPT_POLICY_PATH

project_root="$(resolve_dir "$VS_CODE_GPT_STACK_ROOT")"
release_root="$(resolve_dir "${MCP_RELEASE_ROOT:-$project_root}")"
runtime_root="$(resolve_dir "$MCP_ACCESS_STACK_RUNTIME_ROOT")"
policy_path="$(resolve_file "$VS_CODE_GPT_POLICY_PATH")"
connector_token_file="$(assert_private_readable_file "$MCP_CONNECTOR_TOKEN_FILE" 'Connector token' 4096)"
owner_token_file="$(assert_private_readable_file "$MCP_OWNER_TOKEN_FILE" 'Owner token' 4096)"

edge_rest="${MCP_EDGE_BASE_URL#https://}"
[[ "$MCP_EDGE_BASE_URL" == https://* && -n "$edge_rest" ]] || fail 'MCP_EDGE_BASE_URL must be a credential-free HTTPS origin.'
[[ "$edge_rest" != *'/'* && "$edge_rest" != *'?'* && "$edge_rest" != *'#'* && "$edge_rest" != *'@'* ]] ||
  fail 'MCP_EDGE_BASE_URL must be a credential-free HTTPS origin with no path, query or fragment.'

session_mode="${MCP_SESSION_MODE:-stateless}"
[[ "$session_mode" == 'stateless' || "$session_mode" == 'stateful-experiment' ]] ||
  fail 'MCP_SESSION_MODE must be stateless or stateful-experiment.'

max_concurrency="${MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS:-8}"
[[ "$max_concurrency" =~ ^[0-9]+$ ]] || fail 'MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS must be an integer.'
(( max_concurrency >= 1 && max_concurrency <= 64 )) ||
  fail 'MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS must be between 1 and 64.'

node_binary="${MCP_NODE_BINARY:-}"
if [[ -z "$node_binary" ]]; then
  node_binary="$(command -v node || true)"
fi
[[ -n "$node_binary" && -x "$node_binary" ]] || fail 'Node binary was not found or is not executable.'
node_binary="$(readlink -f -- "$node_binary")"
node_version="$("$node_binary" -p 'process.versions.node' 2>/dev/null || true)"
node_major="${node_version%%.*}"
[[ "$node_major" =~ ^[0-9]+$ ]] || fail 'Unable to determine Node version.'
(( node_major >= 26 )) || fail 'Node 26 or newer is required.'

edge_connector_path="$release_root/services/mcp-gateway/dist/edge-connector-cli.js"
[[ -f "$edge_connector_path" ]] || fail "Built Edge Connector was not found: $edge_connector_path"

connector_token="$(read_token "$connector_token_file" 'Connector token' 32)"
owner_token="$(read_token "$owner_token_file" 'Owner token' 16)"

allowed_origins="${ALLOWED_ORIGINS:-https://chatgpt.com,https://chat.openai.com}"
owner_oauth_scopes="${OWNER_OAUTH_SCOPES:-workspaces:read}"

windows_companion_enabled="${MCP_WINDOWS_COMPANION_ENABLED:-false}"
[[ "$windows_companion_enabled" == 'true' || "$windows_companion_enabled" == 'false' ]] ||
  fail 'MCP_WINDOWS_COMPANION_ENABLED must be true or false.'
if [[ "$windows_companion_enabled" == 'true' ]]; then
  require_value MCP_WINDOWS_COMPANION_HOST
  require_value MCP_WINDOWS_COMPANION_USERNAME
  require_value MCP_WINDOWS_COMPANION_PRIVATE_KEY_PATH
  require_value MCP_WINDOWS_COMPANION_KNOWN_HOSTS_PATH
  require_value MCP_WINDOWS_COMPANION_POLICY_PATH
  windows_companion_port="${MCP_WINDOWS_COMPANION_PORT:-22}"
  [[ "$windows_companion_port" =~ ^[0-9]+$ ]] || fail 'MCP_WINDOWS_COMPANION_PORT must be an integer.'
  (( windows_companion_port >= 1 && windows_companion_port <= 65535 )) ||
    fail 'MCP_WINDOWS_COMPANION_PORT must be between 1 and 65535.'
  windows_companion_timeout="${MCP_WINDOWS_COMPANION_CONNECT_TIMEOUT_MS:-15000}"
  [[ "$windows_companion_timeout" =~ ^[0-9]+$ ]] || fail 'MCP_WINDOWS_COMPANION_CONNECT_TIMEOUT_MS must be an integer.'
  (( windows_companion_timeout >= 1 && windows_companion_timeout <= 120000 )) ||
    fail 'MCP_WINDOWS_COMPANION_CONNECT_TIMEOUT_MS must be between 1 and 120000.'
  MCP_WINDOWS_COMPANION_PRIVATE_KEY_PATH="$(assert_private_readable_file "$MCP_WINDOWS_COMPANION_PRIVATE_KEY_PATH" 'Windows companion private key' 65536)"
  MCP_WINDOWS_COMPANION_KNOWN_HOSTS_PATH="$(assert_private_readable_file "$MCP_WINDOWS_COMPANION_KNOWN_HOSTS_PATH" 'Windows companion known_hosts' 1048576)"
  MCP_WINDOWS_COMPANION_POLICY_PATH="$(assert_private_readable_file "$MCP_WINDOWS_COMPANION_POLICY_PATH" 'Windows companion policy' 1048576)"
  export MCP_WINDOWS_COMPANION_PRIVATE_KEY_PATH MCP_WINDOWS_COMPANION_KNOWN_HOSTS_PATH MCP_WINDOWS_COMPANION_POLICY_PATH
  export MCP_WINDOWS_COMPANION_HOST MCP_WINDOWS_COMPANION_USERNAME
  export MCP_WINDOWS_COMPANION_PORT="$windows_companion_port"
  export MCP_WINDOWS_COMPANION_CONNECT_TIMEOUT_MS="$windows_companion_timeout"
  export MCP_WINDOWS_COMPANION_BACKGROUND_STATE_DIR="${MCP_WINDOWS_COMPANION_BACKGROUND_STATE_DIR:-/var/lib/mcp-access-stack/windows-companion}"
fi
export MCP_WINDOWS_COMPANION_ENABLED="$windows_companion_enabled"

if $validate_only; then
  printf 'status=validated\n'
  printf 'projectRoot=%s\n' "$project_root"
  printf 'releaseRoot=%s\n' "$release_root"
  printf 'runtimeRoot=%s\n' "$runtime_root"
  printf 'edgeOrigin=%s\n' "$MCP_EDGE_BASE_URL"
  printf 'nodePath=%s\n' "$node_binary"
  printf 'nodeVersion=%s\n' "$node_version"
  printf 'edgeConnectorPath=%s\n' "$edge_connector_path"
  printf 'mcpSessionMode=%s\n' "$session_mode"
  printf 'maxConcurrentRequests=%s\n' "$max_concurrency"
  printf 'windowsCompanionEnabled=%s\n' "$windows_companion_enabled"
  if [[ "$windows_companion_enabled" == 'true' ]]; then
    printf 'windowsCompanionHost=%s\n' "$MCP_WINDOWS_COMPANION_HOST"
    printf 'windowsCompanionPort=%s\n' "$MCP_WINDOWS_COMPANION_PORT"
  fi
  exit 0
fi

export MCP_EDGE_BASE_URL
export MCP_CONNECTOR_TOKEN_FILE="$connector_token_file"
export VS_CODE_GPT_POLICY_PATH="$policy_path"
export VS_CODE_GPT_STACK_ROOT="$project_root"
export MCP_RELEASE_ROOT="$release_root"
export MCP_ACCESS_STACK_INSTALLATION_ROOT="${MCP_ACCESS_STACK_INSTALLATION_ROOT:-/var/lib/mcp-access-stack}"
export MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS="$max_concurrency"
export MCP_SESSION_MODE="$session_mode"
export AUTH_MODE='owner'
export OWNER_TOKEN="$owner_token"
export OWNER_OAUTH_SCOPES="$owner_oauth_scopes"
export OWNER_OAUTH_STATE_PATH="$runtime_root/owner-oauth-state.json"
export ALLOWED_ORIGINS="$allowed_origins"
export BROWSER_WORKER_ENABLED='false'
unset BROWSER_WORKER_URL BROWSER_WORKER_TOKEN

# systemd owns persistent restart policy.
exec "$node_binary" "$edge_connector_path"
