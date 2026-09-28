#!/usr/bin/env bash
# Shared MCP V3 local-companion lifecycle primitives for Linux and macOS.
# Sourced by platform adapters; keep compatible with macOS Bash 3.2.

mcp_v3_die() {
  printf '%s\n' "$*" >&2
  return 1
}

mcp_v3_require_file() {
  [[ -f "$1" ]] || mcp_v3_die "Required MCP V3 package file is missing: $1"
}

mcp_v3_validate_repository() {
  [[ "$1" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
    mcp_v3_die "Invalid MCP V3 repository: $1"
}

mcp_v3_normalize_edge_origin() {
  local value="$1"
  [[ "$value" =~ ^https://[^/?#]+/?$ ]] ||
    mcp_v3_die "MCP V3 requires a credential-free HTTPS origin."
  printf '%s/\n' "${value%/}"
}

mcp_v3_host_platform() {
  local os_name="$1"
  local architecture
  architecture="$(uname -m)"
  case "$architecture" in
    x86_64) architecture="x64" ;;
    aarch64|arm64) architecture="arm64" ;;
    *) mcp_v3_die "Unsupported MCP V3 architecture: $architecture"; return 1 ;;
  esac
  case "$os_name" in
    linux|darwin) printf '%s-%s\n' "$os_name" "$architecture" ;;
    *) mcp_v3_die "Unsupported MCP V3 Unix platform: $os_name"; return 1 ;;
  esac
}

mcp_v3_package_identity() {
  local node="$1"
  local manifest="$2"
  local expected_platform="$3"
  "$node" - "$manifest" "$expected_platform" <<'NODE'
const fs = require("node:fs");
const manifestPath = process.argv[2];
const expected = process.argv[3];
const value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (
  value.schemaVersion !== 1 ||
  value.product !== "MCP V3" ||
  value.runtime !== "local-companion" ||
  value.platform !== expected ||
  typeof value.releaseId !== "string" ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.releaseId)
) process.exit(2);
process.stdout.write(value.releaseId + "|" + value.platform);
NODE
}

mcp_v3_manifest_edge_base_url() {
  local node="$1"
  local manifest="$2"
  "$node" - "$manifest" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (typeof value.edgeBaseUrl !== "string") process.exit(2);
let url;
try {
  url = new URL(value.edgeBaseUrl);
} catch {
  process.exit(3);
}
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.pathname !== "/" ||
  url.search ||
  url.hash
) process.exit(4);
process.stdout.write(url.href);
NODE
}

mcp_v3_verify_package_manifest() {
  local node="$1"
  local package_root="$2"
  local manifest="$3"
  local verifier="$package_root/tooling/release/Verify-McpV3LocalPackage.mjs"
  mcp_v3_require_file "$verifier" || return 1
  "$node" "$verifier" "$package_root" "$manifest" >/dev/null
}

mcp_v3_manifests_equal() {
  local node="$1"
  local left="$2"
  local right="$3"
  "$node" - "$left" "$right" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const digest = (file) => crypto.createHash("sha256")
  .update(fs.readFileSync(file))
  .digest("hex");
if (digest(process.argv[2]) !== digest(process.argv[3])) process.exit(1);
NODE
}

mcp_v3_assert_child_path() {
  local node="$1"
  local parent="$2"
  local child="$3"
  "$node" - "$parent" "$child" <<'NODE'
const path = require("node:path");
const parent = path.resolve(process.argv[2]);
const child = path.resolve(process.argv[3]);
if (child === parent || !child.startsWith(parent + path.sep)) process.exit(2);
NODE
}

