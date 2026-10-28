[CmdletBinding()]
param(
    [string]$InstallationRoot,
    [string]$StateRoot,

    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'iFael/mcp-access-stack',

    [string]$CompanionTaskName = 'MCP V3 local companion',
    [string]$UpdaterTaskName = 'MCP V3 local updater',

    [ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z.-]+)?$')]
    [string]$Tag,

    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'MCP V3 local update handoff is intentionally gated. Re-run with -Execute.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required MCP V3 update handoff dependency is missing: $bootstrapPath"
    }
}

. $publicCommonPath
Assert-McpPublicFile -Path $publicCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicFile -Path $executionCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
. $executionCommonPath
Assert-McpPublicWindowsX64

$defaultStateRoot = Get-McpV3LocalDefaultStateRoot
$state = [IO.Path]::GetFullPath($(if ([string]::IsNullOrWhiteSpace($StateRoot)) { $defaultStateRoot } else { $StateRoot }))
$installation = [IO.Path]::GetFullPath($(if ([string]::IsNullOrWhiteSpace($InstallationRoot)) { Join-Path $state 'App' } else { $InstallationRoot }))
if (-not (Test-Path -LiteralPath $installation -PathType Container)) {
    throw "MCP V3 local installation root was not found: $installation"
}

$statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $installation
$currentState = Read-McpWindowsExecutionNodeState -Path $statePath
if ($null -eq $currentState -or $null -eq $currentState.active) {
    throw 'MCP V3 update handoff requires an active installed release.'
}

$requestPath = Join-Path $state 'update-request.v1.json'
if (Test-Path -LiteralPath $requestPath) {
    throw 'An MCP V3 local update request is already pending.'
}

# The companion runs this script as its own child. Bitdefender's Advanced
# Threat Control kills a node process whose child registers, enables or starts
# a Scheduled Task, so this handoff only reads the updater task and writes the
# request. Task Scheduler starts the updater task every few minutes and it
# picks the request up; the person can also run it from Task Scheduler.
$existingTask = Get-ScheduledTask -TaskName $UpdaterTaskName -ErrorAction SilentlyContinue
$reinstall = "Install it once from the Windows console: Install-McpV3LocalUpdateTask.ps1 -InstallationRoot '$installation' -StateRoot '$state' -Execute -Force"
if (-not $existingTask) {
    throw "MCP V3 updater task is missing: $UpdaterTaskName. $reinstall"
}
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if (-not (Test-McpWindowsAccountIdentityEquivalent -Left ([string]$existingTask.Principal.UserId) -Right $currentUser)) {
    throw "Refusing to use MCP V3 updater task owned by another user: $UpdaterTaskName"
}
if (-not [bool]$existingTask.Settings.Enabled) {
    throw "MCP V3 updater task is disabled, so it cannot pick up update requests: $UpdaterTaskName. $reinstall"
}
$updaterActions = @($existingTask.Actions)
if ($updaterActions.Count -ne 1 -or
    [string]$updaterActions[0].Arguments -notlike '*-File "*\updater\Invoke-McpV3LocalActiveUpdater.ps1"') {
    throw "MCP V3 updater task predates update request pickup: $UpdaterTaskName. $reinstall"
}
if ([string]$existingTask.State -eq 'Running') {
    throw 'The MCP V3 local updater task is already running.'
}

$operationId = [guid]::NewGuid().ToString('N')
$updatesRoot = Join-Path $state 'updates'
New-Item -ItemType Directory -Force -Path $updatesRoot | Out-Null
$resultPath = Join-Path $updatesRoot ("result-$operationId.json")
$request = [ordered]@{
    version = 1
    operationId = $operationId
    tag = if ([string]::IsNullOrWhiteSpace($Tag)) { $null } else { $Tag }
    restoreEnabled = $true
    requestedAt = [DateTimeOffset]::UtcNow.ToString('O')
}
$requestCreated = $false

try {
    $requestJson = ($request | ConvertTo-Json -Depth 4) + [Environment]::NewLine
    $requestBytes = [Text.UTF8Encoding]::new($false).GetBytes($requestJson)
    try {
        $stream = [IO.File]::Open(
            $requestPath,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
        try {
            $stream.Write($requestBytes, 0, $requestBytes.Length)
            $stream.Flush($true)
            $requestCreated = $true
        }
        finally {
            $stream.Dispose()
        }
    }
    catch [IO.IOException] {
        throw 'An MCP V3 local update request is already pending.'
    }

}
catch {
    if ($requestCreated) {
        Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    }
    throw
}

[pscustomobject]@{
    status = 'accepted'
    operationId = $operationId
    tag = if ([string]::IsNullOrWhiteSpace($Tag)) { $null } else { $Tag }
    taskName = $UpdaterTaskName
    resultPath = $resultPath
    activeReleaseId = [string]$currentState.active.releaseId
} | ConvertTo-Json -Compress
