#!/usr/bin/env bash
set -euo pipefail

package_root=""
expected_edge=""

while (($#)); do
  case "$1" in
    --package-root) package_root="${2:-}"; shift 2 ;;
    --expected-edge) expected_edge="${2:-}"; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ -n "$package_root" ]] || { printf '%s\n' '--package-root is required.' >&2; exit 2; }
package_root="$(cd -- "$package_root" && pwd -P)"
common="$package_root/deploy/unix/McpV3Local.Common.sh"
[[ -f "$common" ]] || { printf 'Missing lifecycle common: %s\n' "$common" >&2; exit 1; }
# shellcheck source=McpV3Local.Common.sh
source "$common"

node="$package_root/runtime/node/node"
manifest="$package_root/mcp-v3-local-manifest.json"
mcp_v3_require_file "$node"
mcp_v3_require_file "$manifest"

case "$(uname -s)" in
  Linux) os_name=linux ;;
  Darwin) os_name=darwin ;;
  *) printf 'Unsupported lifecycle test host: %s\n' "$(uname -s)" >&2; exit 2 ;;
esac
expected_platform="$(mcp_v3_host_platform "$os_name")"
manifest_edge="$(mcp_v3_manifest_edge_base_url "$node" "$manifest")"
if [[ -n "$expected_edge" ]]; then
  expected_edge="$(mcp_v3_normalize_edge_origin "$expected_edge")"
  [[ "$manifest_edge" == "$expected_edge" ]] || {
    printf 'Manifest Edge mismatch: expected=%s actual=%s\n' "$expected_edge" "$manifest_edge" >&2
    exit 1
  }
fi

identity="$(mcp_v3_package_identity "$node" "$manifest" "$expected_platform")"
release_id="${identity%%|*}"

base="$(mktemp -d "${TMPDIR:-/tmp}/mcp-v3-unix-lifecycle.XXXXXX")"
trap 'rm -rf -- "$base"' EXIT
app_root="$base/app"
state_root="$base/state"
repos_root="$base/repos"

install="$(mcp_v3_stage_install \
  "$package_root" \
  "$app_root" \
  "$state_root" \
  "$manifest_edge" \
  "Lifecycle Test" \
  "$repos_root" \
  "$expected_platform")"
IFS='|' read -r installed_release installed_platform release_root current_link config_path <<<"$install"
[[ "$installed_release" == "$release_id" ]]
[[ "$installed_platform" == "$expected_platform" ]]
[[ -L "$current_link" ]]
[[ -f "$config_path" ]]
[[ -f "$release_root/node_modules/@vs-code-gpt/remote-mcp-gateway/dist/companion-cli.js" ]]
"$release_root/runtime/node/node" - "$config_path" "$manifest_edge" <<'NODE'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (
  config.version !== 1 ||
  config.edgeBaseUrl !== process.argv[3] ||
  config.displayName !== "Lifecycle Test"
) process.exit(2);
for (const forbidden of [
  "refreshToken",
  "accessToken",
  "connectorToken",
  "ownerToken",
]) {
  if (Object.hasOwn(config, forbidden)) process.exit(3);
}
NODE

# Reinstalling the exact immutable release must be idempotent.
mcp_v3_stage_install   "$package_root"   "$app_root"   "$state_root"   "$manifest_edge"   "Lifecycle Test"   "$repos_root"   "$expected_platform" >/dev/null

# Modified immutable content must be rejected. Corrupt the temporary
# materialization instead of making another full runtime copy.
printf '\ncorrupt-test\n' >> "$release_root/package.json"
if mcp_v3_verify_package_manifest \
  "$release_root/runtime/node/node" \
  "$release_root" \
  "$release_root/mcp-v3-local-manifest.json" >/dev/null 2>&1; then
  printf 'Corrupted MCP V3 package was incorrectly accepted.\n' >&2
  exit 1
fi

# Removal boundaries must fail closed for HOME and filesystem root.
if mcp_v3_assert_safe_removal "$HOME" >/dev/null 2>&1; then
  printf 'HOME was incorrectly accepted as a removal root.\n' >&2
  exit 1
fi
if mcp_v3_assert_safe_removal / >/dev/null 2>&1; then
  printf 'Filesystem root was incorrectly accepted as a removal root.\n' >&2
  exit 1
fi

printf '{"status":"passed","releaseId":"%s","platform":"%s","edgeBaseUrl":"%s"}\n' \
  "$release_id" "$expected_platform" "$manifest_edge"
