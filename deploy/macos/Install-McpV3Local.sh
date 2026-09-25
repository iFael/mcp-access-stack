#!/usr/bin/env bash
set -euo pipefail

edge_base_url=""
device_name=""
state_root="$HOME/Library/Application Support/MCP V3"
app_root=""
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
[[ -n "$app_root" ]] || app_root="$state_root/App"

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
expected_platform="$(mcp_v3_host_platform darwin)"
repositories_root="${MCP_V3_REPOSITORIES_ROOT:-$HOME/MCP V3/Repositórios}"

if ! /usr/bin/xcode-select -p >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  /usr/bin/xcode-select --install >/dev/null 2>&1 || true
  printf 'MCP V3 requested Apple Command Line Tools (Git). Complete the native macOS prompt; setup will continue automatically.\n' >&2
  git_deadline=$((SECONDS + 1800))
  while (( SECONDS < git_deadline )); do
    if /usr/bin/xcode-select -p >/dev/null 2>&1 &&
       command -v git >/dev/null 2>&1 &&
       git --version >/dev/null 2>&1; then
      break
    fi
    sleep 5
  done
  if ! /usr/bin/xcode-select -p >/dev/null 2>&1 ||
     ! command -v git >/dev/null 2>&1 ||
     ! git --version >/dev/null 2>&1; then
    printf 'Apple Command Line Tools (Git) was not installed within 30 minutes or the native prompt was cancelled.\n' >&2
    exit 3
  fi
fi
for command in /usr/bin/security /usr/bin/open /usr/bin/tar /bin/launchctl; do
  [[ -x "$command" ]] || { printf 'Required macOS command is missing: %s\n' "$command" >&2; exit 1; }
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

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

launch_dir="$HOME/Library/LaunchAgents"
mkdir -p "$launch_dir"
service_plist="$launch_dir/com.mcpv3.local.plist"
update_plist="$launch_dir/com.mcpv3.local.update.plist"
uid="$(id -u)"
domain="gui/$uid"

cat >"$service_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.mcpv3.local</string>
<key>ProgramArguments</key><array>
<string>$(xml_escape "$current_link/runtime/node/node")</string>
<string>$(xml_escape "$current_link/$companion_rel")</string>
</array>
<key>EnvironmentVariables</key><dict>
<key>MCP_V3_RELEASE_ROOT</key><string>$(xml_escape "$current_link")</string>
<key>MCP_V3_STATE_ROOT</key><string>$(xml_escape "$state_root")</string>
<key>MCP_V3_CONFIG_PATH</key><string>$(xml_escape "$config_path")</string>
<key>MCP_V3_REPOSITORIES_ROOT</key><string>$(xml_escape "$repositories_root")</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Interactive</string>
<key>StandardOutPath</key><string>$(xml_escape "$state_root/mcp-v3-local.stdout.log")</string>
<key>StandardErrorPath</key><string>$(xml_escape "$state_root/mcp-v3-local.stderr.log")</string>
</dict></plist>
EOF

cat >"$update_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.mcpv3.local.update</string>
<key>ProgramArguments</key><array>
<string>$(xml_escape "$current_link/deploy/macos/Update-McpV3Local.sh")</string>
<string>--app-root</string><string>$(xml_escape "$app_root")</string>
<string>--state-root</string><string>$(xml_escape "$state_root")</string>
</array>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
<key>StandardOutPath</key><string>$(xml_escape "$state_root/mcp-v3-update.stdout.log")</string>
<key>StandardErrorPath</key><string>$(xml_escape "$state_root/mcp-v3-update.stderr.log")</string>
</dict></plist>
EOF

/bin/launchctl bootout "$domain/com.mcpv3.local" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "$domain" "$service_plist"
/bin/launchctl kickstart -k "$domain/com.mcpv3.local"
if [[ "$disable_auto_update" == true ]]; then
  /bin/launchctl bootout "$domain/com.mcpv3.local.update" >/dev/null 2>&1 || true
else
  /bin/launchctl bootout "$domain/com.mcpv3.local.update" >/dev/null 2>&1 || true
  /bin/launchctl bootstrap "$domain" "$update_plist"
fi

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
