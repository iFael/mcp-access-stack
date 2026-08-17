#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
compose_file="${MCP_REMOTE_COMPOSE_FILE:-$script_dir/compose.yml}"
config_file="${MCP_REMOTE_CONFIG_FILE:-$script_dir/remote-runtime.env}"

if [[ ! -f "$config_file" ]]; then
  echo "Remote runtime config is missing: $config_file" >&2
  exit 2
fi

override_gateway_image="${MCP_GATEWAY_IMAGE:-}"
override_browser_image="${MCP_BROWSER_WORKER_IMAGE:-}"
override_proxy_image="${MCP_PROXY_IMAGE:-}"

set -a
# shellcheck disable=SC1090
source "$config_file"
set +a

[[ -z "$override_gateway_image" ]] || MCP_GATEWAY_IMAGE="$override_gateway_image"
[[ -z "$override_browser_image" ]] || MCP_BROWSER_WORKER_IMAGE="$override_browser_image"
[[ -z "$override_proxy_image" ]] || MCP_PROXY_IMAGE="$override_proxy_image"

config_dir="$(cd -- "$(dirname -- "$config_file")" && pwd)"
resolve_config_path() {
  local value="$1"
  if [[ "$value" = /* ]]; then
    printf '%s' "$value"
  else
    printf '%s/%s' "$config_dir" "$value"
  fi
}

required=(
  MCP_GATEWAY_IMAGE
  MCP_BROWSER_WORKER_IMAGE
  MCP_PROXY_IMAGE
  MCP_GATEWAY_ENV_FILE
  MCP_BROWSER_ENV_FILE
  MCP_TUNNEL_ENV_FILE
  MCP_WORKSPACE_SSH_KEY_FILE
  MCP_WORKSPACE_KNOWN_HOSTS_FILE
  MCP_WORKSPACE_POLICY_FILE
  MCP_BROWSER_CREDENTIALS_FILE
  MCP_BROWSER_SITE_POLICIES_FILE
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Required deployment variable is missing: $name" >&2
    exit 2
  fi
done

for path_var in \
  MCP_GATEWAY_ENV_FILE \
  MCP_BROWSER_ENV_FILE \
  MCP_TUNNEL_ENV_FILE \
  MCP_WORKSPACE_SSH_KEY_FILE \
  MCP_WORKSPACE_KNOWN_HOSTS_FILE \
  MCP_WORKSPACE_POLICY_FILE \
  MCP_BROWSER_CREDENTIALS_FILE \
  MCP_BROWSER_SITE_POLICIES_FILE; do
  resolved="$(resolve_config_path "${!path_var}")"
  printf -v "$path_var" '%s' "$resolved"
  if [[ ! -f "${!path_var}" ]]; then
    echo "Required deployment file is missing: ${!path_var}" >&2
    exit 2
  fi
done

export \
  MCP_GATEWAY_IMAGE \
  MCP_BROWSER_WORKER_IMAGE \
  MCP_PROXY_IMAGE \
  MCP_GATEWAY_ENV_FILE \
  MCP_BROWSER_ENV_FILE \
  MCP_TUNNEL_ENV_FILE \
  MCP_WORKSPACE_SSH_KEY_FILE \
  MCP_WORKSPACE_KNOWN_HOSTS_FILE \
  MCP_WORKSPACE_POLICY_FILE \
  MCP_BROWSER_CREDENTIALS_FILE \
  MCP_BROWSER_SITE_POLICIES_FILE \
  MCP_PATH="${MCP_PATH:-/mcp}" \
  MCP_PATH_ALIASES="${MCP_PATH_ALIASES:-}" \
  NGROK_PRODUCTION_URL="${NGROK_PRODUCTION_URL:-}"

docker compose -f "$compose_file" config --quiet
docker compose -f "$compose_file" pull
docker compose -f "$compose_file" up -d --remove-orphans

deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  gateway_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' mcp-access-stack-remote-gateway-1 2>/dev/null || true)"
  browser_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' mcp-access-stack-remote-browser-worker-1 2>/dev/null || true)"
  if [[ "$gateway_status" == "healthy" && "$browser_status" == "healthy" ]]; then
    docker compose -f "$compose_file" ps
    exit 0
  fi
  sleep 2
done

docker compose -f "$compose_file" ps >&2
docker compose -f "$compose_file" logs --tail=100 gateway browser-worker >&2 || true
exit 1
