[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('development', 'production')]
    [string]$Environment,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Disabled', 'Shadow', 'Qualified', 'Autocorrection', 'Provider')]
    [string]$Mode,

    [string[]]$WorkspaceId = @(),
    [string]$ProviderModel,
    [string]$ProviderBrokerPath,
    [ValidateRange(1, 300000)]
    [int]$ProviderTimeoutMs = 20000,
    [string]$ProjectRoot,
    [string]$ConfigurationPath
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not $ProjectRoot) {
    $ProjectRoot = Get-McpProjectRoot
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not $ConfigurationPath) {
    $ConfigurationPath = Join-Path $ProjectRoot ".runtime-private\docker\$Environment\agent.json"
}
$ConfigurationPath = [System.IO.Path]::GetFullPath($ConfigurationPath)
if (-not (Test-Path -LiteralPath $ConfigurationPath -PathType Leaf)) {
    throw "Agent configuration does not exist: $ConfigurationPath"
}

$workspaceIds = @(
    $WorkspaceId |
        ForEach-Object { [string]$_ } |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ } |
        Sort-Object -Unique
)
foreach ($workspace in $workspaceIds) {
    if ($workspace -notmatch '^[A-Za-z0-9._-]{1,128}$') {
        throw "Invalid workspace identifier: $workspace"
    }
}
if ($Mode -ne 'Disabled' -and $workspaceIds.Count -eq 0) {
    throw 'An explicit workspace allowlist is required for every enabled rollout mode.'
}
if ($Mode -eq 'Provider') {
    if (-not $ProviderModel) {
        throw 'Provider mode requires -ProviderModel.'
    }
    if (-not $ProviderBrokerPath -or -not [System.IO.Path]::IsPathRooted($ProviderBrokerPath)) {
        throw 'Provider mode requires an absolute -ProviderBrokerPath.'
    }
    if (-not (Test-Path -LiteralPath $ProviderBrokerPath -PathType Leaf)) {
        throw "Provider broker executable does not exist: $ProviderBrokerPath"
    }
}

$workspaceAllowlist = [System.Collections.Generic.List[string]]::new()
if ($Mode -ne 'Disabled') {
    foreach ($workspace in $workspaceIds) {
        $workspaceAllowlist.Add($workspace)
    }
}

$config = Read-McpJsonFile -Path $ConfigurationPath
$qualifiedExecution = $Mode -in @('Qualified', 'Autocorrection', 'Provider')
$safeAutoCorrection = $Mode -eq 'Autocorrection'
$shadowMode = $Mode -eq 'Shadow'
$providerEnabled = $Mode -eq 'Provider'
$config | Add-Member -NotePropertyName qualifiedCommand -NotePropertyValue ([ordered]@{
    qualifiedExecution = $qualifiedExecution
    safeAutoCorrection = $safeAutoCorrection
    shadowMode = $shadowMode
    providerEnabled = $providerEnabled
    workspaceAllowlist = $workspaceAllowlist
    providerModel = if ($providerEnabled) { $ProviderModel.Trim() } else { $null }
    providerBrokerPath = if ($providerEnabled) { [System.IO.Path]::GetFullPath($ProviderBrokerPath) } else { $null }
    providerTimeoutMs = $ProviderTimeoutMs
}) -Force

$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$backupPath = "$ConfigurationPath.qualified-command.$timestamp.bak"
Copy-Item -LiteralPath $ConfigurationPath -Destination $backupPath -Force
try {
    Write-McpJsonFile -Path $ConfigurationPath -Value $config
}
catch {
    Copy-Item -LiteralPath $backupPath -Destination $ConfigurationPath -Force
    throw
}

[ordered]@{
    environment = $Environment
    mode = $Mode
    workspaceAllowlist = $workspaceAllowlist
    providerConfigured = $providerEnabled
    configurationPath = $ConfigurationPath
    backupPath = $backupPath
} | ConvertTo-Json -Compress
