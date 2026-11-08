#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || fail "Root privileges are required to install the disk-audit capability."
[[ "$#" -eq 3 ]] || fail "Usage: installer SOURCE_MODULE NODE_EXECUTABLE EXPECTED_SHA256"
source_module="$1"
node_executable="$2"
expected_sha="$3"
[[ "$source_module" = /* && -f "$source_module" && ! -L "$source_module" ]] || fail "Source must be a physical absolute file."
[[ "$node_executable" = /opt/mcp-access-stack/*/bin/node && -x "$node_executable" && ! -L "$node_executable" ]] || fail "Node must be the approved host runtime."
[[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || fail "Expected source SHA-256 is required."
actual_sha="$(sha256sum -- "$source_module")"
[[ "${actual_sha%% *}" = "$expected_sha" ]] || fail "Source SHA-256 does not match."
command -v visudo >/dev/null || fail "visudo is required."
[[ -x /usr/bin/sudo ]] || fail "sudo is required."
id mcp-access-stack >/dev/null || fail "Missing service user."

# Never execute interpreter or source that the service account can rewrite.
for path_part in /opt /opt/mcp-access-stack "$(dirname "$(dirname "$node_executable")")" "$(dirname "$node_executable")" "$node_executable"; do
  [[ ! -L "$path_part" ]] || fail "Runtime path must not contain symlinks."
  mode="$(stat -c %a -- "$path_part")"
  [[ $((8#$mode & 8#022)) -eq 0 ]] || fail "Runtime is group/world writable."
  owner="$(stat -c %U -- "$path_part")"
  [[ "$owner" != mcp-access-stack ]] || fail "Runtime is writable by the service owner."
done

install -d -o root -g root -m 0755 /usr/local/libexec
stage_module="$(mktemp /usr/local/libexec/.mcp-v3-disk-audit-module.XXXXXX)"
stage_wrapper="$(mktemp /usr/local/libexec/.mcp-v3-disk-audit-launcher.XXXXXX)"
stage_policy="$(mktemp /etc/sudoers.d/.mcp-v3-disk-audit.XXXXXX)"
cleanup() { rm -f -- "$stage_module" "$stage_wrapper" "$stage_policy"; }
trap cleanup EXIT

install -o root -g root -m 0644 -- "$source_module" "$stage_module"
staged_sha="$(sha256sum -- "$stage_module")"
[[ "${staged_sha%% *}" = "$expected_sha" ]] || fail "Staged module SHA-256 does not match."
printf '#!/bin/sh\nexec "%s" /usr/local/libexec/mcp-v3-disk-audit.mjs --privileged-stdin\n' "$node_executable" > "$stage_wrapper"
chown root:root "$stage_wrapper"
chmod 0755 "$stage_wrapper"
printf '# Restricted read-only audit, fixed executable and NO arguments.\nmcp-access-stack ALL=(root) NOPASSWD: /usr/local/libexec/mcp-v3-disk-audit ""\n' > "$stage_policy"
chown root:root "$stage_policy"
chmod 0440 "$stage_policy"
visudo -cf "$stage_policy" >/dev/null
mv -f -- "$stage_module" /usr/local/libexec/mcp-v3-disk-audit.mjs
mv -f -- "$stage_wrapper" /usr/local/libexec/mcp-v3-disk-audit
mv -f -- "$stage_policy" /etc/sudoers.d/mcp-v3-disk-audit
trap - EXIT
visudo -cf /etc/sudoers.d/mcp-v3-disk-audit >/dev/null
# The root-owned completion marker is written LAST; partial installs never read as ready.
marker_stage="$(mktemp /usr/local/libexec/.mcp-v3-disk-audit-ready.XXXXXX)"
trap 'rm -f -- "$marker_stage"' EXIT
printf '%s\n' "$expected_sha" > "$marker_stage"
chown root:root "$marker_stage"
chmod 0644 "$marker_stage"
mv -f -- "$marker_stage" /usr/local/libexec/mcp-v3-disk-audit.ready
trap - EXIT
printf '{"status":"installed","capability":"disk-audit-read-only"}\n'
