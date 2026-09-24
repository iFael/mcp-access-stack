#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
launcher="$root/deploy/linux/Start-McpEdgeConnector.sh"
unit="$root/deploy/linux/mcp-access-stack-edge-connector.service"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

project="$tmp/project"
release="$tmp/release"
runtime="$tmp/runtime"
secrets="$tmp/secrets"
mkdir -p "$project" "$release/services/mcp-gateway/dist" "$runtime" "$secrets"
printf '// fixture\n' > "$release/services/mcp-gateway/dist/edge-connector-cli.js"
printf '{}\n' > "$tmp/policy.json"
printf '%s' 'cccccccccccccccccccccccccccccccc' > "$secrets/connector-token"
printf '%s' 'oooooooooooooooo' > "$secrets/owner-token"
chmod 600 "$secrets/connector-token" "$secrets/owner-token"

fake_node="$tmp/node"
cat > "$fake_node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-p" && "${2:-}" == "process.versions.node" ]]; then
  printf '26.0.0\n'
  exit 0
fi
printf 'fake node should not execute the connector in validate-only mode\n' >&2
exit 99
EOF
chmod +x "$fake_node"

export VS_CODE_GPT_STACK_ROOT="$project"
export MCP_RELEASE_ROOT="$release"
export MCP_ACCESS_STACK_RUNTIME_ROOT="$runtime"
export MCP_EDGE_BASE_URL='https://mcp-access-stack.example.workers.dev'
export MCP_CONNECTOR_TOKEN_FILE="$secrets/connector-token"
export MCP_OWNER_TOKEN_FILE="$secrets/owner-token"
export VS_CODE_GPT_POLICY_PATH="$tmp/policy.json"
export MCP_NODE_BINARY="$fake_node"
export MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS=8
export MCP_SESSION_MODE=stateless

output="$(bash "$launcher" --from-environment --validate-only)"
grep -Fq 'status=validated' <<<"$output"
grep -Fq "releaseRoot=$release" <<<"$output"
grep -Fq 'nodeVersion=26.0.0' <<<"$output"
grep -Fq 'mcpSessionMode=stateless' <<<"$output"

chmod 640 "$secrets/owner-token"
if bash "$launcher" --from-environment --validate-only >/dev/null 2>&1; then
  echo 'expected group-readable owner token to be rejected' >&2
  exit 1
fi
chmod 600 "$secrets/owner-token"

export MCP_EDGE_BASE_URL='http://example.invalid'
if bash "$launcher" --from-environment --validate-only >/dev/null 2>&1; then
  echo 'expected non-HTTPS Edge origin to be rejected' >&2
  exit 1
fi
export MCP_EDGE_BASE_URL='https://mcp-access-stack.example.workers.dev'

bash -n "$launcher"
bash -n "$root/deploy/linux/Install-McpAccessStack.sh"
bash -n "$root/deploy/linux/Update-McpAccessStack.sh"
bash -n "$root/deploy/linux/Start-McpAccessStackCutover.sh"
if command -v pwsh >/dev/null 2>&1; then
  pwsh -NoLogo -NoProfile -NonInteractive -Command '& { $tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 } }' "$root/deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1"
fi
grep -Fq 'Invoke-McpAccessStackCutoverBroker.ps1' "$root/deploy/linux/Start-McpAccessStackCutover.sh"
grep -Fq 'systemd-run --user' "$root/deploy/linux/Start-McpAccessStackCutover.sh"
grep -Fq 'ExecStart=/var/lib/mcp-access-stack/current/deploy/linux/Start-McpEdgeConnector.sh --from-environment' "$unit"
grep -Fq 'Restart=always' "$unit"
grep -Fq 'WantedBy=default.target' "$unit"
unit_fixture="$tmp/mcp-access-stack-edge-connector.service"
cp "$unit" "$unit_fixture"
sed -i "s#^WorkingDirectory=.*#WorkingDirectory=$project#" "$unit_fixture"
sed -i 's#^ExecStart=.*#ExecStart=/bin/true#' "$unit_fixture"
chmod 644 "$unit_fixture"
systemd-analyze verify "$unit_fixture" >/dev/null 2>&1 || {
  echo 'systemd unit validation failed' >&2
  systemd-analyze verify "$unit_fixture" >&2 || true
  exit 1
}

printf 'LINUX_EDGE_CONNECTOR_RUNTIME_TEST=PASS\n'
