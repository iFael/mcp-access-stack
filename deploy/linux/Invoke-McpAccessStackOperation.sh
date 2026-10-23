#!/usr/bin/env bash
set -euo pipefail

# One short, JSON-reporting entry point per lifecycle step, so an operator (or
# a remote assistant over SSH) never has to assemble the long updater/cutover
# command lines by hand. Every step re-validates its own preconditions and
# delegates the actual work to the existing Update/Start-Cutover scripts.

fail() {
  jq -cn --arg error "$1" '{status:"refused",error:$error}'
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: Invoke-McpAccessStackOperation.sh status [--installation-root PATH]
       Invoke-McpAccessStackOperation.sh prepare --tag vX.Y.Z --execute [--installation-root PATH]
       Invoke-McpAccessStackOperation.sh cutover --release-id ID --execute [--installation-root PATH]
EOF
  exit 2
}

operation="${1:-}"
[[ "$operation" == status || "$operation" == prepare || "$operation" == cutover ]] || usage
shift

installation_root=/var/lib/mcp-access-stack
repository=iFael/mcp-access-stack
service_name=mcp-access-stack-edge-connector.service
tag=
release_id=
execute=false
while (($#)); do
  case "$1" in
    --installation-root) shift; installation_root="${1:-}" ;;
    --tag) shift; tag="${1:-}" ;;
    --release-id) shift; release_id="${1:-}" ;;
    --execute) execute=true ;;
    *) usage ;;
  esac
  shift
done

command -v jq >/dev/null 2>&1 || { printf 'mcp-operation: jq is required\n' >&2; exit 1; }
[[ -d "$installation_root" ]] || fail "Installation root was not found: $installation_root"
installation_root="$(readlink -f -- "$installation_root")"
# The caller's directory may be unreadable for the service account.
cd /
[[ "$(stat -c %u "$installation_root")" == "$(id -u)" ]] ||
  fail 'Run as the installation owner (sudo -n -u mcp-access-stack).'
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

state_root="$installation_root/state"
state_path="$state_root/lifecycle-state.v1.json"
runs_root="$state_root/linux-cutover-runs"
operations_root="$state_root/operations"
prepare_record="$operations_root/prepare-last.json"
[[ -f "$state_path" ]] || fail 'Lifecycle state is not initialized.'

lifecycle_json() {
  jq -c '{active:(.active.releaseId // null),candidate:(.candidate.releaseId // null),candidateManifestSha256:(.candidate.manifestSha256 // null),previous:(.previous.releaseId // null)}' "$state_path"
}

process_running() {
  pgrep -f -- "$1" >/dev/null 2>&1
}

