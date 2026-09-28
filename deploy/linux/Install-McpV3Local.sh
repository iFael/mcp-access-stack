#!/usr/bin/env bash
set -euo pipefail

edge_base_url=""
device_name=""
app_root="${XDG_DATA_HOME:-$HOME/.local/share}/mcp-v3"
state_root="${XDG_STATE_HOME:-$HOME/.local/state}/mcp-v3"
disable_auto_update=false

while (($#)); do
  case "$1" in
    --edge-base-url) edge_base_url="${2:-}"; shift 2 ;;
    --device-name) device_name="${2:-}"; shift 2 ;;
    --app-root) app_root="${2:-}"; shift 2 ;;
    --state-root) state_root="${2:-}"; shift 2 ;;
    --disable-auto-update) disable_auto_update=true; shift ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
package_root="$(cd -- "$script_dir/../.." && pwd -P)"
common="$package_root/deploy/unix/McpV3Local.Common.sh"
[[ -f "$common" ]] || { printf 'Missing MCP V3 Unix lifecycle common: %s\n' "$common" >&2; exit 1; }
# shellcheck source=../unix/McpV3Local.Common.sh
source "$common"

package_node="$package_root/runtime/node/node"
package_manifest="$package_root/mcp-v3-local-manifest.json"
mcp_v3_require_file "$package_node"
mcp_v3_require_file "$package_manifest"
manifest_edge_base_url="$(mcp_v3_manifest_edge_base_url "$package_node" "$package_manifest")"
if [[ -z "$edge_base_url" ]]; then
  edge_base_url="$manifest_edge_base_url"
else
  edge_base_url="$(mcp_v3_normalize_edge_origin "$edge_base_url")"
  [[ "$edge_base_url" == "$manifest_edge_base_url" ]] || {
    printf 'MCP V3 package is bound to a different Edge origin.\n' >&2
    exit 1
  }
fi
expected_platform="$(mcp_v3_host_platform linux)"
repositories_root="${MCP_V3_REPOSITORIES_ROOT:-$HOME/MCP V3/Repositórios}"

for command in git secret-tool xdg-open systemctl tar; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'MCP V3 package dependency is missing: %s\n' "$command" >&2
    printf 'Install through the MCP V3 Linux package so OS dependencies are provisioned automatically.\n' >&2
    exit 1
  }
done

install_state="$(mcp_v3_stage_install \
  "$package_root" \
  "$app_root" \
  "$state_root" \
  "$edge_base_url" \
  "$device_name" \
  "$repositories_root" \
  "$expected_platform")"
IFS='|' read -r release_id platform_id release_root current_link config_path <<<"$install_state"
companion_rel="node_modules/@vs-code-gpt/remote-mcp-gateway/dist/companion-cli.js"

user_unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$user_unit_dir"
service_path="$user_unit_dir/mcp-v3-local.service"
timer_path="$user_unit_dir/mcp-v3-local-update.timer"
update_service_path="$user_unit_dir/mcp-v3-local-update.service"

escape_systemd() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

cat >"$service_path" <<EOF
[Unit]
Description=MCP V3 local companion
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="MCP_V3_RELEASE_ROOT=$(escape_systemd "$current_link")"
Environment="MCP_V3_STATE_ROOT=$(escape_systemd "$state_root")"
Environment="MCP_V3_CONFIG_PATH=$(escape_systemd "$config_path")"
Environment="MCP_V3_REPOSITORIES_ROOT=$(escape_systemd "$repositories_root")"
ExecStart="$(escape_systemd "$current_link/runtime/node/node")" "$(escape_systemd "$current_link/$companion_rel")"
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

cat >"$update_service_path" <<EOF
[Unit]
Description=Update MCP V3 local companion
After=network-online.target

[Service]
Type=oneshot
ExecStart="$(escape_systemd "$current_link/deploy/linux/Update-McpV3Local.sh")" --app-root "$(escape_systemd "$app_root")" --state-root "$(escape_systemd "$state_root")"
EOF

cat >"$timer_path" <<'EOF'
[Unit]
Description=Daily MCP V3 local update check

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=20m

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable mcp-v3-local.service >/dev/null
if [[ "$disable_auto_update" == true ]]; then
  systemctl --user disable --now mcp-v3-local-update.timer >/dev/null 2>&1 || true
else
  systemctl --user enable --now mcp-v3-local-update.timer >/dev/null
fi
systemctl --user restart mcp-v3-local.service

RELEASE_ID="$release_id" PLATFORM_ID="$platform_id" STATE_ROOT="$state_root" \
APP_ROOT="$app_root" REPOSITORIES_ROOT="$repositories_root" \
"$release_root/runtime/node/node" - <<'NODE'
process.stdout.write(JSON.stringify({
  status: "installed",
  releaseId: process.env.RELEASE_ID,
  platform: process.env.PLATFORM_ID,
  stateRoot: process.env.STATE_ROOT,
  appRoot: process.env.APP_ROOT,
  repositoriesRoot: process.env.REPOSITORIES_ROOT,
}) + "\n");
NODE
