[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('mcp-release-state-test-' + [guid]::NewGuid().ToString('N'))
$releaseId = '2026-07-25.test123'
$releaseRoot = Join-Path $tempRoot "releases\$releaseId"
$manifestPath = Join-Path $releaseRoot 'manifest.json'

try {
    New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
    $manifest = [ordered]@{
        releaseId = $releaseId
        commit = '1234567890abcdef1234567890abcdef12345678'
        builtAt = [DateTimeOffset]::UtcNow.ToString('O')
        nodeVersion = 'v24.0.0'
        testsPassed = $true
        dirty = $false
        source = 'clean-git-snapshot'
        fileHashes = @()
    }
    Write-McpJsonFile -Path $manifestPath -Value $manifest

    $candidate = [ordered]@{
        version = 1
        releaseId = $releaseId
        path = $releaseRoot
        commit = [string]$manifest.commit
        builtAt = [string]$manifest.builtAt
    }
    Write-McpReleasePointer -Name 'candidate' -Root $tempRoot -Value $candidate
    $loaded = Read-McpReleasePointer -Name 'candidate' -Root $tempRoot
    $eligible = Assert-McpReleasePointerEligible -Pointer $loaded -Root $tempRoot
    if ([string]$eligible.releaseId -ne $releaseId) {
        throw 'Eligible release pointer returned an unexpected release ID.'
    }

    $fakeTask = [pscustomobject]@{
        Actions = @([pscustomobject]@{
            WorkingDirectory = $releaseRoot
            Arguments = "`"$releaseRoot\deploy\docker\scripts\Run-DockerHostComponent.mjs`" --task-owned true --release-root `"$releaseRoot`""
        })
    }
    if ((Get-McpScheduledTaskReleaseId -Task $fakeTask) -ne $releaseId) {
        throw 'Scheduled task release extraction failed.'
    }

    $directRuntimeTask = [pscustomobject]@{
        Actions = @([pscustomobject]@{
            Arguments = '--node "C:\Runtime\v24.10.0\node.exe" -- runner.mjs'
        })
    }
    $directRuntime = Get-McpScheduledTaskNodeRuntimeDescriptor -Task $directRuntimeTask
    if (
        [string]$directRuntime.mode -ne 'direct-pinned' -or
        [string]$directRuntime.nodePath -ne 'C:\Runtime\v24.10.0\node.exe'
    ) {
        throw 'Direct-pinned scheduled task Node runtime detection failed.'
    }

    $managedRuntimeTask = [pscustomobject]@{
        Actions = @([pscustomobject]@{
            Arguments = '--node-runtime-root "C:\Runtime" --node-release-id 2026-08-07.test123 -- runner.mjs'
        })
    }
    $managedRuntime = Get-McpScheduledTaskNodeRuntimeDescriptor -Task $managedRuntimeTask
    if (
        [string]$managedRuntime.mode -ne 'managed' -or
        [string]$managedRuntime.runtimeRoot -ne 'C:\Runtime' -or
        [string]$managedRuntime.releaseId -ne '2026-08-07.test123'
    ) {
        throw 'Managed scheduled task Node runtime detection failed.'
    }

    $invalidRuntimeTask = [pscustomobject]@{
        Actions = @([pscustomobject]@{
            Arguments = '--node "C:\Runtime\v24.10.0\node.exe" --node-runtime-root "C:\Runtime" --node-release-id mixed -- runner.mjs'
        })
    }
    if ([string](Get-McpScheduledTaskNodeRuntimeDescriptor -Task $invalidRuntimeTask).mode -ne 'invalid') {
        throw 'Mixed direct/managed Node runtime configuration was not rejected.'
    }

    $outsideRoot = Join-Path $tempRoot 'outside-release'
    New-Item -ItemType Directory -Force -Path $outsideRoot | Out-Null
    Write-McpJsonFile -Path (Join-Path $outsideRoot 'manifest.json') -Value $manifest
    $outsideRejected = $false
    try {
        Assert-McpReleasePointerEligible -Root $tempRoot -Pointer ([pscustomobject]@{
            releaseId = $releaseId
            path = $outsideRoot
            commit = [string]$manifest.commit
        }) | Out-Null
    }
    catch {
        $outsideRejected = $true
    }
    if (-not $outsideRejected) {
        throw 'Release pointer outside releases directory was accepted.'
    }

    $manifest.dirty = $true
    Write-McpJsonFile -Path $manifestPath -Value $manifest
    $dirtyRejected = $false
    try {
        Assert-McpReleasePointerEligible -Pointer $loaded -Root $tempRoot | Out-Null
    }
    catch {
        $dirtyRejected = $true
    }
    if (-not $dirtyRejected) {
        throw 'Dirty release manifest was accepted.'
    }

    $manifest.dirty = $false
    $validCiRun = [pscustomobject]@{
        databaseId = 123456789
        headSha = [string]$manifest.commit
        status = 'completed'
        conclusion = 'success'
        workflowName = 'CI'
        event = 'push'
        headBranch = 'main'
        url = 'https://github.com/example/repository/actions/runs/123456789'
    }
    $attestation = Assert-McpGitHubCiRunEvidence -Run $validCiRun -RunId 123456789 -ExpectedCommit ([string]$manifest.commit)
    if (
        [string]$attestation.mode -ne 'github-actions' -or
        [long]$attestation.runId -ne 123456789 -or
        [string]$attestation.headSha -ne [string]$manifest.commit -or
        [string]$attestation.conclusion -ne 'success'
    ) {
        throw 'Valid GitHub CI evidence did not produce a canonical attestation.'
    }

    foreach ($invalidRun in @(
        [pscustomobject]@{ databaseId = 123456789; headSha = ('0' * 40); status = 'completed'; conclusion = 'success'; workflowName = 'CI'; event = 'push'; headBranch = 'main'; url = $validCiRun.url },
        [pscustomobject]@{ databaseId = 123456789; headSha = $validCiRun.headSha; status = 'in_progress'; conclusion = ''; workflowName = 'CI'; event = 'push'; headBranch = 'main'; url = $validCiRun.url },
        [pscustomobject]@{ databaseId = 123456789; headSha = $validCiRun.headSha; status = 'completed'; conclusion = 'success'; workflowName = 'Other'; event = 'push'; headBranch = 'main'; url = $validCiRun.url },
        [pscustomobject]@{ databaseId = 123456789; headSha = $validCiRun.headSha; status = 'completed'; conclusion = 'success'; workflowName = 'CI'; event = 'pull_request'; headBranch = 'main'; url = $validCiRun.url },
        [pscustomobject]@{ databaseId = 123456789; headSha = $validCiRun.headSha; status = 'completed'; conclusion = 'success'; workflowName = 'CI'; event = 'push'; headBranch = 'feature'; url = $validCiRun.url }
    )) {
        $rejected = $false
        try {
            Assert-McpGitHubCiRunEvidence -Run $invalidRun -RunId 123456789 -ExpectedCommit ([string]$manifest.commit) | Out-Null
        }
        catch {
            $rejected = $true
        }
        if (-not $rejected) {
            throw 'Invalid GitHub CI evidence was accepted.'
        }
    }

    $manifest.testsPassed = $true
    $manifest['validation'] = $attestation
    Write-McpJsonFile -Path $manifestPath -Value $manifest
    $remoteEligible = Assert-McpReleasePointerEligible -Pointer $loaded -Root $tempRoot
    if ([string]$remoteEligible.releaseId -ne $releaseId) {
        throw 'GitHub-attested release was not considered eligible.'
    }

    $manifest.validation['headSha'] = ('0' * 40)
    Write-McpJsonFile -Path $manifestPath -Value $manifest
    $mismatchedAttestationRejected = $false
    try {
        Assert-McpReleasePointerEligible -Pointer $loaded -Root $tempRoot | Out-Null
    }
    catch {
        $mismatchedAttestationRejected = $true
    }
    if (-not $mismatchedAttestationRejected) {
        throw 'Release eligibility accepted GitHub evidence for a different commit.'
    }

    $manifest.testsPassed = $false
    $manifest['validation'] = [ordered]@{
        mode = 'build-only'
        command = 'npm run build'
        verifiedAt = [DateTimeOffset]::UtcNow.ToString('O')
    }
    Write-McpJsonFile -Path $manifestPath -Value $manifest
    $buildOnlyRejected = $false
    try {
        Assert-McpReleasePointerEligible -Pointer $loaded -Root $tempRoot | Out-Null
    }
    catch {
        $buildOnlyRejected = $true
    }
    if (-not $buildOnlyRejected) {
        throw 'Build-only release was accepted as production eligible.'
    }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$newRelease = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'New-McpRelease.ps1')
$installer = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Install-McpHostTasks.ps1')
$status = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Get-DockerProductionStatus.ps1')
$initializer = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Initialize-McpReleaseState.ps1')
$activator = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Activate-McpCandidateRelease.ps1')

if ($newRelease -notmatch "Write-McpReleasePointer -Name 'candidate'" -or $newRelease -match 'releases\\current\.json') {
    throw 'Release generation must update only the candidate pointer.'
}
foreach ($requiredReleaseContract in @(
    'GitHubCiRunId',
    'Get-McpGitHubCiAttestation',
    'validation = $validationEvidence',
    'if ($manifest.testsPassed -eq $true -and $manifest.dirty -ne $true)',
    'Candidate release pointer was not changed because the release lacks production-eligible validation evidence.'
)) {
    if (-not $newRelease.Contains($requiredReleaseContract)) {
        throw "Release generation is missing validation contract: $requiredReleaseContract"
    }
}
if ($installer -notmatch 'requires an explicit -ReleaseRoot' -or $installer -match 'releases\\current\.json') {
    throw 'Production task installation must require an explicit immutable release root.'
}
foreach ($requiredStatusLabel in @('Active release', 'Candidate release', 'Container release', 'Agent task release', 'Browser process release', 'Agent task executable', 'Agent ownership', 'Browser task executable', 'Browser ownership')) {
    if (-not $status.Contains($requiredStatusLabel)) {
        throw "Production status is missing release label: $requiredStatusLabel"
    }
}
foreach ($requiredNodeStatusLabel in @('Node runtime mode', 'Node task runtime', 'Node known-good runtime', 'Node rollback runtime', 'Node updater task')) {
    if (-not $status.Contains($requiredNodeStatusLabel)) {
        throw "Production status is missing Node runtime label: $requiredNodeStatusLabel"
    }
}
if (-not $status.Contains("'direct-pinned'") -or -not $status.Contains("'not-applicable'")) {
    throw 'Production status does not distinguish legacy direct-pinned Node runtime from managed runtime state.'
}
if (-not $status.Contains("PSObject.Properties['Response']")) {
    throw 'Production status must handle connection failures safely under strict mode.'
}
if (-not $status.Contains('[DateTimeOffset]$lease.updatedAtUtc') -or $status.Contains('DateTimeOffset]::Parse([string]$lease.updatedAtUtc')) {
    throw 'Production status must preserve typed lease timestamps without culture-sensitive string parsing.'
}
if ($initializer -notmatch '\[switch\]\$Execute' -or $initializer -notmatch 'scheduled-task-migration') {
    throw 'Release state initializer must be gated and derive active state from scheduled tasks.'
}
if ($activator -notmatch '\[switch\]\$Execute' -or $activator -notmatch 'candidate-activation') {
    throw 'Candidate activation must be gated and explicit.'
}

Write-Output 'Release state test passed: active/candidate pointers and direct/managed Node runtime status are operationally observable.'
