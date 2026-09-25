[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$ReleaseId,

    [Parameter(Mandatory = $true)]
    [string]$StateRoot,

    [string]$TaskName = 'MCP V3 local companion',

    [ValidateRange(0, 300)]
    [int]$DelaySeconds = 5,

    [switch]$Execute,
    [switch]$Force,
    [switch]$Activate,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'MCP V3 local task installation is intentionally gated. Re-run with -Execute.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required MCP V3 local task dependency is missing: $bootstrapPath"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $bootstrapPath
    if ($signature.Status -ne 'Valid' -and -not ($AllowUnsignedDevelopment -and $signature.Status -eq 'NotSigned')) {
        throw "Invalid Authenticode signature for $bootstrapPath. Status=$($signature.Status)"
    }
}

. $publicCommonPath
Assert-McpPublicSignature -Path $publicCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature -Path $executionCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
. $executionCommonPath
Assert-McpPublicWindowsX64

function Quote-McpV3LocalTaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) {
        throw 'MCP V3 local Scheduled Task arguments cannot contain quotes.'
    }
    return '"' + $Value + '"'
}

$installation = [IO.Path]::GetFullPath($InstallationRoot)
$state = [IO.Path]::GetFullPath($StateRoot)
$releaseRoot = Join-Path $installation ("releases\$ReleaseId")
if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) {
    throw "MCP V3 local release was not found: $releaseRoot"
}

$verification = Assert-McpWindowsExecutionNodeRelease -ReleaseRoot $releaseRoot -ExpectedReleaseId $ReleaseId -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
$manifest = $verification.executionManifest
$manifestSha256 = [string]$verification.executionManifestSha256

function Resolve-McpV3Artifact {
    param([Parameter(Mandatory = $true)][string]$Id)
    $record = @($manifest.artifacts | Where-Object { [string]$_.id -eq $Id })
    if ($record.Count -ne 1) {
        throw "MCP V3 local release artifact is missing or duplicated: $Id"
    }
    return Resolve-McpPublicChildPath -Root $releaseRoot -RelativePath ([string]$record[0].path)
}

$launcherPath = Resolve-McpV3Artifact -Id 'node-host-launcher'
$nodePath = Resolve-McpV3Artifact -Id 'node-runtime'
$companionPath = Resolve-McpV3Artifact -Id 'local-companion-runtime'
$credentialBrokerPath = Resolve-McpV3Artifact -Id 'browser-credential-broker'
$elevationBrokerPath = Resolve-McpV3Artifact -Id 'elevation-broker'

foreach ($signedPath in @($launcherPath, $credentialBrokerPath, $elevationBrokerPath)) {
    Assert-McpWindowsExecutionNodeSignature -Path $signedPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
}

$configPath = Join-Path $state 'config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "MCP V3 local config was not found: $configPath"
}
$logs = Join-Path $state 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$stdoutLog = Join-Path $logs 'mcp-v3-local.stdout.log'
$stderrLog = Join-Path $logs 'mcp-v3-local.stderr.log'

$arguments = [System.Collections.Generic.List[string]]::new()
foreach ($value in @(
    '--node', (Quote-McpV3LocalTaskArgument $nodePath),
    '--stdout-log', (Quote-McpV3LocalTaskArgument $stdoutLog),
    '--stderr-log', (Quote-McpV3LocalTaskArgument $stderrLog),
    '--runner-restart-count', '5',
    '--runner-restart-interval-seconds', '60',
    '--env', (Quote-McpV3LocalTaskArgument ("MCP_V3_RELEASE_ROOT=$releaseRoot")),
    '--env', (Quote-McpV3LocalTaskArgument ("MCP_V3_STATE_ROOT=$state")),
    '--env', (Quote-McpV3LocalTaskArgument ("MCP_V3_CONFIG_PATH=$configPath")),
    '--env', (Quote-McpV3LocalTaskArgument ("MCP_V3_CREDENTIAL_BROKER_PATH=$credentialBrokerPath")),
    '--env', (Quote-McpV3LocalTaskArgument ("MCP_V3_ELEVATION_BROKER_PATH=$elevationBrokerPath")),
    '--', (Quote-McpV3LocalTaskArgument $companionPath)
)) {
    $arguments.Add([string]$value)
}
$argumentText = $arguments -join ' '

$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ([string]::IsNullOrWhiteSpace($userId)) {
    throw 'Current Windows user identity could not be resolved.'
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$alreadyInstalled = $false
if ($existing) {
    $actions = @($existing.Actions)
    $matches = $actions.Count -eq 1 -and
        [IO.Path]::GetFullPath([string]$actions[0].Execute) -eq [IO.Path]::GetFullPath($launcherPath) -and
        [string]$actions[0].Arguments -eq $argumentText -and
        [string]$actions[0].WorkingDirectory -eq $releaseRoot -and
        (Test-McpWindowsAccountIdentityEquivalent -Left ([string]$existing.Principal.UserId) -Right $userId) -and
        [string]$existing.Principal.LogonType -in @('Interactive', 'InteractiveToken') -and
        [string]$existing.Principal.RunLevel -eq 'Limited'
    if ($matches) {
        $alreadyInstalled = $true
    }
    elseif (-not $Force) {
        throw "Scheduled Task exists with a different MCP V3 local contract: $TaskName"
    }
    elseif ([string]$existing.State -eq 'Running') {
        throw "Scheduled Task is running and must be stopped before replacement: $TaskName"
    }
}

if (-not $alreadyInstalled) {
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
    $action = New-ScheduledTaskAction -Execute $launcherPath -Argument $argumentText -WorkingDirectory $releaseRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    if ($DelaySeconds -gt 0) {
        $trigger.Delay = 'PT{0}S' -f $DelaySeconds
    }
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Runs the per-user MCP V3 local companion. OAuth and repository state remain user-scoped.'
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
}

$null = Set-McpWindowsScheduledTaskOwnerAccess -TaskName $TaskName -UserId $userId
if ($Activate) {
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
}
else {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
}

[pscustomobject]@{
    status = if ($alreadyInstalled) { 'already-installed' } else { 'installed' }
    changed = -not $alreadyInstalled
    activated = [bool]$Activate
    taskName = $TaskName
    releaseId = $ReleaseId
    executionManifestSha256 = $manifestSha256
    userId = $userId
    runLevel = 'Limited'
    logonType = 'Interactive'
    stateRoot = $state
} | ConvertTo-Json -Compress