# Newest cutover run (any status) and newest run that passed.
latest_run() {
  local wanted="$1" dir result newest="" newest_time=0 mtime
  [[ -d "$runs_root" ]] || return 0
  for dir in "$runs_root"/*/; do
    result="$dir/result.json"
    [[ -f "$dir/request.json" ]] || continue
    if [[ "$wanted" == passed ]]; then
      [[ -f "$result" && "$(jq -r '.status // empty' "$result")" == passed ]] || continue
    fi
    mtime="$(stat -c %Y "$dir/request.json")"
    if (( mtime > newest_time )); then
      newest_time=$mtime
      newest="${dir%/}"
    fi
  done
  [[ -z "$newest" ]] || printf '%s\n' "$newest"
}

edge_base_url() {
  local run config="$state_root/edge-task-config.v1.json"
  run="$(latest_run passed)"
  if [[ -n "$run" ]]; then
    jq -r '.edgeBaseUrl // empty' "$run/request.json"
  elif [[ -f "$config" ]]; then
    jq -r '.edgeBaseUrl // empty' "$config"
  fi
}

edge_json() {
  local base body
  base="$(edge_base_url)"
  [[ "$base" =~ ^https://[^/?#@]+$ ]] || { printf '{"reachable":false,"error":"edge base url unknown"}'; return; }
  if body="$(curl -fsS --max-time 10 "$base/health" 2>/dev/null)" && jq -e . >/dev/null 2>&1 <<<"$body"; then
    jq -c '{reachable:true,activeContractRevision:(.activeContractRevision // null),candidateContractRevision:(.candidateContractRevision // null),toolCount:(.runtime.toolCount // null),connectorInstanceId:(.runtime.connectorInstanceId // null),connectorReady:(.connectorReady // null)}' <<<"$body"
  else
    printf '{"reachable":false,"error":"health request failed"}'
  fi
}

service_json() {
  local active pid
  active="$(systemctl --user is-active "$service_name" 2>/dev/null | tr -d '\r' || true)"
  pid="$(systemctl --user show -p MainPID --value "$service_name" 2>/dev/null | tr -d '\r' || true)"
  jq -cn --arg name "$service_name" --arg active "${active:-unknown}" --arg pid "${pid:-0}" \
    '{name:$name,state:$active,mainPid:($pid|tonumber? // 0)}'
}

prepare_json() {
  [[ -f "$prepare_record" ]] || { printf 'null'; return; }
  local pid running=false log tail_text=""
  pid="$(jq -r '.pid // 0' "$prepare_record")"
  log="$(jq -r '.logPath // empty' "$prepare_record")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 0 )) && kill -0 "$pid" 2>/dev/null; then running=true; fi
  [[ -n "$log" && -f "$log" ]] && tail_text="$(tail -n 8 -- "$log" | tr -d '\r')"
  jq -c --argjson running "$running" --arg tail "$tail_text" '. + {running:$running,logTail:($tail|split("\n"))}' "$prepare_record"
}

last_cutover_json() {
  local run
  run="$(latest_run any)"
  [[ -n "$run" ]] || { printf 'null'; return; }
  if [[ -f "$run/result.json" ]]; then
    jq -c --arg resultPath "$run/result.json" '{requestId,releaseId,status,completedAt,failureCode:(.failureCode // null),contractPromotion:(.contractPromotion.status // null),resultPath:$resultPath}' "$run/result.json"
  else
    jq -c --arg resultPath "$run/result.json" '{requestId,releaseId,status:"running-or-unfinished",resultPath:$resultPath}' "$run/request.json"
  fi
}

broker_running() {
  if process_running Invoke-McpAccessStackCutoverBroker; then printf true; else printf false; fi
}

updater_running() {
  if process_running Update-McpAccessStack.sh; then printf true; else printf false; fi
}

case "$operation" in
  status)
    jq -cn \
      --argjson lifecycle "$(lifecycle_json)" \
      --argjson service "$(service_json)" \
      --argjson brokerRunning "$(broker_running)" \
      --argjson updaterRunning "$(updater_running)" \
      --argjson prepare "$(prepare_json)" \
      --argjson lastCutover "$(last_cutover_json)" \
      --argjson edge "$(edge_json)" \
      '{operation:"status",lifecycle:$lifecycle,service:$service,brokerRunning:$brokerRunning,updaterRunning:$updaterRunning,prepare:$prepare,lastCutover:$lastCutover,edge:$edge}'
    ;;

  prepare)
    $execute || fail 'Prepare is intentionally gated. Re-run with --execute.'
    [[ "$tag" =~ ^v[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail 'Tag is invalid.'
    target="${tag#v}"
    active="$(jq -r '.active.releaseId // empty' "$state_path")"
    candidate="$(jq -r '.candidate.releaseId // empty' "$state_path")"
    [[ -n "$active" ]] || fail 'Prepare requires an active release.'
    [[ "$active" != "$target" ]] || fail "Release is already active: $target"
    [[ -z "$candidate" || "$candidate" == "$target" ]] || fail "Another candidate is pending: $candidate"
    [[ "$(updater_running)" == false ]] || fail 'An updater is already running.'
    [[ "$(broker_running)" == false ]] || fail 'A cutover broker is running.'
    # The updater always comes from the active release, never from the tag
    # being prepared.
    updater="$installation_root/releases/$active/deploy/linux/Update-McpAccessStack.sh"
    [[ -f "$updater" ]] || fail "Active release updater is missing: $updater"

    mkdir -p "$operations_root"
    chmod 700 "$operations_root"
    stamp="$(date -u +'%Y%m%dT%H%M%SZ')"
    log="$operations_root/prepare-$target-$stamp.log"
    nohup setsid bash "$updater" --repository "$repository" --installation-root "$installation_root" --tag "$tag" --execute \
      >"$log" 2>&1 </dev/null &
    pid=$!
    jq -n --arg tag "$tag" --arg releaseId "$target" --arg activeReleaseId "$active" --argjson pid "$pid" \
      --arg logPath "$log" --arg startedAt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
      '{tag:$tag,releaseId:$releaseId,activeReleaseId:$activeReleaseId,pid:$pid,logPath:$logPath,startedAt:$startedAt}' \
      > "$prepare_record.tmp"
    mv -f -- "$prepare_record.tmp" "$prepare_record"
    jq -c '{operation:"prepare",status:"started"} + .' "$prepare_record"
    ;;

  cutover)
    $execute || fail 'Cutover is intentionally gated. Re-run with --execute.'
    [[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail 'Release id is invalid.'
    candidate="$(jq -r '.candidate.releaseId // empty' "$state_path")"
    [[ "$candidate" == "$release_id" ]] || fail "Candidate is ${candidate:-none}, not $release_id."
    [[ "$(updater_running)" == false ]] || fail 'An updater is still running.'
    [[ "$(broker_running)" == false ]] || fail 'A cutover broker is already running.'
    [[ "$(systemctl --user is-active "$service_name" 2>/dev/null | tr -d '\r' || true)" == active ]] ||
      fail "Service is not active: $service_name"
    previous_run="$(latest_run passed)"
    [[ -n "$previous_run" ]] || fail 'No passed cutover run to take the runtime parameters from.'
    request="$previous_run/request.json"
    starter="$installation_root/releases/$release_id/deploy/linux/Start-McpAccessStackCutover.sh"
    [[ -f "$starter" ]] || fail "Candidate cutover script is missing: $starter"

    # Replay exactly the runtime parameters of the last cutover that passed;
    # only the release id changes.
    args=(--installation-root "$installation_root" --expected-release-id "$release_id")
    for pair in projectRoot:--project-root edgeRuntimeRoot:--edge-runtime-root edgeBaseUrl:--edge-base-url \
        connectorTokenFile:--connector-token-file policyPath:--policy-path allowedOrigins:--allowed-origins \
        edgeTaskName:--edge-task-name maxConcurrentRequests:--max-concurrent-requests \
        handoverDelaySeconds:--handover-delay-seconds; do
      value="$(jq -r --arg key "${pair%%:*}" '.[$key] // empty | tostring' "$request")"
      [[ -n "$value" ]] || fail "Previous cutover request is missing ${pair%%:*}."
      args+=("${pair#*:}" "$value")
    done
    started="$(bash "$starter" "${args[@]}" --execute)" || fail 'Cutover starter refused the request.'
    jq -c --arg from "$request" '{operation:"cutover",parametersFrom:$from} + .' <<<"$started"
    ;;
esac
