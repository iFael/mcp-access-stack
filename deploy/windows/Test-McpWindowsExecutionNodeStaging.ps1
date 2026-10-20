[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$stager = Join-Path $PSScriptRoot 'Stage-McpWindowsExecutionNodeCandidate.ps1'

function Get-TestRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Test path must stay below root. root=$resolvedRoot path=$resolvedPath"
    }
    return $resolvedPath.Substring($resolvedRoot.Length)
}

function Write-TestUtf8 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )
    $directory = Split-Path -Parent $Path
    if ($directory) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    [IO.File]::WriteAllText(
        [IO.Path]::GetFullPath($Path),
        $Content,
        [Text.UTF8Encoding]::new($false)
    )
}

function Write-TestDataScript {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )
    $json = $Value | ConvertTo-Json -Depth 24 -Compress
    $base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    Write-TestUtf8 -Path $Path -Content (
        '$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(''' +
        $base64 +
        '''))' + [Environment]::NewLine +
        '$json | ConvertFrom-Json' + [Environment]::NewLine
    )
}

function New-TestDistribution {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [Parameter(Mandatory = $true)][string]$Commit,
        [switch]$LegacyFormat
    )

    $release = Join-Path $Root "releases\$ReleaseId"
    foreach ($relative in @(
        'native\McpEdgeHost.exe',
        'compat\McpNodeHostLauncher.exe',
        'compat\McpCredentialBroker.exe',
        'native\McpElevationBroker.exe',
        'services\browser-worker\dist\server.js',
        'node_modules\@vs-code-gpt\remote-mcp-gateway\dist\edge-connector-cli.js',
        'node_modules\@vs-code-gpt\remote-mcp-gateway\dist\companion-cli.js',
        'deploy\windows\Start-McpEdgeConnector.ps1',
        'runtime\node\node.exe'
    )) {
        Write-TestUtf8 `
            -Path (Join-Path $release $relative) `
            -Content "fixture:${ReleaseId}:$relative"
    }

    function New-ArtifactRecord {
        param(
            [Parameter(Mandatory = $true)][string]$Id,
            [Parameter(Mandatory = $true)][string]$Owner,
            [Parameter(Mandatory = $true)][string]$RelativePath,
            [Parameter(Mandatory = $true)][bool]$AuthenticodeRequired
        )
        $path = Join-Path $release ($RelativePath.Replace('/', '\'))
        $item = Get-Item -LiteralPath $path
        return [ordered]@{
            id = $Id
            owner = $Owner
            path = $RelativePath
            sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            sizeBytes = [long]$item.Length
            authenticodeRequired = $AuthenticodeRequired
        }
    }

    $executionManifest = [ordered]@{
        version = 2
        releaseId = $ReleaseId
        commit = $Commit
        platform = 'win32-x64'
        createdAt = '2026-09-13T00:00:00.000Z'
        runtimeMode = 'bundled-node'
        integrityRoot = 'sha256-distribution-manifest'
        services = @(
            [ordered]@{ id = 'edge-runtime'; entryArtifactId = 'edge-host' },
            [ordered]@{ id = 'browser-worker'; entryArtifactId = 'node-host-launcher' },
            [ordered]@{ id = 'local-companion'; entryArtifactId = 'node-host-launcher' }
        )
        artifacts = @(
            (New-ArtifactRecord 'edge-host' 'edge-runtime' 'native/McpEdgeHost.exe' $false),
            (New-ArtifactRecord 'edge-connector' 'edge-runtime' 'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js' $false),
            (New-ArtifactRecord 'edge-validation-launcher' 'edge-runtime' 'deploy/windows/Start-McpEdgeConnector.ps1' $false),
            (New-ArtifactRecord 'browser-worker-server' 'browser-worker' 'services/browser-worker/dist/server.js' $false),
            (New-ArtifactRecord 'local-companion-runtime' 'shared' 'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/companion-cli.js' $false),
            (New-ArtifactRecord 'node-host-launcher' 'shared' 'compat/McpNodeHostLauncher.exe' $false),
            (New-ArtifactRecord 'browser-credential-broker' 'browser-worker' 'compat/McpCredentialBroker.exe' $false),
            (New-ArtifactRecord 'elevation-broker' 'shared' 'native/McpElevationBroker.exe' $false),
            (New-ArtifactRecord 'node-runtime' 'shared' 'runtime/node/node.exe' $false)
        )
    }
    if ($LegacyFormat) {
        $executionManifest.integrityRoot = 'signed-distribution-manifest'
        foreach ($artifact in $executionManifest.artifacts) {
            if ($artifact.id -in @('edge-host', 'edge-validation-launcher',
                'node-host-launcher', 'browser-credential-broker', 'elevation-broker')) {
                $artifact.authenticodeRequired = $true
            }
        }
    }
    $executionManifestPath = Join-Path $release 'execution-node-manifest.json'
    Write-TestUtf8 `
        -Path $executionManifestPath `
        -Content (($executionManifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine)

    $releaseFiles = @(
        Get-ChildItem -LiteralPath $release -Recurse -File |
            Where-Object { $_.Name -notin @('manifest.json', 'release-attestation.ps1') } |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    path = (Get-TestRelativePath -Root $release -Path $_.FullName).Replace('\', '/')
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
    )
    $releaseManifest = [ordered]@{
        releaseId = $ReleaseId
        version = $ReleaseId
        commit = $Commit
        builtAt = '2026-09-13T00:00:00.000Z'
        nodeVersion = 'v26.7.0'
        testsPassed = $true
        dirty = $false
        executionNode = [ordered]@{
            schemaVersion = 2
            manifestPath = 'execution-node-manifest.json'
            manifestSha256 = (Get-FileHash -LiteralPath $executionManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        fileHashes = $releaseFiles
    }
    $releaseManifestPath = Join-Path $release 'manifest.json'
    Write-TestUtf8 `
        -Path $releaseManifestPath `
        -Content (($releaseManifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine)

    Write-TestDataScript -Path (Join-Path $release 'release-attestation.ps1') -Value ([ordered]@{
        schemaVersion = 2
        releaseId = $ReleaseId
        commit = $Commit
        createdAt = '2026-09-13T00:00:00.000Z'
        manifestSha256 = (Get-FileHash -LiteralPath $releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    })

    $distributionFiles = @(
        Get-ChildItem -LiteralPath $Root -Recurse -File |
            Where-Object { $_.Name -ne 'distribution-manifest.ps1' } |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    path = (Get-TestRelativePath -Root $Root -Path $_.FullName).Replace('\', '/')
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
    )
    Write-TestDataScript -Path (Join-Path $Root 'distribution-manifest.ps1') -Value ([ordered]@{
        schemaVersion = 2
        platform = 'windows-x64'
        releaseId = $ReleaseId
        version = $ReleaseId
        commit = $Commit
        createdAt = '2026-09-13T00:00:00.000Z'
        files = $distributionFiles
    })
}

function Invoke-TestStage {
    param(
        [Parameter(Mandatory = $true)][string]$DistributionRoot,
        [Parameter(Mandatory = $true)][string]$InstallationRoot,
        [string]$ExpectedReleaseId
    )
    $parameters = @{
        DistributionRoot = $DistributionRoot
        InstallationRoot = $InstallationRoot
        Execute = $true
        AllowUnsignedDevelopment = $true
    }
    if ($ExpectedReleaseId) {
        $parameters.ExpectedReleaseId = $ExpectedReleaseId
    }
    return (& $stager @parameters) | ConvertFrom-Json
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('mcp-stage-test-' + [guid]::NewGuid().ToString('N'))
try {
    $distribution = Join-Path $testRoot 'distribution'
    $installation = Join-Path $testRoot 'installation'
    $releaseId = '1.2.3-stage'
    New-TestDistribution -Root $distribution -ReleaseId $releaseId -Commit ('a' * 40)

    $first = Invoke-TestStage `
        -DistributionRoot $distribution `
        -InstallationRoot $installation `
        -ExpectedReleaseId $releaseId
    if (
        [string]$first.status -ne 'ready' -or
        $first.alreadyPrepared -ne $false -or
        $first.materialized -ne $true -or
        $first.activeChanged -ne $false
    ) {
        throw 'First candidate staging returned unexpected evidence.'
    }
    $statePath = Join-Path $installation 'state\lifecycle-state.v1.json'
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($null -ne $state.active -or [string]$state.candidate.releaseId -ne $releaseId) {
        throw 'Candidate staging changed active or failed to persist candidate.'
    }

    # Read-only Windows evidence must be derived from the actual staged bytes
    # and lifecycle pointer. It is NOT a prepareOperationId receipt.
    $reader = Join-Path $PSScriptRoot 'Get-McpWindowsExecutionNodeReadEvidence.ps1'
    $candidateRead = & $reader -InstallationRoot $installation -Mode Candidate `
        -ExpectedTag ("v" + $releaseId) -ExpectedCommit ('a' * 40) | ConvertFrom-Json
    if ($candidateRead.platform -ne 'windows' -or
        $candidateRead.kind -ne 'candidate' -or
        $candidateRead.scope -ne 'local_hash_integrity_only' -or
        $candidateRead.verifiedArtifactCount -ne 9 -or
        $candidateRead.state.candidate.releaseId -ne $releaseId -or
        $candidateRead.PSObject.Properties['prepareOperationId']) {
        throw 'Read-only candidate evidence was malformed or claimed an operation receipt.'
    }
    $stateRead = & $reader -InstallationRoot $installation -Mode State | ConvertFrom-Json
    if ($stateRead.kind -ne 'state' -or
        $stateRead.state.candidate.releaseId -ne $releaseId -or
        $stateRead.PSObject.Properties['releaseTag']) {
        throw 'Read-only Windows state leaked an invalid release identity.'
    }
    $tamperPath = Join-Path $installation (
        "releases\$releaseId\node_modules\@vs-code-gpt\remote-mcp-gateway\dist\edge-connector-cli.js"
    )
    $originalBytes = [IO.File]::ReadAllBytes($tamperPath)
    try {
        [IO.File]::AppendAllText($tamperPath, 'tampered')
        $readRejected = $false
        try {
            & $reader -InstallationRoot $installation -Mode Candidate `
                -ExpectedTag ("v" + $releaseId) -ExpectedCommit ('a' * 40) | Out-Null
        }
        catch { $readRejected = $true }
        if (-not $readRejected) { throw 'Windows reader accepted altered candidate bytes.' }
    }
    finally { [IO.File]::WriteAllBytes($tamperPath, $originalBytes) }

    $second = Invoke-TestStage -DistributionRoot $distribution -InstallationRoot $installation
    if ($second.alreadyPrepared -ne $true -or $second.activeChanged -ne $false) {
        throw 'Candidate staging is not idempotent.'
    }

    $tamperedDistribution = Join-Path $testRoot 'tampered'
    New-TestDistribution -Root $tamperedDistribution -ReleaseId '1.2.4-tampered' -Commit ('b' * 40)
    Add-Content `
        -LiteralPath (Join-Path $tamperedDistribution 'releases\1.2.4-tampered\node_modules\@vs-code-gpt\remote-mcp-gateway\dist\edge-connector-cli.js') `
        -Value 'tampered'
    $tamperRejected = $false
    try {
        Invoke-TestStage `
            -DistributionRoot $tamperedDistribution `
            -InstallationRoot (Join-Path $testRoot 'tampered-install') | Out-Null
    }
    catch {
        $tamperRejected = $_.Exception.Message -like '*hash mismatch*'
    }
    if (-not $tamperRejected) {
        throw 'Tampered distribution was not rejected.'
    }

    $overlapRejected = $false
    try {
        Invoke-TestStage `
            -DistributionRoot $distribution `
            -InstallationRoot (Join-Path $distribution 'installation') | Out-Null
    }
    catch {
        $overlapRejected = $_.Exception.Message -like '*must not overlap*'
    }
    if (-not $overlapRejected) {
        throw 'Overlapping distribution and installation roots were not rejected.'
    }

    $lockedDistribution = Join-Path $testRoot 'locked'
    $lockedInstallation = Join-Path $testRoot 'locked-install'
    New-TestDistribution -Root $lockedDistribution -ReleaseId '1.2.5-locked' -Commit ('c' * 40)
    $stateRoot = Join-Path $lockedInstallation 'state'
    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    $heldLock = [IO.File]::Open(
        (Join-Path $stateRoot 'state.lock'),
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
    )
    try {
        $lockRejected = $false
        try {
            Invoke-TestStage -DistributionRoot $lockedDistribution -InstallationRoot $lockedInstallation | Out-Null
        }
        catch {
            $lockRejected = $_.Exception.Message -like '*already active*'
        }
        if (-not $lockRejected) {
            throw 'Concurrent staging was not rejected.'
        }
    }
    finally {
        $heldLock.Dispose()
    }

    # Historical signed releases remain hash-checked ONLY as installed active/previous
    # pointers. They are never accepted as new staging candidates.
    $legacyId = '1.1.0-companion.legacy-fixture'
    $modernId = '1.1.0-companion.modern-fixture'
    $legacyDistribution = Join-Path $testRoot 'legacy'
    $modernDistribution = Join-Path $testRoot 'modern'
    New-TestDistribution -Root $legacyDistribution -ReleaseId $legacyId -Commit ('d' * 40) -LegacyFormat
    New-TestDistribution -Root $modernDistribution -ReleaseId $modernId -Commit ('e' * 40)
    . (Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1')
    . (Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1')
    $legacyRelease = Join-Path $legacyDistribution "releases\$legacyId"
    $strictRejected = $false
    try {
        Assert-McpWindowsExecutionNodeRelease -ReleaseRoot $legacyRelease -ExpectedReleaseId $legacyId | Out-Null
    }
    catch { $strictRejected = $_.Exception.Message -like '*integrity root is invalid*' }
    if (-not $strictRejected) { throw 'Unsigned staging unexpectedly accepted a legacy release.' }
    $proof = Assert-McpWindowsExecutionNodeRelease -ReleaseRoot $legacyRelease -ExpectedReleaseId $legacyId -AllowLegacyInstalledFormat
    if ($proof.releaseId -ne $legacyId -or $proof.executionManifest.integrityRoot -ne 'signed-distribution-manifest') {
        throw 'Opt-in validation of existing historical release failed.'
    }

    $crossVersionInstall = Join-Path $testRoot 'cross-version-install'
    $crossReleases = Join-Path $crossVersionInstall 'releases'
    $crossStateRoot = Join-Path $crossVersionInstall 'state'
    New-Item -Path $crossReleases, $crossStateRoot -ItemType Directory -Force | Out-Null
    Copy-Item -LiteralPath $legacyRelease -Destination (Join-Path $crossReleases $legacyId) -Recurse
    Copy-Item -LiteralPath (Join-Path $modernDistribution "releases\$modernId") -Destination (Join-Path $crossReleases $modernId) -Recurse
    $now = [DateTimeOffset]::UtcNow.ToString('O')
    $legacyPointer = [ordered]@{
        releaseId = $legacyId
        manifestSha256 = $proof.executionManifestSha256
        materializedAt = $now
    }
    $modernProof = Assert-McpWindowsExecutionNodeRelease -ReleaseRoot (Join-Path $crossReleases $modernId) -ExpectedReleaseId $modernId
    $modernPointer = [ordered]@{
        releaseId = $modernId
        manifestSha256 = $modernProof.executionManifestSha256
        materializedAt = $now
    }
    $statePath = Join-Path $crossStateRoot 'lifecycle-state.v1.json'
    Write-TestUtf8 -Path $statePath -Content (([ordered]@{
        version = 1
        active = $legacyPointer
        candidate = $modernPointer
        previous = $null
        updatedAt = $now
    } | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
    $cutover = Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeCutover.ps1'
    $promoted = & $cutover -InstallationRoot $crossVersionInstall -Operation Promote -Execute | ConvertFrom-Json
    if ($promoted.activeReleaseId -ne $modernId -or $promoted.previousReleaseId -ne $legacyId) {
        throw 'Promotion from legacy active to checksummed candidate failed.'
    }
    $activeRead = & $reader -InstallationRoot $crossVersionInstall -Mode Active `
        -ExpectedTag ("v" + $modernId) -ExpectedCommit ('e' * 40) | ConvertFrom-Json
    if ($activeRead.kind -ne 'active' -or
        $activeRead.releaseTag -ne ("v" + $modernId) -or
        $activeRead.state.active.releaseId -ne $modernId -or
        $activeRead.state.previous.releaseId -ne $legacyId -or
        $null -ne $activeRead.state.candidate -or
        $activeRead.verifiedArtifactCount -ne 9) {
        throw 'Read-only active evidence did not match the actual promoted release.'
    }
    $rolledBack = & $cutover -InstallationRoot $crossVersionInstall -Operation Rollback -Execute | ConvertFrom-Json
    if ($rolledBack.activeReleaseId -ne $legacyId -or $rolledBack.candidateReleaseId -ne $modernId) {
        throw 'Rollback to the previously installed legacy release failed.'
    }
    Add-Content -LiteralPath (Join-Path $legacyRelease 'native/McpEdgeHost.exe') -Value 'tampered'
    $legacyTamperRejected = $false
    try {
        Assert-McpWindowsExecutionNodeRelease -ReleaseRoot $legacyRelease -ExpectedReleaseId $legacyId -AllowLegacyInstalledFormat | Out-Null
    }
    catch { $legacyTamperRejected = $_.Exception.Message -like '*hash*' }
    if (-not $legacyTamperRejected) { throw 'Legacy compatibility accepted altered release bytes.' }

    # The new operation identity is accepted only DURING the original staging
    # transaction. A legacy candidate cannot be assigned an arbitrary later ID.
    $runId = '11111111-2222-4333-8444-555555555550'
    $operationId = '11111111-2222-4333-8444-555555555551'
    $wrongOperationId = '11111111-2222-4333-8444-555555555552'
    $rebindRejected = $false
    try {
        & $stager -DistributionRoot $distribution -InstallationRoot $installation `
            -Execute -AllowUnsignedDevelopment -RunId $runId `
            -PrepareOperationId $operationId | Out-Null
    }
    catch { $rebindRejected = $_.Exception.Message -like '*pre-existing candidate*' }
    if (-not $rebindRejected) {
        throw 'Legacy staging candidate was incorrectly rebound to a new prepareOperationId.'
    }

    $trackedDist = Join-Path $testRoot 'tracked-distribution'
    $trackedInstall = Join-Path $testRoot 'tracked-install'
    $trackedId = '1.2.8-tracked'
    New-TestDistribution -Root $trackedDist -ReleaseId $trackedId -Commit ('f' * 40)
    $firstTracked = & $stager -DistributionRoot $trackedDist `
        -InstallationRoot $trackedInstall -ExpectedReleaseId $trackedId `
        -RunId $runId -PrepareOperationId $operationId `
        -Execute -AllowUnsignedDevelopment | ConvertFrom-Json
    if ($firstTracked.alreadyPrepared -ne $false -or
        $firstTracked.localPrepareObserved -ne $true) {
        throw 'Tracked Windows staging did not persist its exact operation identity.'
    }
    $journalPath = Join-Path $trackedInstall 'state\candidate-prepare-witness.v1.json'
    $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
    if ($journal.kind -ne 'local_candidate_prepare' -or
        $journal.runId -ne $runId -or
        $journal.prepareOperationId -ne $operationId -or
        $journal.releaseId -ne $trackedId) {
        throw 'Persisted Windows prepare witness mismatches the original request.'
    }
    $trackedRead = & $reader -InstallationRoot $trackedInstall -Mode Candidate `
        -ExpectedTag ("v" + $trackedId) -ExpectedCommit ('f' * 40) `
        -ExpectedRunId $runId -ExpectedPrepareOperationId $operationId |
        ConvertFrom-Json
    if ($trackedRead.scope -ne 'local_hash_integrity_only' -or
        $trackedRead.localPrepareWitness.prepareOperationId -ne $operationId) {
        throw 'Windows candidate read did not preserve local operation correlation.'
    }
    $journalHash = (Get-FileHash -LiteralPath $journalPath -Algorithm SHA256).Hash
    $replayed = & $stager -DistributionRoot $trackedDist `
        -InstallationRoot $trackedInstall -RunId $runId `
        -PrepareOperationId $operationId -Execute -AllowUnsignedDevelopment |
        ConvertFrom-Json
    if ($replayed.alreadyPrepared -ne $true -or
        $replayed.localPrepareObserved -ne $true -or
        (Get-FileHash -LiteralPath $journalPath -Algorithm SHA256).Hash -ne $journalHash) {
        throw 'Idempotent Windows prepare replay changed the durable identity.'
    }
    $conflictRejected = $false
    try {
        & $stager -DistributionRoot $trackedDist -InstallationRoot $trackedInstall `
            -RunId $runId -PrepareOperationId $wrongOperationId `
            -Execute -AllowUnsignedDevelopment | Out-Null
    }
    catch { $conflictRejected = $_.Exception.Message -like '*identity conflict*' }
    if (-not $conflictRejected) {
        throw 'Conflicting prepareOperationId was accepted for the existing candidate.'
    }
    $partialIdentityRejected = $false
    try {
        & $stager -DistributionRoot $trackedDist -InstallationRoot $trackedInstall `
            -RunId $runId -Execute -AllowUnsignedDevelopment | Out-Null
    }
    catch { $partialIdentityRejected = $_.Exception.Message -like '*must be supplied together*' }
    if (-not $partialIdentityRejected) {
        throw 'A partial Windows operation correlation was accepted.'
    }
    $wrongRunRejected = $false
    try {
        & $reader -InstallationRoot $trackedInstall -Mode Candidate `
            -ExpectedTag ("v" + $trackedId) -ExpectedCommit ('f' * 40) `
            -ExpectedRunId $wrongOperationId -ExpectedPrepareOperationId $operationId |
            Out-Null
    }
    catch { $wrongRunRejected = $true }
    if (-not $wrongRunRejected) {
        throw 'Windows witness accepted another runId.'
    }
    $wrongReadRejected = $false
    try {
        & $reader -InstallationRoot $trackedInstall -Mode Candidate `
            -ExpectedTag ("v" + $trackedId) -ExpectedCommit ('f' * 40) `
            -ExpectedRunId $runId -ExpectedPrepareOperationId $wrongOperationId |
            Out-Null
    }
    catch { $wrongReadRejected = $true }
    if (-not $wrongReadRejected) {
        throw 'Read-only Windows witness accepted a foreign prepareOperationId.'
    }
    $tamperedWitness = Get-Content -LiteralPath $journalPath -Raw
    try {
        $forged = $tamperedWitness | ConvertFrom-Json
        $forged.prepareOperationId = $wrongOperationId
        [IO.File]::WriteAllText($journalPath,($forged | ConvertTo-Json -Compress))
        $forgedReadRejected = $false
        try {
            & $reader -InstallationRoot $trackedInstall -Mode Candidate `
                -ExpectedTag ("v" + $trackedId) -ExpectedCommit ('f' * 40) `
                -ExpectedRunId $runId -ExpectedPrepareOperationId $operationId |
                Out-Null
        }
        catch { $forgedReadRejected = $true }
        if (-not $forgedReadRejected) {
            throw 'Tampering with operation journal was not rejected.'
        }
    }
    finally { [IO.File]::WriteAllText($journalPath,$tamperedWitness) }

    Write-Output 'Execution-node staging, historical manifest migration and rollback gates passed.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
