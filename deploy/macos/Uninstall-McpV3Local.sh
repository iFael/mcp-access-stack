#!/usr/bin/env bash
set -euo pipefail

state_root="$HOME/Library/Application Support/MCP V3"
app_root=""
repositories_root="${MCP_V3_REPOSITORIES_ROOT:-$HOME/MCP V3/Repositórios}"
purge_repositories=false

while (($#)); do
  case "$1" in
    --app-root) app_root="${2:-}"; shift 2 ;;
    --state-root) state_root="${2:-}"; shift 2 ;;
    --repositories-root) repositories_root="${2:-}"; shift 2 ;;
    --purge-repositories) purge_repositories=true; shift ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ -n "$app_root" ]] || app_root="$state_root/App"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
common="$script_dir/../unix/McpV3Local.Common.sh"
[[ -f "$common" ]] || {
  current_common="$app_root/current/deploy/unix/McpV3Local.Common.sh"
  [[ -f "$current_common" ]] || { printf 'MCP V3 Unix lifecycle common is missing.\n' >&2; exit 1; }
  common="$current_common"
}
# shellcheck source=../unix/McpV3Local.Common.sh
source "$common"

uid="$(id -u)"
domain="gui/$uid"
launch_dir="$HOME/Library/LaunchAgents"
/bin/launchctl bootout "$domain/com.mcpv3.local" >/dev/null 2>&1 || true
/bin/launchctl bootout "$domain/com.mcpv3.local.update" >/dev/null 2>&1 || true
rm -f -- "$launch_dir/com.mcpv3.local.plist" "$launch_dir/com.mcpv3.local.update.plist"

credential_status="config-unavailable"
config="$state_root/config.json"
node="$app_root/current/runtime/node/node"
if [[ -f "$config" && -x "$node" ]]; then
  account_id="$(mcp_v3_oauth_account_id "$node" "$config")"
  service="MCP V3 OAuth $account_id"
  if /usr/bin/security delete-generic-password -a "$account_id" -s "$service" >/dev/null 2>&1; then
    credential_status="removed"
  else
    credential_status="absent-or-unavailable"
  fi
fi

mcp_v3_assert_safe_removal "$app_root" \
  "$HOME/Library/Application Support" "$HOME/Library" "$HOME"
mcp_v3_assert_safe_removal "$state_root" \
  "$HOME/Library/Application Support" "$HOME/Library" "$HOME"
if [[ "$app_root" == "$state_root/"* ]]; then
  rm -rf -- "$state_root"
else
  rm -rf -- "$app_root" "$state_root"
fi

repositories_removed=false
if [[ "$purge_repositories" == true && -e "$repositories_root" ]]; then
  mcp_v3_assert_safe_removal "$repositories_root" "$HOME"
  rm -rf -- "$repositories_root"
  repositories_removed=true
fi

printf '{"status":"uninstalled","credentialStatus":"%s","repositoriesPreserved":%s,"repositoriesRemoved":%s}\n' \
  "$credential_status" \
  "$([[ "$purge_repositories" == true ]] && echo false || echo true)" \
  "$repositories_removed"
