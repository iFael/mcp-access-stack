[CmdletBinding()]
param(
    [string]$OracleHost = '168.75.104.15',
    [ValidateRange(1,65535)][int]$OraclePort = 22,
    [string]$OracleBootstrapUser = 'ubuntu',
    [string]$OracleBootstrapKeyPath = (Join-Path $env:USERPROFILE '.ssh\mcp-oracle-ed25519'),
    [ValidateRange(1,65535)][int]$ReversePort = 22022,
    [ValidateRange(1,65535)][int]$WindowsSshPort = 22222,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')][string]$AdminUser = 'mcp-admin',
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')][string]$WorkspaceId = 'rafael-windows',
    [string]$WorkspaceName = 'Rafael Windows',
    [string]$WorkspaceRoot = $env:USERPROFILE,
    [string]$TaskName = 'MCP Access Stack Windows admin companion tunnel',
    [switch]$AllowExistingOpenSshServer,
    [switch]$Execute
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$managedMarker = '# Managed by MCP Access Stack Windows admin companion.'
$companionRoot = Join-Path $env:ProgramData 'McpAccessStack\windows-companion'
$tunnelKeyPath = Join-Path $companionRoot 'tunnel_ed25519'
$oracleKnownHostsPath = Join-Path $companionRoot 'oracle_known_hosts'
$sshdConfigPath = Join-Path $env:ProgramData 'ssh\sshd_config'
$authorizedKeysPath = Join-Path $companionRoot 'authorized_keys'
$sshPath = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
$sshKeygenPath = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh-keygen.exe'
$sshdPath = Join-Path $env:SystemRoot 'System32\OpenSSH\sshd.exe'
$remote = "$OracleBootstrapUser@$OracleHost"

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-ExitCode {
    param([string]$Operation,[int]$ExitCode)
    if ($ExitCode -ne 0) { throw "$Operation failed with exit code $ExitCode." }
}

function Set-AdminOnlyAcl {
    param([string]$Path,[switch]$File)
    $grants = if ($File) {
        @('*S-1-5-18:F','*S-1-5-32-544:F')
    } else {
        @('*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F')
    }
    $args = @($Path,'/inheritance:r','/grant:r') + $grants
    & icacls.exe @args | Out-Null
    Assert-ExitCode "ACL hardening for $Path" $LASTEXITCODE
}

function Invoke-OracleBootstrap {
    param([string]$Script,[hashtable]$Payload)
    if (-not (Test-Path -LiteralPath $OracleBootstrapKeyPath -PathType Leaf)) {
        throw "Oracle bootstrap SSH key was not found: $OracleBootstrapKeyPath"
    }
    $json = $Payload | ConvertTo-Json -Depth 12 -Compress
    $payloadBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $args = @(
        '-T','-q',
        '-o','BatchMode=yes',
        '-o','StrictHostKeyChecking=yes',
        '-o','ConnectTimeout=15',
        '-i',$OracleBootstrapKeyPath,
        '-p',[string]$OraclePort,
        $remote,
        'bash','-s','--',$payloadBase64
    )
    $lines = @($Script | & $sshPath @args)
    Assert-ExitCode 'Oracle bootstrap SSH command' $LASTEXITCODE
    ($lines -join [Environment]::NewLine).Trim()
}

function Ensure-OpenSshCapability {
    param([string]$Name)
    $capability = Get-WindowsCapability -Online -Name $Name
    if ($capability.State -eq 'Installed') { return }
    $result = Add-WindowsCapability -Online -Name $Name
    if ($result.RestartNeeded) {
        throw "$Name was installed but Windows requires a restart before companion configuration."
    }
    if ((Get-WindowsCapability -Online -Name $Name).State -ne 'Installed') {
        throw "Windows capability did not install successfully: $Name"
    }
}

function New-RandomPassword {
    $bytes = [byte[]]::new(48)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    try { [Convert]::ToBase64String($bytes) }
    finally { [Array]::Clear($bytes,0,$bytes.Length) }
}

if (-not (Test-IsAdministrator)) {
    throw 'Run this installer from an elevated PowerShell session.'
}
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    throw 'WorkspaceRoot must not be empty.'
}

