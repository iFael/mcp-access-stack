[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'iFael/mcp-access-stack',

    [string]$InstallationRoot,
    [string]$StateRoot,
    [string]$TaskName = 'MCP V3 local companion',
    [string]$Tag,

    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'MCP V3 local update is intentionally gated. Re-run with -Execute.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required MCP V3 local updater dependency is missing: $bootstrapPath"
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

if ([string]::IsNullOrWhiteSpace([string]$env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is required for the per-user MCP V3 local updater.'
}
$defaultStateRoot = Join-Path $env:LOCALAPPDATA 'MCP V3'
$state = [IO.Path]::GetFullPath($(if ([string]::IsNullOrWhiteSpace($StateRoot)) { $defaultStateRoot } else { $StateRoot }))
$installation = [IO.Path]::GetFullPath($(if ([string]::IsNullOrWhiteSpace($InstallationRoot)) { Join-Path $state 'App' } else { $InstallationRoot }))
if (-not (Test-Path -LiteralPath $installation -PathType Container)) {
    throw "MCP V3 local installation root was not found: $installation"
}

$statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $installation
$currentState = Read-McpWindowsExecutionNodeState -Path $statePath
if ($null -eq $currentState -or $null -eq $currentState.active) {
    throw 'MCP V3 local updater requires an active installed release.'
}
$currentReleaseId = [string]$currentState.active.releaseId

$headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'mcp-v3-local-updater'
    'X-GitHub-Api-Version' = '2022-11-28'
}
$resolvedTag = $Tag
if ([string]::IsNullOrWhiteSpace($resolvedTag)) {
    $latest = Invoke-RestMethod -Uri ("https://api.github.com/repos/{0}/releases/latest" -f $Repository) -Headers $headers
    $resolvedTag = [string]$latest.tag_name
}
if ($resolvedTag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z.-]+)?$') {
    throw "Resolved MCP V3 release tag is invalid: $resolvedTag"
}
$expectedReleaseId = $resolvedTag.Substring(1)
if ($currentReleaseId -eq $expectedReleaseId) {
    [pscustomobject]@{
        status = 'up-to-date'
        releaseId = $currentReleaseId
        taskName = $TaskName
    } | ConvertTo-Json -Compress
    return
}

$genericUpdater = Join-Path $PSScriptRoot 'Update-McpAccessStack.ps1'
$switchScript = Join-Path $PSScriptRoot 'Invoke-McpV3LocalReleaseSwitch.ps1'
foreach ($scriptPath in @($genericUpdater, $switchScript)) {
    Assert-McpPublicSignature -Path $scriptPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
}

$prepared = & $genericUpdater -Repository $Repository -InstallationRoot $installation -Tag $resolvedTag -Execute -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
if ($prepared.candidatePrepared -ne $true -or [string]$prepared.releaseId -ne $expectedReleaseId) {
    throw 'MCP V3 local updater did not prepare the expected signed release.'
}

$switchResult = & $switchScript -InstallationRoot $installation -StateRoot $state -TargetReleaseId $expectedReleaseId -TaskName $TaskName -Execute -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
if ([string]$switchResult.status -ne 'active' -or [string]$switchResult.releaseId -ne $expectedReleaseId) {
    throw 'MCP V3 local updater failed to activate the prepared release.'
}

[pscustomobject]@{
    status = 'updated'
    previousReleaseId = $currentReleaseId
    releaseId = $expectedReleaseId
    taskName = $TaskName
    taskRunning = [bool]$switchResult.taskRunning
} | ConvertTo-Json -Compress
