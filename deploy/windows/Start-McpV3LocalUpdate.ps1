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

$existingTask = Get-ScheduledTask -TaskName $UpdaterTaskName -ErrorAction SilentlyContinue
if ($existingTask -and [string]$existingTask.State -eq 'Running') {
    throw 'The MCP V3 local updater task is already running.'
}
$restoreEnabled = $false
if ($existingTask) {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if (-not (Test-McpWindowsAccountIdentityEquivalent -Left ([string]$existingTask.Principal.UserId) -Right $currentUser)) {
        throw "Refusing to use MCP V3 updater task owned by another user: $UpdaterTaskName"
    }
    $restoreEnabled = [bool]$existingTask.Settings.Enabled
}

$installer = Join-Path $PSScriptRoot 'Install-McpV3LocalUpdateTask.ps1'
Assert-McpPublicSignature -Path $installer -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
$installed = & $installer `
    -InstallationRoot $installation `
    -StateRoot $state `
    -Repository $Repository `
    -CompanionTaskName $CompanionTaskName `
    -TaskName $UpdaterTaskName `
    -Execute `
    -Force `
    -Activate:$restoreEnabled `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
if ([string]$installed.taskName -ne $UpdaterTaskName) {
    throw 'MCP V3 updater task installation returned unexpected evidence.'
}

$operationId = [guid]::NewGuid().ToString('N')
$updatesRoot = Join-Path $state 'updates'
New-Item -ItemType Directory -Force -Path $updatesRoot | Out-Null
$resultPath = Join-Path $updatesRoot ("result-$operationId.json")
$request = [ordered]@{
    version = 1
    operationId = $operationId
    tag = if ([string]::IsNullOrWhiteSpace($Tag)) { $null } else { $Tag }
    restoreEnabled = $restoreEnabled
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

    $task = Get-ScheduledTask -TaskName $UpdaterTaskName -ErrorAction Stop
    if (-not [bool]$task.Settings.Enabled) {
        Enable-ScheduledTask -TaskName $UpdaterTaskName | Out-Null
    }
    Start-ScheduledTask -TaskName $UpdaterTaskName
}
catch {
    if ($requestCreated) {
        Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    }
    if (-not $restoreEnabled) {
        Disable-ScheduledTask -TaskName $UpdaterTaskName -ErrorAction SilentlyContinue | Out-Null
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