$workspaceRootPolicy = [IO.Path]::GetFullPath($WorkspaceRoot).Replace('\','/')
$serverCapability = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
$serverAlreadyInstalled = $serverCapability.State -eq 'Installed'
$alreadyManaged = (Test-Path -LiteralPath $sshdConfigPath -PathType Leaf) -and
    (Get-Content -LiteralPath $sshdConfigPath -Raw).Contains($managedMarker)

$plan = [ordered]@{
    status = 'planned'
    oracleHost = $OracleHost
    oraclePort = $OraclePort
    reversePort = $ReversePort
    windowsSshPort = $WindowsSshPort
    workspaceId = $WorkspaceId
    workspaceRoot = $workspaceRootPolicy
    adminUser = $AdminUser
    taskName = $TaskName
    serverAlreadyInstalled = $serverAlreadyInstalled
    sshdAlreadyManaged = $alreadyManaged
    existingServerRequiresOptIn = $serverAlreadyInstalled -and -not $alreadyManaged
}
if (-not $Execute) {
    [pscustomobject]$plan | ConvertTo-Json -Depth 6 -Compress
    return
}

if ($serverAlreadyInstalled -and -not $alreadyManaged -and -not $AllowExistingOpenSshServer) {
    throw 'OpenSSH Server is already installed and not managed by MCP Access Stack. Re-run with -AllowExistingOpenSshServer only after confirming it is safe to dedicate this SSH server to the companion.'
}

Ensure-OpenSshCapability 'OpenSSH.Client~~~~0.0.1.0'
Ensure-OpenSshCapability 'OpenSSH.Server~~~~0.0.1.0'

foreach ($required in @($sshPath,$sshKeygenPath,$sshdPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required OpenSSH executable is missing: $required"
    }
}
if (-not (Get-Command pwsh.exe -ErrorAction SilentlyContinue)) {
    throw 'PowerShell 7 (pwsh.exe) is required.'
}

New-Item -ItemType Directory -Force -Path $companionRoot | Out-Null
Set-AdminOnlyAcl $companionRoot

$existingUser = Get-LocalUser -Name $AdminUser -ErrorAction SilentlyContinue
if ($existingUser) {
    if ([string]$existingUser.Description -ne 'MCP Access Stack Windows admin companion') {
        throw "Local user already exists but is not owned by MCP Access Stack: $AdminUser"
    }
} else {
    $plain = New-RandomPassword
    try {
        $secure = ConvertTo-SecureString $plain -AsPlainText -Force
        $userArgs = @{
            Name = $AdminUser
            Password = $secure
            AccountNeverExpires = $true
            PasswordNeverExpires = $true
            UserMayNotChangePassword = $true
            Description = 'MCP Access Stack Windows admin companion'
        }
        New-LocalUser @userArgs | Out-Null
    } finally {
        $plain = $null
        $secure = $null
    }
}

$administrators = Get-LocalGroup -SID 'S-1-5-32-544'
$member = Get-LocalGroupMember -Group $administrators.Name -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "(^|\\)$([Regex]::Escape($AdminUser))$" }
if (-not $member) {
    Add-LocalGroupMember -Group $administrators.Name -Member $AdminUser
}

$hiddenKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
New-Item -Path $hiddenKey -Force | Out-Null
New-ItemProperty -Path $hiddenKey -Name $AdminUser -PropertyType DWord -Value 0 -Force | Out-Null

if (-not (Test-Path -LiteralPath $tunnelKeyPath -PathType Leaf)) {
    $keyArgs = @('-q','-t','ed25519','-N','','-C',"mcp-windows-companion-tunnel-$env:COMPUTERNAME",'-f',$tunnelKeyPath)
    & $sshKeygenPath @keyArgs
    Assert-ExitCode 'Windows companion tunnel key generation' $LASTEXITCODE
}
Set-AdminOnlyAcl $tunnelKeyPath -File
Set-AdminOnlyAcl "$tunnelKeyPath.pub" -File

