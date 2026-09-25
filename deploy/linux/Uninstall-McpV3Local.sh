#!/usr/bin/env bash
set -euo pipefail

app_root="${XDG_DATA_HOME:-$HOME/.local/share}/mcp-v3"
state_root="${XDG_STATE_HOME:-$HOME/.local/state}/mcp-v3"
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

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
common="$script_dir/../unix/McpV3Local.Common.sh"
[[ -f "$common" ]] || {
  current_common="$app_root/current/deploy/unix/McpV3Local.Common.sh"
  [[ -f "$current_common" ]] || { printf 'MCP V3 Unix lifecycle common is missing.\n' >&2; exit 1; }
  common="$current_common"
}
# shellcheck source=../unix/McpV3Local.Common.sh
source "$common"

systemctl --user disable --now mcp-v3-local.service >/dev/null 2>&1 || true
systemctl --user disable --now mcp-v3-local-update.timer >/dev/null 2>&1 || true
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
rm -f -- \
  "$unit_dir/mcp-v3-local.service" \
  "$unit_dir/mcp-v3-local-update.service" \
  "$unit_dir/mcp-v3-local-update.timer"
systemctl --user daemon-reload >/dev/null 2>&1 || true

credential_status="config-unavailable"
config="$state_root/config.json"
node="$app_root/current/runtime/node/node"
if [[ -f "$config" && -x "$node" ]] && command -v secret-tool >/dev/null 2>&1; then
  account_id="$(mcp_v3_oauth_account_id "$node" "$config")"
  if secret-tool clear service mcp-v3 account "$account_id" >/dev/null 2>&1; then
    credential_status="removed"
  else
    credential_status="absent-or-unavailable"
  fi
fi

mcp_v3_assert_safe_removal "$app_root" \
  "${XDG_DATA_HOME:-$HOME/.local/share}" "$HOME/.local" "$HOME"
mcp_v3_assert_safe_removal "$state_root" \
  "${XDG_STATE_HOME:-$HOME/.local/state}" "$HOME/.local" "$HOME"
rm -rf -- "$app_root" "$state_root"

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
