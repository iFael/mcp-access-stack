#!/usr/bin/env bash
set -euo pipefail
# One-time HOST-ROOT bootstrap. Never invoke via the MCP sandbox.
# Requires an independently verified release checkout and an explicit root operator.
[[ "$(id -u)" == 0 ]] || { echo "Host root is required." >&2; exit 1; }
[[ "$#" == 0 ]] || { echo "No arguments are supported." >&2; exit 2; }
source_root="/var/lib/mcp-access-stack/current"
installer_sha="aaf90ffd346b76ae65f350bf4b40137f1feb110b84cba3bd0e296d3756787bec"
module_sha="c922695d1e2c02521619e4e472c3e4fc696f51c4f6c01f78164a564ad9fd8aa3"
installer="$source_root/deploy/linux/Install-McpV3DiskAuditPolicy.sh"
module="$source_root/tooling/oracle-disk-audit.mjs"
node="/opt/mcp-access-stack/node-v26.10.0-linux-x64/bin/node"
check_hash() {
  [[ -f "$1" && ! -L "$1" ]] || { echo "Untrusted source file" >&2; exit 1; }
  read -r observed _ < <(sha256sum -- "$1")
  [[ "$observed" == "$2" ]] || { echo "Source hash mismatch" >&2; exit 1; }
}
check_hash "$installer" "$installer_sha"
check_hash "$module" "$module_sha"
[[ -x "$node" && ! -L "$node" ]] || { echo "Approved Node runtime missing" >&2; exit 1; }
command -v visudo >/dev/null || exit 1
id mcp-access-stack >/dev/null
install -d -o root -g root -m 0755 /usr/local/libexec
stage_installer="$(mktemp /usr/local/libexec/.mcp-v3-audit-installer.XXXXXX)"
stage_wrapper="$(mktemp /usr/local/libexec/.mcp-v3-audit-provision.XXXXXX)"
stage_policy="$(mktemp /etc/sudoers.d/.mcp-v3-audit-provision.XXXXXX)"
trap 'rm -f -- "$stage_installer" "$stage_wrapper" "$stage_policy"' EXIT
install -o root -g root -m 0644 "$installer" "$stage_installer"
check_hash "$stage_installer" "$installer_sha"
printf '#!/bin/sh\nexec /bin/bash /usr/local/libexec/mcp-v3-root-disk-installer.sh /var/lib/mcp-access-stack/current/tooling/oracle-disk-audit.mjs /opt/mcp-access-stack/node-v26.10.0-linux-x64/bin/node %s\n' "$module_sha" > "$stage_wrapper"
chown root:root "$stage_wrapper"
chmod 0755 "$stage_wrapper"
printf '# MCP V3 fixed-scope Oracle disk-audit provisioner. No arguments or general sudo access.\nmcp-access-stack ALL=(root) NOPASSWD: /usr/local/libexec/mcp-v3-root-provision-disk-audit ""\n' > "$stage_policy"
chown root:root "$stage_policy"
chmod 0440 "$stage_policy"
visudo -cf "$stage_policy" >/dev/null
mv -f -- "$stage_installer" /usr/local/libexec/mcp-v3-root-disk-installer.sh
mv -f -- "$stage_wrapper" /usr/local/libexec/mcp-v3-root-provision-disk-audit
mv -f -- "$stage_policy" /etc/sudoers.d/mcp-v3-root-provision-disk-audit
trap - EXIT
visudo -cf /etc/sudoers.d/mcp-v3-root-provision-disk-audit >/dev/null
printf '{"status":"bootstrap_installed","scope":"oracle-disk-audit"}\n'