$tunnelPublicKey = (Get-Content -LiteralPath "$tunnelKeyPath.pub" -Raw).Trim()
if ($tunnelPublicKey -notmatch '^ssh-ed25519\s+[A-Za-z0-9+/=]+\s+\S+$') {
    throw 'Generated tunnel public key is invalid.'
}

$phase1 = @'
set -euo pipefail
payload="$(printf '%s' "$1" | base64 -d)"
tunnel_public_key="$(printf '%s' "$payload" | jq -r '.tunnelPublicKey')"
reverse_port="$(printf '%s' "$payload" | jq -r '.reversePort')"
machine_id="$(printf '%s' "$payload" | jq -r '.machineId')"
companion_root=/var/lib/mcp-access-stack/windows-companion
install -d -m 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
sudo install -d -o mcp-access-stack -g mcp-access-stack -m 700 "$companion_root"
sudo install -d -o mcp-access-stack -g mcp-access-stack -m 700 "$companion_root/state"
if ! sudo -u mcp-access-stack test -f "$companion_root/id_ed25519"; then
  sudo -u mcp-access-stack ssh-keygen -q -t ed25519 -N '' -C mcp-oracle-to-windows-companion -f "$companion_root/id_ed25519"
fi
marker="mcp-windows-companion-tunnel-$machine_id"
tmp="$(mktemp)"
awk -v marker="$marker" 'index($0, marker) == 0 { print }' "$HOME/.ssh/authorized_keys" > "$tmp"
printf 'command="/bin/false",no-agent-forwarding,no-X11-forwarding,no-pty,permitlisten="127.0.0.1:%s" %s\n' "$reverse_port" "$tunnel_public_key" >> "$tmp"
cat "$tmp" > "$HOME/.ssh/authorized_keys"
rm -f "$tmp"
chmod 600 "$HOME/.ssh/authorized_keys"
oracle_public_key="$(sudo -u mcp-access-stack cat "$companion_root/id_ed25519.pub")"
oracle_host_key="$(awk '{print $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub)"
jq -n -c --arg oraclePublicKey "$oracle_public_key" --arg oracleHostKey "$oracle_host_key" '{oraclePublicKey:$oraclePublicKey,oracleHostKey:$oracleHostKey}'
'@

$phase1Json = Invoke-OracleBootstrap $phase1 @{
    tunnelPublicKey = $tunnelPublicKey
    reversePort = $ReversePort
    machineId = $env:COMPUTERNAME
}
$phase1Result = $phase1Json | ConvertFrom-Json
$oraclePublicKey = [string]$phase1Result.oraclePublicKey
$oracleHostKey = [string]$phase1Result.oracleHostKey
if ($oraclePublicKey -notmatch '^ssh-ed25519\s+[A-Za-z0-9+/=]+\s+\S+$') {
    throw 'Oracle companion public key is invalid.'
}
if ($oracleHostKey -notmatch '^ssh-ed25519\s+[A-Za-z0-9+/=]+$') {
    throw 'Oracle SSH host public key is invalid.'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $sshdConfigPath) | Out-Null
if ((Test-Path -LiteralPath $sshdConfigPath -PathType Leaf) -and -not $alreadyManaged) {
    $backup = Join-Path $companionRoot 'sshd_config.pre-mcp.bak'
    if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
        Copy-Item -LiteralPath $sshdConfigPath -Destination $backup
        Set-AdminOnlyAcl $backup -File
    }
}

$sshdConfig = @"
$managedMarker
Port $WindowsSshPort
ListenAddress 127.0.0.1
ListenAddress ::1
PubkeyAuthentication yes
PasswordAuthentication no
PermitEmptyPasswords no
AllowUsers $AdminUser
AllowAgentForwarding no
AllowTcpForwarding no
GatewayPorts no
X11Forwarding no
PermitTunnel no
AuthorizedKeysFile C:/ProgramData/McpAccessStack/windows-companion/authorized_keys
Subsystem sftp sftp-server.exe
"@
[IO.File]::WriteAllText($sshdConfigPath,$sshdConfig + [Environment]::NewLine,[Text.UTF8Encoding]::new($false))

