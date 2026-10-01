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
mkdir -p "$project" "$release/services/mcp-gateway/dist" "$release/services/browser-worker/dist" "$release/runtime/native-libs/usr/lib/x86_64-linux-gnu" "$release/runtime/native-libs/usr/share/fonts/truetype/dejavu" "$runtime" "$secrets"
printf 'fixture\t0\tamd64\tfixture\n' > "$release/runtime/native-libs/packages.v1.tsv"
printf 'font-fixture\n' > "$release/runtime/native-libs/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
printf '// fixture\n' > "$release/services/mcp-gateway/dist/edge-connector-cli.js"
printf '// browser fixture\n' > "$release/services/browser-worker/dist/server.js"
printf '{}\n' > "$tmp/policy.json"
printf '%s' 'cccccccccccccccccccccccccccccccc' > "$secrets/connector-token"

fake_node="$tmp/node"
cat > "$fake_node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-p" && "${2:-}" == "process.versions.node" ]]; then
  printf '26.0.0\n'
  exit 0
fi
if [[ "${1:-}" == *.js ]]; then
  printf 'connector-executed\n'
  exit 0
fi
printf 'unexpected fake node invocation: %s\n' "${1:-}" >&2
exit 99
EOF
chmod +x "$fake_node"
chmod 600 "$secrets/connector-token"

export VS_CODE_GPT_STACK_ROOT="$project"
export MCP_RELEASE_ROOT="$release"
export MCP_ACCESS_STACK_RUNTIME_ROOT="$runtime"
export MCP_EDGE_BASE_URL='https://mcp-access-stack.example.workers.dev'
export MCP_CONNECTOR_TOKEN_FILE="$secrets/connector-token"
export VS_CODE_GPT_POLICY_PATH="$tmp/policy.json"
export MCP_NODE_BINARY="$fake_node"
export MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS=8

output="$(bash "$launcher" --from-environment --validate-only)"
grep -Fq 'status=validated' <<<"$output"
grep -Fq "releaseRoot=$release" <<<"$output"
grep -Fq 'nodeVersion=26.0.0' <<<"$output"
grep -Fq 'browserRuntimeReady=true' <<<"$output"
grep -Fq "browserWorkerPath=$release/services/browser-worker/dist/server.js" <<<"$output"
grep -Fq 'playwrightBrowsersPath=0' <<<"$output"
grep -Fq "browserNativeLibPath=$release/runtime/native-libs/usr/lib/x86_64-linux-gnu" <<<"$output"
grep -Fq "browserNativeFontPath=$release/runtime/native-libs/usr/share/fonts" <<<"$output"
grep -Fq "fontconfigFile=$runtime/browser-fontconfig/fonts.conf" <<<"$output"

legacy_release="$tmp/legacy-release"
mkdir -p "$legacy_release/services/mcp-gateway/dist"
printf '// legacy connector fixture\n' > "$legacy_release/services/mcp-gateway/dist/edge-connector-cli.js"
export MCP_RELEASE_ROOT="$legacy_release"
legacy_output="$(bash "$launcher" --from-environment --validate-only)"
grep -Fq 'status=validated' <<<"$legacy_output"
grep -Fq 'browserRuntimeReady=false' <<<"$legacy_output"
grep -Fq 'browserRuntimeReason=Built Browser Worker was not found:' <<<"$legacy_output"
grep -Fq 'connector-executed' <<<"$(bash "$launcher" --from-environment)"
export MCP_RELEASE_ROOT="$release"


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
bash -n "$root/deploy/linux/Prepare-McpBrowserRuntime.sh"
grep -Fq 'libatk1.0-0t64' "$root/deploy/linux/Prepare-McpBrowserRuntime.sh"
grep -Fq 'libxrender1' "$root/deploy/linux/Prepare-McpBrowserRuntime.sh"
grep -Fq 'libxi6' "$root/deploy/linux/Prepare-McpBrowserRuntime.sh"
grep -Fq 'fonts-dejavu-core' "$root/deploy/linux/Prepare-McpBrowserRuntime.sh"
grep -Fq 'LD_LIBRARY_PATH' "$root/deploy/linux/Start-McpEdgeConnector.sh"
grep -Fq 'FONTCONFIG_FILE' "$root/deploy/linux/Start-McpEdgeConnector.sh"
grep -Fq 'chromium_headless_shell-' "$root/deploy/linux/Install-McpAccessStack.sh"
grep -Fq 'ffmpeg-' "$root/deploy/linux/Install-McpAccessStack.sh"
grep -Fq 'Prepare-McpBrowserRuntime.sh' "$root/deploy/linux/Update-McpAccessStack.sh"
grep -Fq 'npx playwright install chromium' "$root/deploy/linux/Prepare-McpBrowserRuntime.sh"
grep -Fq 'chromium_headless_shell-' "$root/deploy/linux/Update-McpAccessStack.sh"
grep -Fq 'ffmpeg-' "$root/deploy/linux/Update-McpAccessStack.sh"
if command -v pwsh >/dev/null 2>&1; then
  pwsh -NoLogo -NoProfile -NonInteractive -Command '& { $tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 } }' "$root/deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1"
fi
grep -Fq 'Invoke-McpAccessStackCutoverBroker.ps1' "$root/deploy/linux/Start-McpAccessStackCutover.sh"
grep -Fq 'systemd-run --user' "$root/deploy/linux/Start-McpAccessStackCutover.sh"
grep -Fq 'Test-PersistentServiceActive' "$root/deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1"
grep -Fq 'Stop-PersistentService' "$root/deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1"
grep -Fq 'if ($persistentServiceWasActive)' "$root/deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1"
grep -Fq 'Offline rollback selected unexpected connector' "$root/deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1"
grep -Fq '$isExcluded=$Excluded -contains $id' "$root/deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1"
if grep -Fq '$excluded=$Excluded -contains $id' "$root/deploy/linux/Invoke-McpAccessStackCutoverBroker.ps1"; then
  echo 'case-insensitive Excluded shadowing regression detected' >&2
  exit 1
fi
grep -Fq 'EnvironmentFile=%h/edge-connector.env' "$unit"
grep -Fq 'ExecStart=%h/current/deploy/linux/Start-McpEdgeConnector.sh --from-environment' "$unit"
grep -Fq 'Restart=always' "$unit"
if grep -Fq 'ProtectKernelModules=true' "$unit"; then
  echo 'ProtectKernelModules=true is not compatible with the user-systemd execution node' >&2
  exit 1
fi
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
