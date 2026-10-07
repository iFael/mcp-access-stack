#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || fail "Install-McpV3ServiceControlPolicy.sh must run as root."

source_path="${1:-}"
[[ -n "$source_path" ]] || fail "Provide the path to mcp-v3-service-control.sudoers."
[[ -f "$source_path" && ! -L "$source_path" ]] || fail "Sudoers source must be a regular file."

command -v visudo >/dev/null 2>&1 || fail "visudo is required."
[[ -x /usr/bin/systemctl ]] || fail "/usr/bin/systemctl is required."
[[ -x /usr/bin/sudo ]] || fail "/usr/bin/sudo is required."
id mcp-access-stack >/dev/null 2>&1 || fail "mcp-access-stack service user does not exist."

target="/etc/sudoers.d/mcp-v3-service-control"
stage="$(mktemp /etc/sudoers.d/.mcp-v3-service-control.XXXXXX)"
cleanup() {
  rm -f -- "$stage"
}
trap cleanup EXIT

install -o root -g root -m 0440 -- "$source_path" "$stage"
visudo -cf "$stage" >/dev/null
mv -f -- "$stage" "$target"
trap - EXIT

visudo -cf "$target" >/dev/null
printf '{"status":"installed","path":"%s"}\n' "$target"
