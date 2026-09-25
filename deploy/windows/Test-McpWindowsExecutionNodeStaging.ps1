[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$stager = Join-Path $PSScriptRoot 'Stage-McpWindowsExecutionNodeCandidate.ps1'

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
        [Parameter(Mandatory = $true)][string]$Commit
    )

    $release = Join-Path $Root "releases\$ReleaseId"
    foreach ($relative in @(
        'native\McpEdgeHost.exe',
        'compat\McpNodeHostLauncher.exe',
        'compat\McpCredentialBroker.exe',
        'native\McpElevationBroker.exe',
        'services\browser-worker\dist\server.js',
        'node_modules\@vs-code-gpt\remote-mcp-gateway\dist\edge-connector-cli.js',
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
        integrityRoot = 'signed-distribution-manifest'
        services = @(
            [ordered]@{ id = 'edge-runtime'; entryArtifactId = 'edge-host' },
            [ordered]@{ id = 'browser-worker'; entryArtifactId = 'node-host-launcher' }
        )
        artifacts = @(
            (New-ArtifactRecord 'edge-host' 'edge-runtime' 'native/McpEdgeHost.exe' $true),
            (New-ArtifactRecord 'edge-connector' 'edge-runtime' 'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js' $false),
            (New-ArtifactRecord 'edge-validation-launcher' 'edge-runtime' 'deploy/windows/Start-McpEdgeConnector.ps1' $true),
            (New-ArtifactRecord 'browser-worker-server' 'browser-worker' 'services/browser-worker/dist/server.js' $false),
            (New-ArtifactRecord 'node-host-launcher' 'shared' 'compat/McpNodeHostLauncher.exe' $true),
            (New-ArtifactRecord 'browser-credential-broker' 'browser-worker' 'compat/McpCredentialBroker.exe' $true),
            (New-ArtifactRecord 'elevation-broker' 'shared' 'native/McpElevationBroker.exe' $true),
            (New-ArtifactRecord 'node-runtime' 'shared' 'runtime/node/node.exe' $false)
        )
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
                    path = [IO.Path]::GetRelativePath($release, $_.FullName).Replace('\', '/')
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
                    path = [IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/')
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

    Write-Output 'Execution-node candidate staging passed v2 Edge integrity, idempotence, boundary and lock gates.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
