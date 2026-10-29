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
    foreach ($phase in @('distributionHashes', 'sourceRelease', 'copy', 'copiedHashes', 'move', 'finalCheck')) {
        if ($null -eq $first.timingsMs.PSObject.Properties[$phase]) {
            throw "Candidate staging did not report the duration of phase $phase."
        }
    }
    $statePath = Join-Path $installation 'state\lifecycle-state.v1.json'
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($null -ne $state.active -or [string]$state.candidate.releaseId -ne $releaseId) {
        throw 'Candidate staging changed active or failed to persist candidate.'
    }

    $second = Invoke-TestStage -DistributionRoot $distribution -InstallationRoot $installation
    if ($second.alreadyPrepared -ne $true -or $second.activeChanged -ne $false) {
        throw 'Candidate staging is not idempotent.'
    }

    # A release folder left in place is hashed again before it is reused.
    $tamperedTargetInstallation = Join-Path $testRoot 'tampered-target-install'
    Invoke-TestStage -DistributionRoot $distribution -InstallationRoot $tamperedTargetInstallation | Out-Null
    Add-Content `
        -LiteralPath (Join-Path $tamperedTargetInstallation "releases\$releaseId\node_modules\@vs-code-gpt\remote-mcp-gateway\dist\edge-connector-cli.js") `
        -Value 'tampered'
    $tamperedTargetRejected = $false
    try {
        Invoke-TestStage -DistributionRoot $distribution -InstallationRoot $tamperedTargetInstallation | Out-Null
    }
    catch {
        $tamperedTargetRejected = $_.Exception.Message -like '*hash mismatch*'
    }
    if (-not $tamperedTargetRejected) {
        throw 'Altered bytes in an existing candidate release were not rejected.'
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
    # The release switch hashes the target first and then passes
    # -ReleaseFilesVerified, so the cutover only rechecks the structure.
    $promoted = & $cutover -InstallationRoot $crossVersionInstall -Operation Promote -ReleaseFilesVerified -Execute | ConvertFrom-Json
    if ($promoted.activeReleaseId -ne $modernId -or $promoted.previousReleaseId -ne $legacyId) {
        throw 'Promotion from legacy active to checksummed candidate failed.'
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
    Write-Output 'Execution-node staging, historical manifest migration and rollback gates passed.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
