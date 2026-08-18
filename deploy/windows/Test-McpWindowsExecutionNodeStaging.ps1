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

function New-TestDataScript {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $json = $Value | ConvertTo-Json -Depth 20 -Compress
    $base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $content = @(
        '$json = [Text.Encoding]::UTF8.GetString(',
        "    [Convert]::FromBase64String('$base64')",
        ')',
        '$json | ConvertFrom-Json'
    ) -join [Environment]::NewLine
    Write-TestUtf8 -Path $Path -Content ($content + [Environment]::NewLine)
}

function New-TestExecutionNodeDistribution {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [Parameter(Mandatory = $true)][string]$Commit
    )

    $release = Join-Path $Root "releases\$ReleaseId"
    foreach ($relative in @(
        'native\McpHost.exe',
        'compat\McpNodeHostLauncher.exe',
        'compat\McpCredentialBroker.exe',
        'services\workspace-agent\dist\cli.js',
        'services\browser-worker\dist\server.js',
        'runtime\node\node.exe'
    )) {
        $path = Join-Path $release $relative
        Write-TestUtf8 -Path $path -Content ("fixture:${ReleaseId}:$relative")
    }

    function New-ArtifactRecord {
        param(
            [Parameter(Mandatory = $true)][string]$Role,
            [Parameter(Mandatory = $true)][string]$RelativePath,
            [Parameter(Mandatory = $true)][bool]$AuthenticodeRequired
        )
        $path = Join-Path $release ($RelativePath.Replace('/', '\'))
        $item = Get-Item -LiteralPath $path
        return [ordered]@{
            role = $Role
            path = $RelativePath
            sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            sizeBytes = [long]$item.Length
            authenticodeRequired = $AuthenticodeRequired
        }
    }

    $executionManifest = [ordered]@{
        version = 1
        releaseId = $ReleaseId
        commit = $Commit
        platform = 'win32-x64'
        createdAt = '2026-08-16T00:00:00.000Z'
        runtimeMode = 'bundled-node'
        integrityRoot = 'signed-distribution-manifest'
        artifacts = @(
            (New-ArtifactRecord -Role 'mcp-host' -RelativePath 'native/McpHost.exe' -AuthenticodeRequired $true),
            (New-ArtifactRecord -Role 'workspace-agent' -RelativePath 'services/workspace-agent/dist/cli.js' -AuthenticodeRequired $false),
            (New-ArtifactRecord -Role 'browser-worker' -RelativePath 'services/browser-worker/dist/server.js' -AuthenticodeRequired $false),
            (New-ArtifactRecord -Role 'node-runtime' -RelativePath 'runtime/node/node.exe' -AuthenticodeRequired $false)
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
                    path = $_.FullName.Substring($release.Length).TrimStart('\', '/').Replace('\', '/')
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
    )
    $releaseManifest = [ordered]@{
        releaseId = $ReleaseId
        version = $ReleaseId
        commit = $Commit
        builtAt = '2026-08-16T00:00:00.000Z'
        nodeVersion = 'v26.7.0'
        testsPassed = $true
        dirty = $false
        executionNode = [ordered]@{
            schemaVersion = 1
            manifestPath = 'execution-node-manifest.json'
            manifestSha256 = (Get-FileHash -LiteralPath $executionManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        fileHashes = $releaseFiles
    }
    $releaseManifestPath = Join-Path $release 'manifest.json'
    Write-TestUtf8 `
        -Path $releaseManifestPath `
        -Content (($releaseManifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine)

    $dockerImages = @(
        [ordered]@{
            component = 'gateway'
            repository = 'ghcr.io/example/mcp-access-stack-gateway'
            digest = ('sha256:' + ('c' * 64))
            platform = 'linux/amd64'
        },
        [ordered]@{
            component = 'proxy'
            repository = 'ghcr.io/example/mcp-access-stack-proxy'
            digest = ('sha256:' + ('d' * 64))
            platform = 'linux/amd64'
        }
    )
    New-TestDataScript -Path (Join-Path $release 'release-attestation.ps1') -Value ([ordered]@{
        schemaVersion = 1
        releaseId = $ReleaseId
        commit = $Commit
        createdAt = '2026-08-16T00:00:00.000Z'
        manifestSha256 = (Get-FileHash -LiteralPath $releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        dockerImages = $dockerImages
    })

    $distributionFiles = @(
        Get-ChildItem -LiteralPath $Root -Recurse -File |
            Where-Object { $_.Name -ne 'distribution-manifest.ps1' } |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    path = $_.FullName.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
    )
    New-TestDataScript -Path (Join-Path $Root 'distribution-manifest.ps1') -Value ([ordered]@{
        schemaVersion = 1
        platform = 'windows-x64'
        releaseId = $ReleaseId
        version = $ReleaseId
        commit = $Commit
        createdAt = '2026-08-16T00:00:00.000Z'
        dockerImages = $dockerImages
        files = $distributionFiles
    })

    return $release
}

function Write-TestExecutionNodeState {
    param(
        [Parameter(Mandatory = $true)][string]$InstallationRoot,
        [AllowNull()][object]$Active,
        [AllowNull()][object]$Candidate,
        [AllowNull()][object]$Previous
    )
    $statePath = Join-Path $InstallationRoot 'state\lifecycle-state.v1.json'
    Write-TestUtf8 -Path $statePath -Content (([ordered]@{
        version = 1
        active = $Active
        candidate = $Candidate
        previous = $Previous
        updatedAt = '2026-08-16T00:00:00.000Z'
    } | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
}

function New-TestPointer {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [Parameter(Mandatory = $true)][char]$HashCharacter
    )
    return [ordered]@{
        releaseId = $ReleaseId
        manifestSha256 = ([string]$HashCharacter * 64)
        materializedAt = '2026-08-16T00:00:00.000Z'
    }
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('mcp-execution-node-staging-test-' + [guid]::NewGuid().ToString('N'))
try {
    # Candidate-only materialization preserves active/previous and is idempotent.
    $distributionA = Join-Path $testRoot 'distribution-a'
    $installationA = Join-Path $testRoot 'installation-a'
    New-TestExecutionNodeDistribution `
        -Root $distributionA `
        -ReleaseId '1.2.0-stage' `
        -Commit ('a' * 40) | Out-Null
    $active = New-TestPointer -ReleaseId '1.1.0' -HashCharacter 'b'
    $previous = New-TestPointer -ReleaseId '1.0.0' -HashCharacter 'c'
    Write-TestExecutionNodeState `
        -InstallationRoot $installationA `
        -Active $active `
        -Candidate $null `
        -Previous $previous

    $first = (& $stager `
        -DistributionRoot $distributionA `
        -InstallationRoot $installationA `
        -ExpectedReleaseId '1.2.0-stage' `
        -Execute `
        -AllowUnsignedDevelopment) | ConvertFrom-Json
    if ([string]$first.status -ne 'ready' -or
        $first.candidatePrepared -ne $true -or
        $first.activeChanged -ne $false -or
        $first.alreadyPrepared -ne $false) {
        throw 'Candidate-only staging did not return the expected READY evidence.'
    }
    $stateA = Get-Content -LiteralPath (Join-Path $installationA 'state\lifecycle-state.v1.json') -Raw | ConvertFrom-Json
    if ([string]$stateA.active.releaseId -ne '1.1.0' -or
        [string]$stateA.previous.releaseId -ne '1.0.0' -or
        [string]$stateA.candidate.releaseId -ne '1.2.0-stage') {
        throw 'Candidate staging changed active/previous or failed to persist candidate.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $installationA 'releases\1.2.0-stage') -PathType Container)) {
        throw 'Candidate release was not materialized.'
    }

    $second = (& $stager `
        -DistributionRoot $distributionA `
        -InstallationRoot $installationA `
        -ExpectedReleaseId '1.2.0-stage' `
        -Execute `
        -AllowUnsignedDevelopment) | ConvertFrom-Json
    if ($second.alreadyPrepared -ne $true -or $second.activeChanged -ne $false) {
        throw 'Repeated staging was not idempotent.'
    }

    # A tampered signed-distribution member must fail before candidate materialization.
    $distributionB = Join-Path $testRoot 'distribution-b'
    $installationB = Join-Path $testRoot 'installation-b'
    New-TestExecutionNodeDistribution `
        -Root $distributionB `
        -ReleaseId '1.2.1-stage' `
        -Commit ('b' * 40) | Out-Null
    Add-Content `
        -LiteralPath (Join-Path $distributionB 'releases\1.2.1-stage\services\workspace-agent\dist\cli.js') `
        -Value 'tampered'
    $tamperRejected = $false
    try {
        & $stager `
            -DistributionRoot $distributionB `
            -InstallationRoot $installationB `
            -Execute `
            -AllowUnsignedDevelopment | Out-Null
    }
    catch {
        $tamperRejected = $true
    }
    if (-not $tamperRejected -or
        (Test-Path -LiteralPath (Join-Path $installationB 'releases\1.2.1-stage'))) {
        throw 'Tampered distribution was not rejected before materialization.'
    }

    # An extra unsigned file not listed in distribution-manifest.ps1 must also fail closed.
    $distributionExtra = Join-Path $testRoot 'distribution-extra'
    $installationExtra = Join-Path $testRoot 'installation-extra'
    New-TestExecutionNodeDistribution `
        -Root $distributionExtra `
        -ReleaseId '1.2.1-extra' `
        -Commit ('e' * 40) | Out-Null
    Write-TestUtf8 `
        -Path (Join-Path $distributionExtra 'releases\1.2.1-extra\node_modules\injected.js') `
        -Content 'unsigned-extra-file'
    $extraRejected = $false
    try {
        & $stager `
            -DistributionRoot $distributionExtra `
            -InstallationRoot $installationExtra `
            -Execute `
            -AllowUnsignedDevelopment | Out-Null
    }
    catch {
        $extraRejected = $true
    }
    if (-not $extraRejected -or
        (Test-Path -LiteralPath (Join-Path $installationExtra 'releases\1.2.1-extra'))) {
        throw 'Unsigned extra distribution file was not rejected before materialization.'
    }
    # Staging the active release must fail closed and must not rewrite active state.
    $distributionC = Join-Path $testRoot 'distribution-c'
    $installationC = Join-Path $testRoot 'installation-c'
    $releaseC = New-TestExecutionNodeDistribution `
        -Root $distributionC `
        -ReleaseId '1.2.2-stage' `
        -Commit ('c' * 40)
    $executionHashC = (Get-FileHash -LiteralPath (Join-Path $releaseC 'execution-node-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    $activeC = [ordered]@{
        releaseId = '1.2.2-stage'
        manifestSha256 = $executionHashC
        materializedAt = '2026-08-16T00:00:00.000Z'
    }
    Write-TestExecutionNodeState `
        -InstallationRoot $installationC `
        -Active $activeC `
        -Candidate $null `
        -Previous $null
    $activeRejected = $false
    try {
        & $stager `
            -DistributionRoot $distributionC `
            -InstallationRoot $installationC `
            -Execute `
            -AllowUnsignedDevelopment | Out-Null
    }
    catch {
        $activeRejected = $true
    }
    $stateC = Get-Content -LiteralPath (Join-Path $installationC 'state\lifecycle-state.v1.json') -Raw | ConvertFrom-Json
    if (-not $activeRejected -or
        [string]$stateC.active.releaseId -ne '1.2.2-stage' -or
        $null -ne $stateC.candidate) {
        throw 'Active-release staging did not fail closed.'
    }

    # Distribution and installation roots must never overlap.
    $distributionOverlap = Join-Path $testRoot 'distribution-overlap'
    New-TestExecutionNodeDistribution `
        -Root $distributionOverlap `
        -ReleaseId '1.2.2-overlap' `
        -Commit ('d' * 40) | Out-Null
    $overlapRejected = $false
    try {
        & $stager `
            -DistributionRoot $distributionOverlap `
            -InstallationRoot (Join-Path $distributionOverlap 'installation') `
            -Execute `
            -AllowUnsignedDevelopment | Out-Null
    }
    catch {
        $overlapRejected = $_.Exception.Message -like '*must not overlap*'
    }
    if (-not $overlapRejected) {
        throw 'Overlapping distribution/installation roots were not rejected.'
    }
    # Concurrent staging on the same installation root must be rejected by the exclusive lock.
    $distributionLock = Join-Path $testRoot 'distribution-lock'
    $installationLock = Join-Path $testRoot 'installation-lock'
    New-TestExecutionNodeDistribution `
        -Root $distributionLock `
        -ReleaseId '1.2.3-stage' `
        -Commit ('f' * 40) | Out-Null
    $stateLockRoot = Join-Path $installationLock 'state'
    New-Item -ItemType Directory -Force -Path $stateLockRoot | Out-Null
    $heldLock = [IO.File]::Open(
        (Join-Path $stateLockRoot 'state.lock'),
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
    )
    try {
        $concurrencyRejected = $false
        $concurrencyError = $null
        try {
            & $stager `
                -DistributionRoot $distributionLock `
                -InstallationRoot $installationLock `
                -Execute `
                -AllowUnsignedDevelopment | Out-Null
        }
        catch {
            $concurrencyError = $_.Exception.GetType().FullName + ': ' + $_.Exception.Message
            $concurrencyRejected = $_.Exception.Message -like '*already active*'
        }
        if (-not $concurrencyRejected -or
            (Test-Path -LiteralPath (Join-Path $installationLock 'releases\1.2.3-stage'))) {
            throw ('Concurrent candidate staging was not rejected by the exclusive lock. Observed=' + [string]$concurrencyError)
        }
    }
    finally {
        $heldLock.Dispose()
    }
    Write-Output 'Execution-node candidate staging is fail-closed, candidate-only and idempotent.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