& $sshKeygenPath -A
Assert-ExitCode 'OpenSSH host-key initialization' $LASTEXITCODE
[IO.File]::WriteAllText($authorizedKeysPath,$oraclePublicKey + [Environment]::NewLine,[Text.UTF8Encoding]::new($false))
Set-AdminOnlyAcl $authorizedKeysPath -File

& $sshdPath -t -f $sshdConfigPath
Assert-ExitCode 'OpenSSH server configuration validation' $LASTEXITCODE
Set-Service -Name sshd -StartupType Automatic
Restart-Service -Name sshd

Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'OpenSSH*' -or $_.DisplayName -match 'OpenSSH' } |
    Disable-NetFirewallRule -ErrorAction SilentlyContinue

$oracleHostPattern = if ($OraclePort -eq 22) { $OracleHost } else { "[$OracleHost]:$OraclePort" }
[IO.File]::WriteAllText($oracleKnownHostsPath,"$oracleHostPattern $oracleHostKey$([Environment]::NewLine)",[Text.UTF8Encoding]::new($false))
Set-AdminOnlyAcl $oracleKnownHostsPath -File

$sshArgs = @(
    '-N','-T',
    '-o','BatchMode=yes',
    '-o','ExitOnForwardFailure=yes',
    '-o','StrictHostKeyChecking=yes',
    '-o',"UserKnownHostsFile=$oracleKnownHostsPath",
    '-o','IdentitiesOnly=yes',
    '-o','ServerAliveInterval=30',
    '-o','ServerAliveCountMax=3',
    '-i',$tunnelKeyPath,
    '-p',[string]$OraclePort,
    '-R',('127.0.0.1:{0}:127.0.0.1:{1}' -f $ReversePort,$WindowsSshPort),
    $remote
)
$argumentText = ($sshArgs | ForEach-Object {
    if ($_ -match '\s') { '"' + $_.Replace('"','\"') + '"' } else { $_ }
}) -join ' '

$action = New-ScheduledTaskAction -Execute $sshPath -Argument $argumentText -WorkingDirectory $companionRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Maintains the outbound-only reverse SSH tunnel for the optional MCP Windows admin companion.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$phase2 = @'
set -euo pipefail
payload="$(printf '%s' "$1" | base64 -d)"
reverse_port="$(printf '%s' "$payload" | jq -r '.reversePort')"
admin_user="$(printf '%s' "$payload" | jq -r '.adminUser')"
workspace_id="$(printf '%s' "$payload" | jq -r '.workspaceId')"
workspace_name="$(printf '%s' "$payload" | jq -r '.workspaceName')"
workspace_root="$(printf '%s' "$payload" | jq -r '.workspaceRoot')"
companion_root=/var/lib/mcp-access-stack/windows-companion
scan="$(mktemp)"
found=false
for _ in $(seq 1 45); do
  if ssh-keyscan -T 2 -p "$reverse_port" 127.0.0.1 > "$scan" 2>/dev/null && test -s "$scan"; then
    found=true
    break
  fi
  sleep 1
done
$found || { rm -f "$scan"; echo 'Reverse tunnel did not become reachable.' >&2; exit 1; }
sudo install -o mcp-access-stack -g mcp-access-stack -m 600 "$scan" "$companion_root/known_hosts"
rm -f "$scan"

admin_json="$(
  cat <<'PWSH' | sudo -u mcp-access-stack ssh -T -q -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$companion_root/known_hosts" -o IdentitiesOnly=yes -i "$companion_root/id_ed25519" -p "$reverse_port" "$admin_user@127.0.0.1" 'pwsh.exe -NoLogo -NoProfile -NonInteractive -Command -'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
