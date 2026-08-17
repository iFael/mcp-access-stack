[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PublicKey,

    [switch]$AllowInboundTcp22
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this bootstrap from an elevated PowerShell session.'
    }
}

function Test-ValidSshPublicKey([string]$Value) {
    $trimmed = $Value.Trim()
    return $trimmed -match '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(?:\s+.*)?$'
}

function Set-RestrictedAcl([string]$Path, [bool]$AdministratorsKeyFile) {
    if ($AdministratorsKeyFile) {
        & icacls.exe $Path /inheritance:r | Out-Null
        & icacls.exe $Path /grant:r '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
    }
    else {
        $account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        & icacls.exe $Path /inheritance:r | Out-Null
        & icacls.exe $Path /grant:r ("{0}:(F)" -f $account) '*S-1-5-18:(F)' | Out-Null
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to apply the required ACL to $Path."
    }
}

Assert-Administrator

if (-not (Test-ValidSshPublicKey $PublicKey)) {
    throw 'PublicKey is not a supported OpenSSH public key.'
}

$capabilityName = 'OpenSSH.Server~~~~0.0.1.0'
$capability = Get-WindowsCapability -Online -Name $capabilityName
if ($capability.State -ne 'Installed') {
    if ($PSCmdlet.ShouldProcess($capabilityName, 'Install Windows OpenSSH Server capability')) {
        $result = Add-WindowsCapability -Online -Name $capabilityName
        if ($result.RestartNeeded) {
            Write-Warning 'Windows reports that a restart is required before OpenSSH Server is fully available.'
        }
    }
}

$sshd = Get-Service -Name sshd -ErrorAction Stop
if ($PSCmdlet.ShouldProcess('sshd', 'Set Automatic startup and start service')) {
    Set-Service -Name sshd -StartupType Automatic
    if ($sshd.Status -ne 'Running') {
        Start-Service -Name sshd
    }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdministrator) {
    $sshDirectory = Join-Path $env:ProgramData 'ssh'
    $authorizedKeysPath = Join-Path $sshDirectory 'administrators_authorized_keys'
}
else {
    $sshDirectory = Join-Path $env:USERPROFILE '.ssh'
    $authorizedKeysPath = Join-Path $sshDirectory 'authorized_keys'
}

if ($PSCmdlet.ShouldProcess($authorizedKeysPath, 'Install authorized SSH public key')) {
    New-Item -ItemType Directory -Path $sshDirectory -Force | Out-Null
    $normalizedKey = $PublicKey.Trim()
    $existing = @()
    if (Test-Path -LiteralPath $authorizedKeysPath -PathType Leaf) {
        $existing = @(Get-Content -LiteralPath $authorizedKeysPath | Where-Object { $_.Trim().Length -gt 0 })
    }
    if ($existing -notcontains $normalizedKey) {
        @($existing + $normalizedKey) |
            Set-Content -LiteralPath $authorizedKeysPath -Encoding ascii
    }
    Set-RestrictedAcl -Path $authorizedKeysPath -AdministratorsKeyFile:$isAdministrator
}

$firewallRuleName = 'MCP Workspace OpenSSH Server'
$existingRule = Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue
if ($AllowInboundTcp22) {
    if (-not $existingRule -and $PSCmdlet.ShouldProcess($firewallRuleName, 'Create inbound TCP/22 firewall rule')) {
        New-NetFirewallRule `
            -DisplayName $firewallRuleName `
            -Direction Inbound `
            -Protocol TCP `
            -LocalPort 22 `
            -Action Allow `
            -Profile Domain,Private | Out-Null
    }
}
elseif ($existingRule -and $PSCmdlet.ShouldProcess($firewallRuleName, 'Remove MCP-specific inbound firewall rule')) {
    Remove-NetFirewallRule -DisplayName $firewallRuleName
}

$listen = Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue

[pscustomobject]@{
    OpenSshServerCapability = (Get-WindowsCapability -Online -Name $capabilityName).State
    SshdStatus = (Get-Service -Name sshd).Status
    AuthorizedKeysPath = $authorizedKeysPath
    UsesAdministratorsAuthorizedKeys = $isAdministrator
    InboundTcp22EnabledByBootstrap = [bool]$AllowInboundTcp22
    Port22Listening = [bool]$listen
}
