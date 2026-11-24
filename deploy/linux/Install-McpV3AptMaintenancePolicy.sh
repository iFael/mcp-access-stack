#!/usr/bin/env bash
set -euo pipefail
# HOST ADMINISTRATOR ONLY. Run from an independently verified release.
# This installer never executes from an MCP shell or retrieves credentials.
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" == 0 && "$#" == 0 ]] || fail "Host root and no arguments required."
umask 077
source_module="/var/lib/mcp-access-stack/current/tooling/oracle-apt-maintenance.py"
expected_sha="f6120706cc31a09c41887279a1ad073511ac50545170d9b5b5ed2dbc335a26b6"
module="/usr/local/libexec/mcp-v3-apt-maintenance.py"
launcher="/usr/local/libexec/mcp-v3-apt-maintenance"
policy="/etc/sudoers.d/mcp-v3-apt-maintenance"
state="/var/lib/mcp-v3-apt-maintenance"
trusted() {
  [[ -e "$1" && ! -L "$1" && "$(stat -c %u -- "$1")" == 0 ]] || fail "Untrusted host path: $1"
  local mode
  mode="$(stat -c %a -- "$1")"
  [[ $((8#$mode & 8#022)) == 0 ]] || fail "Writable host path: $1"
}
for path in /usr /usr/bin /usr/local /var /var/lib /etc /etc/sudoers.d; do trusted "$path"; done
python="$(readlink -f /usr/bin/python3)"
[[ "$python" =~ ^/usr/bin/python3\.[0-9]+$ && -x "$python" ]] || fail "System Python is required."
trusted "$python"
[[ -f "$source_module" && ! -L "$source_module" ]] || fail "Verified release module is required."
read -r digest _ < <(sha256sum -- "$source_module")
[[ "$digest" == "$expected_sha" ]] || fail "Source digest mismatch."
id mcp-access-stack >/dev/null
command -v visudo >/dev/null || fail "visudo is required."
for executable in /usr/bin/apt-get /usr/bin/dpkg /usr/bin/dpkg-query /usr/bin/systemd-run /usr/bin/systemctl; do
  [[ -x "$executable" ]] || fail "Missing host executable: $executable"
  trusted "$executable"
done
if [[ -e /usr/local/libexec || -L /usr/local/libexec ]]; then trusted /usr/local/libexec
else install -d -o root -g root -m 0755 /usr/local/libexec; fi
if [[ -e "$state" || -L "$state" ]]; then
  trusted "$state"
  [[ -d "$state" && "$(stat -c %a -- "$state")" == 700 ]] || fail "Untrusted receipt directory."
else install -d -o root -g root -m 0700 "$state"; fi
stage_module="$(mktemp /usr/local/libexec/.mcp-v3-apt-module.XXXXXX)"
stage_launcher="$(mktemp /usr/local/libexec/.mcp-v3-apt-launcher.XXXXXX)"
stage_policy="$(mktemp /etc/sudoers.d/.mcp-v3-apt.XXXXXX)"
trap 'rm -f -- "$stage_module" "$stage_launcher" "$stage_policy"' EXIT
install -o root -g root -m 0644 -- "$source_module" "$stage_module"
read -r digest _ < <(sha256sum -- "$stage_module")
[[ "$digest" == "$expected_sha" ]] || fail "Staged digest mismatch."
cat > "$stage_launcher" <<'LAUNCHER'
#!/bin/sh
[ "$#" -eq 0 ] || exit 2
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C LC_ALL=C /usr/bin/python3 -I -B /usr/local/libexec/mcp-v3-apt-maintenance.py
LAUNCHER
chown root:root "$stage_launcher"
chmod 0755 "$stage_launcher"
printf '%s\n' '# Fixed APT maintenance only; no arguments, shell, or caller environment.' \
  'mcp-access-stack ALL=(root) NOPASSWD: NOSETENV: /usr/local/libexec/mcp-v3-apt-maintenance ""' > "$stage_policy"
chown root:root "$stage_policy"
chmod 0440 "$stage_policy"
visudo -cf "$stage_policy" >/dev/null
# Refuse to overwrite a different existing administrative capability.
for pair in "$module:$stage_module" "$launcher:$stage_launcher" "$policy:$stage_policy"; do
  target="${pair%%:*}"
  staged="${pair#*:}"
  if [[ -e "$target" || -L "$target" ]]; then
    trusted "$target"
    cmp -s -- "$target" "$staged" || fail "Different existing helper/policy requires host review."
  fi
done
mv -f -- "$stage_module" "$module"
mv -f -- "$stage_launcher" "$launcher"
mv -f -- "$stage_policy" "$policy"
visudo -cf "$policy" >/dev/null
printf '{"status":"installed","capability":"oracle-apt-maintenance"}\n'
