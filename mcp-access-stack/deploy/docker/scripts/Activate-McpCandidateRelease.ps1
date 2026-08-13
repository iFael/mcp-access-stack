[CmdletBinding()]
param(
    [switch]$Execute,
    [string]$ExpectedReleaseId
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not $Execute) {
    throw 'Candidate activation is intentionally gated. Re-run with -Execute.'
}

$root = Get-McpProjectRoot
$candidate = Read-McpReleasePointer -Name 'candidate' -Root $root
$eligible = Assert-McpReleasePointerEligible -Pointer $candidate -Root $root
if ($ExpectedReleaseId -and [string]$eligible.releaseId -ne $ExpectedReleaseId) {
    throw 'Candidate release does not match the expected release ID.'
}

$previousActive = Read-McpReleasePointer -Name 'active' -Root $root -AllowMissing
if ($previousActive) {
    Assert-McpReleasePointerEligible -Pointer $previousActive -Root $root | Out-Null
}

$active = [ordered]@{
    version = 1
    releaseId = [string]$eligible.releaseId
    path = [string]$eligible.path
    commit = [string]$eligible.commit
    builtAt = [string]$eligible.manifest.builtAt
    activatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    source = 'candidate-activation'
}
Write-McpReleasePointer -Name 'active' -Root $root -Value $active

[pscustomobject]@{
    activeReleaseId = [string]$active.releaseId
    previousActiveReleaseId = if ($previousActive) { [string]$previousActive.releaseId } else { $null }
} | ConvertTo-Json -Compress
