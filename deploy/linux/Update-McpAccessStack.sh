#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'mcp-update: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: Update-McpAccessStack.sh --repository OWNER/REPO --installation-root PATH --tag vX.Y.Z --execute
EOF
  exit 2
}

repository=""
installation_root=""
tag=""
execute=false
while (($#)); do
  case "$1" in
    --repository) shift; repository="${1:-}" ;;
    --installation-root) shift; installation_root="${1:-}" ;;
    --tag) shift; tag="${1:-}" ;;
    --execute) execute=true ;;
    *) usage ;;
  esac
  shift
done

$execute || fail 'Update preparation is intentionally gated. Re-run with --execute.'
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'Repository must be OWNER/REPO.'
[[ "$tag" =~ ^v[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail 'Tag is invalid.'
[[ -d "$installation_root" ]] || fail "Installation root was not found: $installation_root"

installation_root="$(readlink -f -- "$installation_root")"
state_root="$installation_root/state"
state_path="$state_root/lifecycle-state.v1.json"
releases_root="$installation_root/releases"
staging_root="$installation_root/staging"
home_root="$installation_root/home"
[[ -f "$state_path" ]] || fail 'Execution-node lifecycle state is not initialized.'

for command in git node npm sha256sum mktemp jq; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command was not found: $command"
done

release_id="${tag#v}"
[[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail 'Derived release id is invalid.'
active_release="$(jq -r '.active.releaseId // empty' "$state_path")"
[[ -n "$active_release" ]] || fail 'Release preparation requires an active release.'
[[ "$active_release" != "$release_id" ]] || fail 'Candidate release must differ from the active release.'

remote_url="https://github.com/$repository.git"
peeled_sha="$(git ls-remote "$remote_url" "refs/tags/$tag^{}" | awk 'NR==1 {print $1}')"
direct_sha="$(git ls-remote "$remote_url" "refs/tags/$tag" | awk 'NR==1 {print $1}')"
expected_sha="${peeled_sha:-$direct_sha}"
[[ "$expected_sha" =~ ^[a-f0-9]{40}$ ]] || fail "Unable to resolve remote tag: $tag"

mkdir -p "$releases_root" "$staging_root" "$home_root"
final_root="$releases_root/$release_id"
manifest_name="linux-release-manifest.json"
manifest_path="$final_root/$manifest_name"
already_prepared=false

if [[ -d "$final_root" ]]; then
  [[ -f "$manifest_path" ]] || fail "Existing release is missing $manifest_name: $release_id"
  observed_commit="$(jq -r '.commit // empty' "$manifest_path")"
  observed_tag="$(jq -r '.tag // empty' "$manifest_path")"
  [[ "$observed_commit" == "$expected_sha" && "$observed_tag" == "$tag" ]] ||
    fail "Existing release identity does not match requested tag: $release_id"
  already_prepared=true
else
  stage_parent="$(mktemp -d "$staging_root/$release_id.XXXXXXXX")"
  source_root="$stage_parent/source"
  cleanup_stage=true
  cleanup() {
    if [[ "${cleanup_stage:-false}" == true && -n "${stage_parent:-}" && -d "$stage_parent" ]]; then
      rm -rf -- "$stage_parent"
    fi
  }
  trap cleanup EXIT

  git init -q "$source_root"
  git -C "$source_root" remote add origin "$remote_url"
  git -C "$source_root" fetch -q --depth=1 origin "refs/tags/$tag"
  fetched_sha="$(git -C "$source_root" rev-parse 'FETCH_HEAD^{commit}')"
  [[ "$fetched_sha" == "$expected_sha" ]] || fail 'Fetched tag commit does not match remote tag resolution.'
  git -C "$source_root" checkout -q --detach "$fetched_sha"

  build_env=(
    "HOME=$home_root"
    "PATH=/usr/local/bin:/usr/bin:/bin"
    "NODE_OPTIONS=--max-old-space-size=${MCP_LINUX_BUILD_HEAP_MB:-512}"
  )
  (
    cd "$source_root"
    env "${build_env[@]}" npm ci --no-audit --no-fund
    env "${build_env[@]}" npm run build --workspace @vs-code-gpt/shared
    env "${build_env[@]}" npm run build --workspace @vs-code-gpt/local-agent
    env "${build_env[@]}" npm run build --workspace @mcp-access-stack/edge-protocol
    env "${build_env[@]}" npm run build --workspace @vs-code-gpt/remote-mcp-gateway
  )

  for required in     "services/mcp-gateway/dist/edge-connector-cli.js"     "services/workspace-agent/dist/index.js"     "packages/mcp-core/dist/index.js"     "packages/edge-protocol/dist/index.js"     "deploy/linux/Start-McpEdgeConnector.sh"     "deploy/linux/Install-McpAccessStack.sh"     "deploy/linux/Update-McpAccessStack.sh"     "deploy/linux/Start-McpAccessStackCutover.sh"     "deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1"; do
    [[ -f "$source_root/$required" ]] || fail "Built release is missing required runtime file: $required"
  done

  node_version="$(node --version)"
  created_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
  export MCP_MANIFEST_ROOT="$source_root"
  export MCP_MANIFEST_RELEASE_ID="$release_id"
  export MCP_MANIFEST_TAG="$tag"
  export MCP_MANIFEST_COMMIT="$expected_sha"
  export MCP_MANIFEST_NODE_VERSION="$node_version"
  export MCP_MANIFEST_CREATED_AT="$created_at"
  node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.env.MCP_MANIFEST_ROOT;
const files = [
  "services/mcp-gateway/dist/edge-connector-cli.js",
  "services/workspace-agent/dist/index.js",
  "packages/mcp-core/dist/index.js",
  "packages/edge-protocol/dist/index.js",
  "deploy/linux/Start-McpEdgeConnector.sh",
  "deploy/linux/Install-McpAccessStack.sh",
  "deploy/linux/Update-McpAccessStack.sh",
  "deploy/linux/Start-McpAccessStackCutover.sh",
  "deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1",
  "deploy/linux/mcp-access-stack-edge-connector.service",
];
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const manifest = {
  schemaVersion: 1,
  platform: "linux-x64",
  releaseId: process.env.MCP_MANIFEST_RELEASE_ID,
  tag: process.env.MCP_MANIFEST_TAG,
  commit: process.env.MCP_MANIFEST_COMMIT,
  nodeVersion: process.env.MCP_MANIFEST_NODE_VERSION,
  materializedAt: process.env.MCP_MANIFEST_CREATED_AT,
  artifacts: files.map((relativePath) => ({
    path: relativePath,
    sha256: sha256(path.join(root, relativePath)),
  })),
};
fs.writeFileSync(path.join(root, "linux-release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
NODE

  mv -- "$source_root" "$final_root"
  cleanup_stage=false
  rm -rf -- "$stage_parent"
  trap - EXIT
fi

manifest_sha="$(sha256sum "$manifest_path" | awk '{print $1}')"
materialized_at="$(jq -r '.materializedAt' "$manifest_path")"
tmp_state="$state_path.$$.tmp"
jq   --arg releaseId "$release_id"   --arg manifestSha256 "$manifest_sha"   --arg materializedAt "$materialized_at"   --arg updatedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"   '.candidate = {releaseId:$releaseId, manifestSha256:$manifestSha256, materializedAt:$materializedAt} | .updatedAt = $updatedAt'   "$state_path" > "$tmp_state"
mv -f -- "$tmp_state" "$state_path"

jq -nc   --arg releaseId "$release_id"   --argjson alreadyPrepared "$already_prepared"   --arg manifestSha256 "$manifest_sha"   '{downloaded:true,releaseId:$releaseId,candidatePrepared:true,alreadyPrepared:$alreadyPrepared,promoted:false,manifestSha256:$manifestSha256}'
