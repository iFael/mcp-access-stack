#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
operation="$root/deploy/linux/Invoke-McpAccessStackOperation.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

install="$tmp/install"
bin="$tmp/bin"
mkdir -p "$install/state/linux-cutover-runs" "$bin"
for release in 1.0.0-a 1.0.0-b; do
  mkdir -p "$install/releases/$release/deploy/linux"
  cat > "$install/releases/$release/deploy/linux/Update-McpAccessStack.sh" <<EOF
#!/usr/bin/env bash
printf '%s|%s\n' "\$PWD" "\$*" > "$tmp/updater-$release.args"
EOF
  cat > "$install/releases/$release/deploy/linux/Start-McpAccessStackCutover.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" > "$tmp/starter-$release.args"
printf '{"status":"started","resultPath":"/fixture/result.json"}\n'
EOF
done

cat > "$bin/systemctl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *is-active*) printf 'active\r\n' ;;
  *MainPID*) printf '4242\n' ;;
esac
EOF
cat > "$bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '{"activeContractRevision":"rev-a","runtime":{"toolCount":110,"connectorInstanceId":"conn-1"},"connectorReady":true}\n'
EOF
chmod +x "$bin/systemctl" "$bin/curl"
export PATH="$bin:$PATH"

write_state() {
  jq -n --arg candidate "$1" '{version:1,active:{releaseId:"1.0.0-a"},candidate:(if $candidate == "" then null else {releaseId:$candidate,manifestSha256:"abc"} end),previous:null}' \
    > "$install/state/lifecycle-state.v1.json"
}

run_dir="$install/state/linux-cutover-runs/run-1"
mkdir -p "$run_dir"
jq -n '{schemaVersion:1,requestId:"run-1",releaseId:"1.0.0-a",projectRoot:"/p",edgeRuntimeRoot:"/r",edgeBaseUrl:"https://edge.example.workers.dev",connectorTokenFile:"/t",policyPath:"/policy.json",allowedOrigins:"https://chatgpt.com",edgeTaskName:"mcp-access-stack-edge-connector.service",maxConcurrentRequests:8,handoverDelaySeconds:2}' \
  > "$run_dir/request.json"
jq -n '{requestId:"run-1",releaseId:"1.0.0-a",status:"passed",contractPromotion:{status:"promoted"}}' > "$run_dir/result.json"

# status reports lifecycle, service, last cutover and Edge health.
write_state ""
status="$(cd "$tmp" && bash "$operation" status --installation-root "$install")"
jq -e '.lifecycle.active == "1.0.0-a" and .lifecycle.candidate == null' <<<"$status" >/dev/null
jq -e '.service.state == "active" and .service.mainPid == 4242' <<<"$status" >/dev/null
jq -e '.lastCutover.status == "passed" and .lastCutover.contractPromotion == "promoted"' <<<"$status" >/dev/null
jq -e '.edge.reachable and .edge.toolCount == 110 and .brokerRunning == false' <<<"$status" >/dev/null

# prepare is gated, and runs the ACTIVE release's updater from /.
if bash "$operation" prepare --tag v1.0.0-b --installation-root "$install" >/dev/null; then
  printf 'prepare ran without --execute\n' >&2; exit 1
fi
prepared="$(bash "$operation" prepare --tag v1.0.0-b --execute --installation-root "$install")"
jq -e '.status == "started" and .releaseId == "1.0.0-b" and .activeReleaseId == "1.0.0-a"' <<<"$prepared" >/dev/null
# The updater runs detached; wait until its record is complete.
expected_updater="/|--repository iFael/mcp-access-stack --installation-root $install --tag v1.0.0-b --execute"
for _ in $(seq 100); do
  grep -Fxq "$expected_updater" "$tmp/updater-1.0.0-a.args" 2>/dev/null && break
  sleep 0.1
done
grep -Fxq "$expected_updater" "$tmp/updater-1.0.0-a.args"
[[ ! -e "$tmp/updater-1.0.0-b.args" ]]
jq -e '.prepare.releaseId == "1.0.0-b"' <<<"$(bash "$operation" status --installation-root "$install")" >/dev/null

# prepare refuses when another candidate is pending, or the tag is already active.
write_state "1.0.0-c"
refused="$(bash "$operation" prepare --tag v1.0.0-b --execute --installation-root "$install" || true)"
jq -e '.status == "refused" and (.error | test("candidate is pending"))' <<<"$refused" >/dev/null
refused="$(bash "$operation" prepare --tag v1.0.0-a --execute --installation-root "$install" || true)"
jq -e '.status == "refused" and (.error | test("already active"))' <<<"$refused" >/dev/null

# cutover requires the candidate and replays the last passed request.
write_state ""
refused="$(bash "$operation" cutover --release-id 1.0.0-b --execute --installation-root "$install" || true)"
jq -e '.status == "refused" and (.error | test("Candidate is none"))' <<<"$refused" >/dev/null
write_state "1.0.0-b"
started="$(bash "$operation" cutover --release-id 1.0.0-b --execute --installation-root "$install")"
jq -e '.operation == "cutover" and .status == "started"' <<<"$started" >/dev/null
expected="--installation-root $install --expected-release-id 1.0.0-b --project-root /p --edge-runtime-root /r --edge-base-url https://edge.example.workers.dev --connector-token-file /t --policy-path /policy.json --allowed-origins https://chatgpt.com --edge-task-name mcp-access-stack-edge-connector.service --max-concurrent-requests 8 --handover-delay-seconds 2 --execute"
grep -Fxq -- "$expected" "$tmp/starter-1.0.0-b.args"

printf 'Invoke-McpAccessStackOperation checks passed\n'
