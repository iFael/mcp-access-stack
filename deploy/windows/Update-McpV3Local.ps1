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
    throw 'MCP V3 local updater requires an active installed release.'
}
$currentReleaseId = [string]$currentState.active.releaseId

$resolvedTag = $Tag
if ([string]::IsNullOrWhiteSpace($resolvedTag)) {
    $activeReleaseRoot = Join-Path $installation ("releases\$currentReleaseId")
    $null = Assert-McpWindowsExecutionNodeRelease -ReleaseRoot $activeReleaseRoot -ExpectedReleaseId $currentReleaseId -AllowLegacyInstalledFormat -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    $node = Join-Path $activeReleaseRoot 'runtime\node\node.exe'
    $selector = Join-Path $activeReleaseRoot 'deploy\common\select-mcp-v3-release.mjs'
    foreach ($required in @($node, $selector)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw 'The active signed release lacks the unified version selector.'
        }
    }
    $channel = if ($currentReleaseId -match '-companion\.[1-9][0-9]*$') { 'companion' } elseif ($currentReleaseId.Contains('-')) { 'prerelease' } else { 'stable' }
    $selected = @(& $node $selector $Repository $channel '-windows-x64.zip' $currentReleaseId)
    if ($LASTEXITCODE -ne 0) {
        throw 'Release catalog selection failed; installation state was not changed.'
    }
    $resolvedTag = ($selected -join '').Trim()
}
if ([string]::IsNullOrWhiteSpace($resolvedTag)) {
    [pscustomobject]@{status='up-to-date';releaseId=$currentReleaseId;taskName=$TaskName} | ConvertTo-Json -Compress
    return
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

$targetReleaseRoot = Join-Path $installation ("releases\$expectedReleaseId")

# prepare_release already staged and hashed this candidate: promote goes
# straight to the switch, which verifies it again, instead of downloading and
# staging it a second time.
$alreadyStaged = $null -ne $currentState.candidate -and
    [string]$currentState.candidate.releaseId -eq $expectedReleaseId -and
    (Test-Path -LiteralPath $targetReleaseRoot -PathType Container)
if (-not $alreadyStaged) {
    $genericUpdater = Join-Path $PSScriptRoot 'Update-McpAccessStack.ps1'
    Assert-McpPublicFile -Path $genericUpdater -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

    $prepared = & $genericUpdater -Repository $Repository -InstallationRoot $installation -Tag $resolvedTag -Execute -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
    if ($prepared.candidatePrepared -ne $true -or [string]$prepared.releaseId -ne $expectedReleaseId) {
        throw 'MCP V3 local updater did not prepare the expected signed release.'
    }
}
$switchScript = Join-Path $targetReleaseRoot 'deploy\windows\Invoke-McpV3LocalReleaseSwitch.ps1'
Assert-McpPublicFile -Path $switchScript -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

$switchResult = & $switchScript -InstallationRoot $installation -StateRoot $state -TargetReleaseId $expectedReleaseId -TaskName $TaskName -Execute -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
if ([string]$switchResult.status -ne 'active' -or [string]$switchResult.releaseId -ne $expectedReleaseId) {
    throw 'MCP V3 local updater failed to activate the prepared release.'
}

# Retire old, verified local release folders only after the new task passed
# the existing handover and startup health checks. Retention never masks a
# successful switch and never deletes active/previous/candidate releases.
$retentionStatus = 'deferred'
if ([bool]$switchResult.taskRunning) {
    try {
        $activeNode = Join-Path $targetReleaseRoot 'runtime\node\node.exe'
        $retentionScript = Join-Path $targetReleaseRoot 'deploy\common\prune-mcp-v3-local.mjs'
        if (-not (Test-Path -LiteralPath $activeNode -PathType Leaf) -or
            -not (Test-Path -LiteralPath $retentionScript -PathType Leaf)) {
            throw 'Signed local retention prerequisites are missing.'
        }
        $doneOutput = @(& $activeNode $retentionScript --drain $installation $expectedReleaseId $currentReleaseId)
        if ($LASTEXITCODE -ne 0) { throw 'Local retention execution requires reconciliation.' }
        $done = $doneOutput -join '' | ConvertFrom-Json
        if ([string]$done.status -ne 'completed') {
            throw 'Local retention completion is unverified.'
        }
        $retentionStatus = 'completed'
    }
    catch {
        $retentionStatus = 'deferred'
    }
}

[pscustomobject]@{
    status = 'updated'
    retentionStatus = $retentionStatus
    previousReleaseId = $currentReleaseId
    releaseId = $expectedReleaseId
    taskName = $TaskName
    taskRunning = [bool]$switchResult.taskRunning
} | ConvertTo-Json -Compress