mcp_v3_stage_install() {
  local package_root="$1"
  local app_root="$2"
  local state_root="$3"
  local edge_base_url="$4"
  local device_name="$5"
  local repositories_root="$6"
  local expected_platform="$7"

  local node="$package_root/runtime/node/node"
  local manifest="$package_root/mcp-v3-local-manifest.json"
  local companion_rel="node_modules/@vs-code-gpt/remote-mcp-gateway/dist/companion-cli.js"
  mcp_v3_require_file "$node" || return 1
  mcp_v3_require_file "$manifest" || return 1
  mcp_v3_require_file "$package_root/$companion_rel" || return 1

  local identity release_id platform_id
  identity="$(mcp_v3_package_identity "$node" "$manifest" "$expected_platform")" || return 1
  release_id="${identity%%|*}"
  platform_id="${identity#*|}"

  mkdir -p "$app_root/releases" "$state_root" "$repositories_root" || return 1
  local release_root="$app_root/releases/$release_id"
  local current_link="$app_root/current"

  if [[ "$package_root" != "$release_root" ]]; then
    mcp_v3_assert_child_path "$node" "$app_root/releases" "$release_root" || return 1
    if [[ -e "$release_root" ]]; then
      local installed_manifest="$release_root/mcp-v3-local-manifest.json"
      mcp_v3_require_file "$installed_manifest" || return 1
      if ! mcp_v3_manifests_equal "$node" "$manifest" "$installed_manifest"; then
        mcp_v3_die "MCP V3 releaseId already exists with different immutable content: $release_id"
        return 1
      fi
      mcp_v3_require_file "$release_root/runtime/node/node" || return 1
      mcp_v3_require_file "$release_root/$companion_rel" || return 1
    else
      mcp_v3_verify_package_manifest "$node" "$package_root" "$manifest" || return 1
      local staging="$app_root/releases/.staging-$release_id-$$"
      mcp_v3_assert_child_path "$node" "$app_root/releases" "$staging" || return 1
      rm -rf -- "$staging"
      if ! "$node" - "$package_root" "$staging" <<'NODE'
const fs = require("node:fs");
const source = process.argv[2];
const target = process.argv[3];
fs.cpSync(source, target, {
  recursive: true,
  force: true,
  errorOnExist: false,
  preserveTimestamps: true,
});
NODE
      then
        rm -rf -- "$staging"
        mcp_v3_die "MCP V3 failed to stage immutable release: $release_id"
        return 1
      fi
      if ! mv -- "$staging" "$release_root"; then
        rm -rf -- "$staging"
        mcp_v3_die "MCP V3 failed to activate staged release directory: $release_id"
        return 1
      fi
    fi
  fi

  "$release_root/runtime/node/node" --version >/dev/null || return 1
  mcp_v3_require_file "$release_root/$companion_rel" || return 1
  ln -sfn -- "$release_root" "$current_link" || return 1

  local config_path="$state_root/config.json"
  local tmp_config="$config_path.tmp.$$"
  if ! EDGE_BASE_URL="$edge_base_url" DEVICE_NAME="$device_name" \
    "$release_root/runtime/node/node" - "$tmp_config" <<'NODE'
const fs = require("node:fs");
const out = process.argv[2];
const value = { version: 1, edgeBaseUrl: process.env.EDGE_BASE_URL };
if (process.env.DEVICE_NAME) value.displayName = process.env.DEVICE_NAME;
fs.writeFileSync(out, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
NODE
  then
    rm -f -- "$tmp_config"
    mcp_v3_die "MCP V3 failed to write local runtime configuration."
    return 1
  fi
  mv -f -- "$tmp_config" "$config_path" || return 1
  chmod 600 "$config_path" || return 1

  printf '%s|%s|%s|%s|%s\n' \
    "$release_id" "$platform_id" "$release_root" "$current_link" "$config_path"
}

mcp_v3_manifest_release_id() {
  local node="$1"
  local manifest="$2"
  "$node" -e \
    'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(typeof m.releaseId!=="string")process.exit(2);process.stdout.write(m.releaseId);' \
    "$manifest"
}

mcp_v3_config_value() {
  local node="$1"
  local config="$2"
  local key="$3"
  "$node" - "$config" "$key" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const result = value[process.argv[3]];
process.stdout.write(typeof result === "string" ? result : "");
NODE
}

mcp_v3_oauth_account_id() {
  local node="$1"
  local config="$2"
  "$node" - "$config" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const origin = new URL(config.edgeBaseUrl).origin;
process.stdout.write(
  "oauth-" + crypto.createHash("sha256").update(origin).digest("hex").slice(0, 24),
);
NODE
}

mcp_v3_resolve_release_tag() {
  local node="$1"
  local repository="$2"
  local requested="${3:-}"
  mcp_v3_validate_repository "$repository"
  if [[ -n "$requested" ]]; then
    [[ "$requested" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] ||
      mcp_v3_die "Invalid MCP V3 release tag: $requested"
    printf '%s\n' "$requested"
    return
  fi
  "$node" - "$repository" <<'NODE'
const repo = process.argv[2];
const response = await fetch(
  "https://api.github.com/repos/" + repo + "/releases/latest",
  { headers: {
    "user-agent": "mcp-v3-local-updater",
    "accept": "application/vnd.github+json",
  }},
);
if (!response.ok) process.exit(2);
const value = await response.json();
if (
  typeof value.tag_name !== "string" ||
  !/^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/.test(value.tag_name)
) process.exit(3);
process.stdout.write(value.tag_name);
NODE
}

mcp_v3_download_verified_asset() {
  local node="$1"
  local repository="$2"
  local tag="$3"
  local asset="$4"
  local output="$5"
  mcp_v3_validate_repository "$repository"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] ||
    mcp_v3_die "Invalid MCP V3 release tag: $tag"
  [[ "$asset" =~ ^[A-Za-z0-9._-]+\.tar\.gz$ ]] ||
    mcp_v3_die "Invalid MCP V3 release asset name: $asset"

  "$node" - "$repository" "$tag" "$asset" "$output" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const [repo, tag, asset, output] = process.argv.slice(2);
const base = "https://github.com/" + repo + "/releases/download/" + tag + "/";
const headers = { "user-agent": "mcp-v3-local-updater" };
const [assetResponse, checksumResponse] = await Promise.all([
  fetch(base + asset, { headers }),
  fetch(base + asset + ".sha256", { headers }),
]);
if (!assetResponse.ok || !checksumResponse.ok) process.exit(2);
const bytes = Buffer.from(await assetResponse.arrayBuffer());
const checksumText = (await checksumResponse.text()).trim();
const match = checksumText.match(/^([a-f0-9]{64})\s+\*?([^\s]+)$/i);
if (!match || match[2] !== asset) process.exit(3);
const actual = crypto.createHash("sha256").update(bytes).digest("hex");
if (actual.toLowerCase() !== match[1].toLowerCase()) process.exit(4);
fs.writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
NODE
}

mcp_v3_find_package_root() {
  local unpacked="$1"
  local manifest_path
  manifest_path="$(find "$unpacked" -name mcp-v3-local-manifest.json -type f -print -quit)"
  [[ -n "$manifest_path" ]] || mcp_v3_die "Downloaded MCP V3 package has no manifest."
  dirname "$manifest_path"
}

mcp_v3_assert_safe_removal() {
  local candidate="$1"
  shift
  if [[ -z "$candidate" || "$candidate" == "/" || "$candidate" == "$HOME" ]]; then
    mcp_v3_die "Refusing unsafe MCP V3 removal boundary: $candidate"
    return 1
  fi

  if [[ -L "$candidate" ]]; then
    mcp_v3_die "Refusing to remove a symlink as an MCP V3 root: $candidate"
    return 1
  fi

  local resolved="$candidate"
  if [[ -e "$candidate" ]]; then
    local parent base
    parent="$(cd -- "$(dirname -- "$candidate")" && pwd -P)"
    base="$(basename -- "$candidate")"
    resolved="$parent/$base"
  fi
  if [[ ${#resolved} -le 8 ]]; then
    mcp_v3_die "Refusing short MCP V3 removal path: $resolved"
    return 1
  fi

  local forbidden
  for forbidden in "$@"; do
    if [[ "$resolved" == "$forbidden" ]]; then
      mcp_v3_die "Refusing protected MCP V3 removal boundary: $resolved"
      return 1
    fi
  done
}
