#!/usr/bin/env bash
set -euo pipefail

repository="iFael/mcp-access-stack"
tag=""
app_root="${XDG_DATA_HOME:-$HOME/.local/share}/mcp-v3"
state_root="${XDG_STATE_HOME:-$HOME/.local/state}/mcp-v3"

while (($#)); do
  case "$1" in
    --repository) repository="${2:-}"; shift 2 ;;
    --tag) tag="${2:-}"; shift 2 ;;
    --app-root) app_root="${2:-}"; shift 2 ;;
    --state-root) state_root="${2:-}"; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

current="$app_root/current"
common="$current/deploy/unix/McpV3Local.Common.sh"
[[ -f "$common" ]] || { printf 'MCP V3 Unix lifecycle common is missing.\n' >&2; exit 1; }
# shellcheck source=../unix/McpV3Local.Common.sh
source "$common"

node="$current/runtime/node/node"
manifest="$current/mcp-v3-local-manifest.json"
config="$state_root/config.json"
mcp_v3_require_file "$node"
mcp_v3_require_file "$manifest"
mcp_v3_require_file "$config"
command -v tar >/dev/null 2>&1 || mcp_v3_die "MCP V3 package dependency is missing: tar"

current_release="$(mcp_v3_manifest_release_id "$node" "$manifest")"
platform_id="$(mcp_v3_host_platform linux)"
asset_arch="${platform_id#linux-}"
tag="$(mcp_v3_resolve_release_tag "$node" "$repository" "$tag")"
target_release="${tag#v}"

if [[ "$target_release" == "$current_release" ]]; then
  printf '{"status":"up-to-date","releaseId":"%s"}\n' "$current_release"
  exit 0
fi

asset="$tag-linux-$asset_arch.tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mcp_v3_download_verified_asset "$node" "$repository" "$tag" "$asset" "$tmp/$asset"
mkdir -p "$tmp/unpacked"
tar -xzf "$tmp/$asset" -C "$tmp/unpacked"
package_root="$(mcp_v3_find_package_root "$tmp/unpacked")"

edge="$(mcp_v3_config_value "$node" "$config" edgeBaseUrl)"
device="$(mcp_v3_config_value "$node" "$config" displayName)"
args=(--edge-base-url "$edge" --app-root "$app_root" --state-root "$state_root")
if [[ -n "$device" ]]; then args+=(--device-name "$device"); fi
"$package_root/deploy/linux/Install-McpV3Local.sh" "${args[@]}"

printf '{"status":"updated","previousReleaseId":"%s","releaseId":"%s"}\n' \
  "$current_release" "$target_release"
