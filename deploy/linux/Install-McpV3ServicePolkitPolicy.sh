#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || fail "Polkit policy installation requires root."
[[ "$#" -eq 1 ]] || fail "Provide the absolute path to the versioned Polkit rule."

source_path="$1"
[[ "$source_path" = /* ]] || fail "Policy source must be absolute."
[[ -f "$source_path" && ! -L "$source_path" ]] || fail "Policy source must be a regular file, not a symlink."
[[ -d /etc/polkit-1/rules.d ]] || fail "Polkit rule directory is unavailable."
[[ -f /usr/share/polkit-1/actions/org.freedesktop.systemd1.policy ]] ||
  fail "Systemd Polkit action is unavailable."
id mcp-access-stack >/dev/null 2>&1 || fail "MCP service account is missing."

expected_sha256="1d663d06f2f76ae84cbf38ac03adf9fa63c3db311f948ae02ea60d19a01003e0"
target="/etc/polkit-1/rules.d/00-mcp-v3-service-control.rules"

verify_file() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" ]] || fail "Policy file is missing or a symlink."
  local digest
  digest="$(sha256sum -- "$file")"
  [[ "${digest%% *}" == "$expected_sha256" ]] ||
    fail "Policy SHA-256 differs from the versioned allowlist."
}

verify_file "$source_path"
if [[ -e "$target" || -L "$target" ]]; then
  verify_file "$target"
  [[ "$(stat -c '%U:%G:%a' -- "$target")" == 'root:root:644' ]] ||
    fail "Installed policy owner or mode differs from the expected value."
  printf '{"status":"already_installed","path":"%s"}\n' "$target"
  exit 0
fi

stage="$(mktemp /etc/polkit-1/rules.d/.mcp-v3-service-control.XXXXXX)"
cleanup() {
  rm -f -- "$stage"
}
trap cleanup EXIT

install -o root -g root -m 0644 -- "$source_path" "$stage"
verify_file "$stage"
[[ "$(stat -c '%U:%G:%a' -- "$stage")" == 'root:root:644' ]] ||
  fail "Staged policy owner or mode is invalid."

# Hard-link creation is atomic, cannot replace another rule and keeps staging
# filename free of the .rules suffix until a fully verified rule is ready.
ln -- "$stage" "$target" || fail "Policy target was created concurrently; stopping."
verify_file "$target"
[[ "$(stat -c '%U:%G:%a' -- "$target")" == 'root:root:644' ]] ||
  fail "Installed policy owner or mode is invalid."
printf '{"status":"installed","path":"%s"}\n' "$target"