$isAdmin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
& fltmc.exe *> $null
$fltmc=($LASTEXITCODE -eq 0)
[pscustomobject]@{host=$env:COMPUTERNAME;user=$identity.Name;isAdmin=$isAdmin;fltmc=$fltmc;pwsh=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json -Compress
PWSH
)"
test "$(printf '%s' "$admin_json" | jq -r '.isAdmin')" = true || { echo 'Windows SSH session does not have an administrator token.' >&2; exit 1; }
test "$(printf '%s' "$admin_json" | jq -r '.fltmc')" = true || { echo 'Windows SSH session failed the elevated read-only fltmc probe.' >&2; exit 1; }

policy_tmp="$(mktemp)"
jq -n --arg id "$workspace_id" --arg name "$workspace_name" --arg root "$workspace_root" '{
  version:1,
  workspaces:[{
    id:$id,name:$name,rootPath:$root,workspaceKind:"repository",enabled:true,
    permissionProfile:"full-repo-write",confirmationMode:"standard",
    allowedRoots:["."],blockedGlobs:[],
    limits:{maxFileBytes:300000,maxSearchResults:100,maxSearchSnippetBytes:20000,maxDiffBytes:500000,maxListedFiles:1000},
    allowWrites:["."],allowShell:["."],allowedShells:["powershell","pwsh","cmd","wsl","git-bash"]
  }]
}' > "$policy_tmp"
sudo install -o mcp-access-stack -g mcp-access-stack -m 600 "$policy_tmp" "$companion_root/policy.json"
rm -f "$policy_tmp"

env_tmp="$(mktemp)"
cat > "$env_tmp" <<EOF
MCP_WINDOWS_COMPANION_ENABLED=true
MCP_WINDOWS_COMPANION_HOST=127.0.0.1
MCP_WINDOWS_COMPANION_PORT=$reverse_port
MCP_WINDOWS_COMPANION_USERNAME=$admin_user
MCP_WINDOWS_COMPANION_PRIVATE_KEY_PATH=$companion_root/id_ed25519
MCP_WINDOWS_COMPANION_KNOWN_HOSTS_PATH=$companion_root/known_hosts
MCP_WINDOWS_COMPANION_POLICY_PATH=$companion_root/policy.json
MCP_WINDOWS_COMPANION_CONNECT_TIMEOUT_MS=15000
MCP_WINDOWS_COMPANION_BACKGROUND_STATE_DIR=$companion_root/state
EOF
sudo install -o mcp-access-stack -g mcp-access-stack -m 600 "$env_tmp" "$companion_root/edge.env"
rm -f "$env_tmp"

uid="$(id -u mcp-access-stack)"
sudo -u mcp-access-stack env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user daemon-reload
sudo -u mcp-access-stack env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user restart mcp-access-stack-edge-connector.service
for _ in $(seq 1 30); do
  if sudo -u mcp-access-stack env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user is-active --quiet mcp-access-stack-edge-connector.service; then break; fi
  sleep 1
done
sudo -u mcp-access-stack env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user is-active --quiet mcp-access-stack-edge-connector.service || { echo 'Oracle Edge Connector did not return to active state.' >&2; exit 1; }

jq -n -c --argjson admin "$admin_json" --arg workspaceId "$workspace_id" --arg reversePort "$reverse_port" '{status:"installed",workspaceId:$workspaceId,reversePort:($reversePort|tonumber),windows:$admin}'
'@

$phase2Json = Invoke-OracleBootstrap $phase2 @{
    reversePort = $ReversePort
    adminUser = $AdminUser
    workspaceId = $WorkspaceId
    workspaceName = $WorkspaceName
    workspaceRoot = $workspaceRootPolicy
}
$phase2Result = $phase2Json | ConvertFrom-Json

[pscustomobject]@{
    status = 'installed'
    workspaceId = $WorkspaceId
    oracleHost = $OracleHost
    reversePort = $ReversePort
    windowsSshPort = $WindowsSshPort
    adminUser = $AdminUser
    tunnelTask = $TaskName
    windowsHost = [string]$phase2Result.windows.host
    windowsUser = [string]$phase2Result.windows.user
    elevated = [bool]$phase2Result.windows.isAdmin -and [bool]$phase2Result.windows.fltmc
    pwsh = [string]$phase2Result.windows.pwsh
} | ConvertTo-Json -Depth 6 -Compress
