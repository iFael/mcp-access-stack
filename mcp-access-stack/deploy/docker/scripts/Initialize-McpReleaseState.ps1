[CmdletBinding()]
param(
    [switch]$Execute,
    [switch]$Force,
    [string]$TaskPrefix = 'MCP Access Stack Docker'
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not $Execute) {
    throw 'Release state initialization is intentionally gated. Re-run with -Execute.'
}

$root = Get-McpProjectRoot
$legacyCurrentPath = Join-Path $root 'releases\current.json'
$active = Read-McpReleasePointer -Name 'active' -Root $root -AllowMissing
$candidate = Read-McpReleasePointer -Name 'candidate' -Root $root -AllowMissing

if ($active -and -not $Force) {
    Assert-McpReleasePointerEligible -Pointer $active -Root $root | Out-Null
}
else {
    $agentTask = Get-ScheduledTask -TaskName "$TaskPrefix production agent" -ErrorAction Stop
    $browserTask = Get-ScheduledTask -TaskName "$TaskPrefix production browser-worker" -ErrorAction Stop
    $agentReleaseId = Get-McpScheduledTaskReleaseId -Task $agentTask
    $browserReleaseId = Get-McpScheduledTaskReleaseId -Task $browserTask
    if (-not $agentReleaseId -or -not $browserReleaseId) {
        throw 'Production tasks do not reference immutable releases.'
    }
    if ($agentReleaseId -ne $browserReleaseId) {
        throw 'Production Agent and Browser Worker tasks reference different releases.'
    }

    $releaseRoot = Join-Path $root "releases\$agentReleaseId"
    $manifest = Read-McpJsonFile -Path (Join-Path $releaseRoot 'manifest.json')
    $eligible = Assert-McpReleasePointerEligible -Root $root -Pointer ([pscustomobject]@{
        releaseId = $agentReleaseId
        path = $releaseRoot
        commit = [string]$manifest.commit
    })
    $active = [ordered]@{
        version = 1
        releaseId = [string]$eligible.releaseId
        path = [string]$eligible.path
        commit = [string]$eligible.commit
        builtAt = [string]$eligible.manifest.builtAt
        activatedAt = [DateTimeOffset]::UtcNow.ToString('O')
        source = 'scheduled-task-migration'
    }
    Write-McpReleasePointer -Name 'active' -Root $root -Value $active
}

if ($candidate -and -not $Force) {
    Assert-McpReleasePointerEligible -Pointer $candidate -Root $root | Out-Null
}
else {
    $legacy = if (Test-Path -LiteralPath $legacyCurrentPath -PathType Leaf) {
        Read-McpJsonFile -Path $legacyCurrentPath
    }
    else {
        $active
    }
    $eligibleCandidate = Assert-McpReleasePointerEligible -Pointer $legacy -Root $root
    $candidate = [ordered]@{
        version = 1
        releaseId = [string]$eligibleCandidate.releaseId
        path = [string]$eligibleCandidate.path
        commit = [string]$eligibleCandidate.commit
        builtAt = [string]$eligibleCandidate.manifest.builtAt
        source = if (Test-Path -LiteralPath $legacyCurrentPath -PathType Leaf) { 'legacy-current-migration' } else { 'active-fallback' }
    }
    Write-McpReleasePointer -Name 'candidate' -Root $root -Value $candidate
}

[pscustomobject]@{
    activeReleaseId = [string]$active.releaseId
    candidateReleaseId = [string]$candidate.releaseId
    legacyCurrentPreserved = (Test-Path -LiteralPath $legacyCurrentPath -PathType Leaf)
} | ConvertTo-Json -Compress
