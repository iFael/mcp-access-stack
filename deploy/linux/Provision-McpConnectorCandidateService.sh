#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'candidate-connector-unit: %s\n' "$1" >&2; exit 1; }

operation_id=''
candidate_id=''
expected_manifest=''
expected_active_pid=''
execute=false
while (($#)); do
  case "$1" in
    --operation-id) shift; operation_id="${1:-}" ;;
    --candidate-release-id) shift; candidate_id="${1:-}" ;;
    --expected-manifest-sha256) shift; expected_manifest="${1:-}" ;;
    --expected-active-pid) shift; expected_active_pid="${1:-}" ;;
    --execute) execute=true ;;
    *) fail 'Unknown input.' ;;
  esac
  shift
done

[[ "$operation_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail 'Invalid operationId.'
[[ "$candidate_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail 'Invalid candidate release ID.'
[[ "$expected_manifest" =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid expected manifest SHA-256.'
[[ "$expected_active_pid" =~ ^[1-9][0-9]*$ ]] || fail 'Invalid active connector PID.'

# These paths and names are fixed. No caller-supplied filesystem or service target.
installation_root='/var/lib/mcp-access-stack'
state_path="$installation_root/state/lifecycle-state.v1.json"
candidate_root="$installation_root/releases/$candidate_id"
manifest_path="$candidate_root/linux-release-manifest.json"
launcher="$candidate_root/deploy/linux/Start-McpEdgeConnector.sh"
active_unit='mcp-access-stack-edge-connector.service'
candidate_unit='mcp-access-stack-connector99-persistent.service'
unit_dir="$installation_root/.config/systemd/user"
unit_path="$unit_dir/$candidate_unit"
env_path="$installation_root/edge-connector.env"
runtime_dir='mcp-connector99-persistent'

[[ -f "$state_path" && ! -L "$state_path" ]] || fail 'Lifecycle state missing or linked.'
[[ -f "$manifest_path" && ! -L "$manifest_path" ]] || fail 'Candidate manifest missing or linked.'
[[ -f "$launcher" && ! -L "$launcher" && -x "$launcher" ]] || fail 'Candidate launcher missing or linked.'
[[ -f "$env_path" && ! -L "$env_path" ]] || fail 'Private connector configuration missing or linked.'
[[ -d "$unit_dir" && ! -L "$unit_dir" ]] || fail 'User unit directory missing or linked.'
[[ -d "$candidate_root" && ! -L "$candidate_root" ]] || fail 'Candidate root missing or linked.'
[[ "$(readlink -f -- "$unit_dir")" == "$unit_dir" ]] || fail 'Unit directory must have canonical path.'
[[ "$(readlink -f -- "$candidate_root")" == "$candidate_root" ]] || fail 'Candidate root must have canonical path.'
[[ "$(loginctl show-user "$(id -u)" --property=Linger --value)" == "yes" ]] || fail 'User lingering is required for boot recovery.'
[[ ! -e "$unit_path" && ! -L "$unit_path" ]] || fail 'Persistent candidate unit already exists; reconcile instead of overwriting.'
[[ "$(jq -r '.candidate.releaseId // empty' "$state_path")" == "$candidate_id" ]] || fail 'Candidate release CAS mismatch.'
[[ "$(jq -r '.candidate.manifestSha256 // empty' "$state_path")" == "$expected_manifest" ]] || fail 'Candidate state SHA mismatch.'
[[ "$(sha256sum "$manifest_path" | awk '{print $1}')" == "$expected_manifest" ]] || fail 'Materialized manifest SHA mismatch.'
[[ "$(jq -r '.releaseId // empty' "$manifest_path")" == "$candidate_id" ]] || fail 'Manifest release identity mismatch.'
[[ "$(jq -r '.tag // empty' "$manifest_path")" == "v$candidate_id" ]] || fail 'Manifest tag identity mismatch.'
launcher_digest="$(jq -r --arg name 'deploy/linux/Start-McpEdgeConnector.sh' '.artifacts[] | select(.path == $name) | .sha256' "$manifest_path")"
[[ "$launcher_digest" =~ ^[a-f0-9]{64}$ ]] || fail 'Candidate launcher missing from manifest.'
[[ "$(sha256sum "$launcher" | awk '{print $1}')" == "$launcher_digest" ]] || fail 'Candidate launcher integrity mismatch.'

active_id="$(jq -r '.active.releaseId // empty' "$state_path")"
[[ "$active_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail 'Active release missing.'
[[ "$(readlink -f -- "$installation_root/current")" == "$installation_root/releases/$active_id" ]] || fail 'Current release differs from active state.'
[[ "$(systemctl --user show "$active_unit" --property=ActiveState --value)" == 'active' ]] || fail 'Active service is not running.'
[[ "$(systemctl --user show "$active_unit" --property=MainPID --value)" == "$expected_active_pid" ]] || fail 'Active service PID CAS mismatch.'
[[ "$(systemctl --user show "$candidate_unit" --property=LoadState --value)" == 'not-found' ]] || fail 'Persistent candidate unit already loaded.'
[[ "$(systemctl --user show mcp-access-stack-connector99-candidate.service --property=ActiveState --value)" == 'active' ]] || fail 'Side-by-side candidate is not running.'

if ! $execute; then
  printf 'status=validated\noperationId=%s\ncandidateRelease=%s\nmanifestSha256=%s\nactiveServicePreserved=true\n' \
    "$operation_id" "$candidate_id" "$expected_manifest"
  exit 0
fi

umask 077
tmp_unit="$(mktemp "$unit_dir/.mcp-connector99-persistent.XXXXXXXX")"
cleanup() { [[ -z "${tmp_unit:-}" ]] || rm -f -- "$tmp_unit"; }
trap cleanup EXIT
cat > "$tmp_unit" <<EOF
[Unit]
Description=MCP Access Stack Connector 99 Candidate (isolated)
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=3600
StartLimitBurst=6

[Service]
Type=simple
WorkingDirectory=/srv/mcp-access-stack
EnvironmentFile=$env_path
ExecStart=/usr/bin/env MCP_RELEASE_ROOT=$candidate_root MCP_ACCESS_STACK_RUNTIME_ROOT=%t/$runtime_dir $launcher --from-environment
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
KillSignal=SIGTERM
RuntimeDirectory=$runtime_dir
RuntimeDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=default.target
EOF
chmod 600 -- "$tmp_unit"
# Exclusive installation; do not overwrite concurrent or pre-existing units.
ln -- "$tmp_unit" "$unit_path" || fail 'Concurrent candidate unit creation detected.'
rm -- "$tmp_unit"
tmp_unit=''
trap - EXIT

# If systemd fails, preserve the file and stop: reconciliation is mandatory.
systemctl --user daemon-reload || fail 'Reload outcome requires reconciliation.'
systemctl --user enable "$candidate_unit" >/dev/null || fail 'Enable outcome requires reconciliation.'
systemctl --user start "$candidate_unit" || fail 'Start outcome requires reconciliation.'
[[ "$(systemctl --user show "$candidate_unit" --property=ActiveState --value)" == 'active' ]] || fail 'Candidate unit readiness requires reconciliation.'
[[ "$(systemctl --user show "$active_unit" --property=MainPID --value)" == "$expected_active_pid" ]] || fail 'Active service PID changed during provisioning.'
printf 'status=provisioned\noperationId=%s\ncandidateRelease=%s\nactiveServicePreserved=true\n' "$operation_id" "$candidate_id"
