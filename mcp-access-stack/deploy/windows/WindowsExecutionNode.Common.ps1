[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-McpWindowsExecutionNodeSignature {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$AllowUnsignedDevelopment
    )

    if ($AllowUnsignedDevelopment) {
        $signature = Get-AuthenticodeSignature -LiteralPath $Path
        if ($signature.Status -in @('NotSigned', 'UnknownError') -and $null -eq $signature.SignerCertificate) {
            return
        }
    }
    Assert-McpPublicSignature -Path $Path -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
}
function Assert-McpWindowsExecutionNodeNoReparsePoints {
    param([Parameter(Mandatory = $true)][string]$Root)

    $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    if (-not (Test-Path -LiteralPath $resolvedRoot)) {
        throw "Execution-node path was not found: $resolvedRoot"
    }

    $items = @(
        Get-Item -LiteralPath $resolvedRoot -Force
        Get-ChildItem -LiteralPath $resolvedRoot -Force -Recurse
    )
    foreach ($item in $items) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Execution-node staging rejects reparse points: $($item.FullName)"
        }
    }
}

function Assert-McpWindowsExecutionNodeDistributionCompleteness {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][object]$Manifest
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    $expected = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($Manifest.files)) {
        $relativePath = ([string]$entry.path).Replace('\', '/')
        if (-not $expected.Add($relativePath)) {
            throw "Signed distribution manifest contains a duplicate path: $relativePath"
        }
    }

    $actual = @(
        Get-ChildItem -LiteralPath $resolvedRoot -Recurse -Force -File |
            Where-Object { $_.FullName -ne (Join-Path $resolvedRoot 'distribution-manifest.ps1') } |
            ForEach-Object {
                [System.IO.Path]::GetRelativePath($resolvedRoot, $_.FullName).Replace('\', '/')
            }
    )
    if ($actual.Count -ne $expected.Count) {
        throw 'Signed distribution file set does not match the extracted package.'
    }
    foreach ($relativePath in $actual) {
        if (-not $expected.Contains($relativePath)) {
            throw "Extracted distribution contains an unsigned extra file: $relativePath"
        }
    }
}

function Assert-McpWindowsExecutionNodeMaterializedRelease {
    param(
        [Parameter(Mandatory = $true)][object]$DistributionManifest,
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot
    )

    $resolvedRelease = [System.IO.Path]::GetFullPath($ReleaseRoot)
    $prefix = "releases/$ReleaseId/"
    $entries = @(
        $DistributionManifest.files |
            Where-Object { ([string]$_.path).Replace('\', '/').StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }
    )
    if ($entries.Count -eq 0) {
        throw 'Signed distribution manifest contains no files for the requested execution-node release.'
    }

    $expected = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $entries) {
        $signedPath = ([string]$entry.path).Replace('\', '/')
        $relativePath = $signedPath.Substring($prefix.Length)
        if ([string]::IsNullOrWhiteSpace($relativePath) -or -not $expected.Add($relativePath)) {
            throw "Signed execution-node release path is invalid or duplicated: $signedPath"
        }
        $targetPath = Resolve-McpPublicChildPath -Root $resolvedRelease -RelativePath $relativePath
        if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
            throw "Materialized execution-node release is missing a signed file: $relativePath"
        }
        $expectedHash = ([string]$entry.sha256).ToLowerInvariant()
        $actualHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expectedHash -notmatch '^[a-f0-9]{64}$' -or $actualHash -ne $expectedHash) {
            throw "Materialized execution-node release hash mismatch: $relativePath"
        }
    }

    $actual = @(
        Get-ChildItem -LiteralPath $resolvedRelease -Recurse -Force -File |
            ForEach-Object {
                [System.IO.Path]::GetRelativePath($resolvedRelease, $_.FullName).Replace('\', '/')
            }
    )
    if ($actual.Count -ne $expected.Count) {
        throw 'Materialized execution-node release file set differs from the signed distribution.'
    }
    foreach ($relativePath in $actual) {
        if (-not $expected.Contains($relativePath)) {
            throw "Materialized execution-node release contains an unsigned extra file: $relativePath"
        }
    }
}
function Assert-McpWindowsExecutionNodeRelease {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [string]$ExpectedReleaseId,
        [string]$ExpectedCommit,
        [switch]$AllowUnsignedDevelopment,
        [switch]$RuntimeSmoke
    )

    $release = [System.IO.Path]::GetFullPath($ReleaseRoot)
    Assert-McpWindowsExecutionNodeNoReparsePoints -Root $release

    $releaseManifest = Assert-McpPublicReleaseFiles -ReleaseRoot $release
    $releaseAttestation = Assert-McpPublicReleaseAttestation `
        -ReleaseRoot $release `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

    $releaseId = [string]$releaseManifest.releaseId
    $commit = [string]$releaseManifest.commit
    if ($releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw 'Execution-node release contains an invalid releaseId.'
    }
    if ($commit -notmatch '^[a-f0-9]{40}$') {
        throw 'Execution-node release contains an invalid commit.'
    }
    if ($ExpectedReleaseId -and $releaseId -ne $ExpectedReleaseId) {
        throw 'Execution-node releaseId does not match the expected release.'
    }
    if ($ExpectedCommit -and $commit -ne $ExpectedCommit) {
        throw 'Execution-node commit does not match the expected commit.'
    }
    if ([string]$releaseAttestation.releaseId -ne $releaseId -or
        [string]$releaseAttestation.commit -ne $commit) {
        throw 'Execution-node release attestation identity mismatch.'
    }

    $executionManifestPath = Join-Path $release 'execution-node-manifest.json'
    $executionManifest = Read-McpPublicJson -Path $executionManifestPath
    if ([int]$executionManifest.version -ne 1 -or
        [string]$executionManifest.releaseId -ne $releaseId -or
        [string]$executionManifest.commit -ne $commit -or
        [string]$executionManifest.platform -ne 'win32-x64' -or
        [string]$executionManifest.runtimeMode -ne 'bundled-node' -or
        [string]$executionManifest.integrityRoot -ne 'signed-distribution-manifest') {
        throw 'Execution-node manifest identity, platform or integrity root is invalid.'
    }

    $executionIdentity = $releaseManifest.executionNode
    if ($null -eq $executionIdentity -or
        [int]$executionIdentity.schemaVersion -ne 1 -or
        [string]$executionIdentity.manifestPath -ne 'execution-node-manifest.json') {
        throw 'Release manifest is missing execution-node identity.'
    }
    $expectedExecutionHash = ([string]$executionIdentity.manifestSha256).ToLowerInvariant()
    $actualExecutionHash = (Get-FileHash -LiteralPath $executionManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expectedExecutionHash -notmatch '^[a-f0-9]{64}$' -or $actualExecutionHash -ne $expectedExecutionHash) {
        throw 'Execution-node manifest hash is not bound to the release manifest.'
    }

    $artifacts = @($executionManifest.artifacts)
    if ($artifacts.Count -ne 4) {
        throw 'Bundled-node execution manifest must contain exactly four critical artifacts.'
    }
    $expectedRoles = @('mcp-host', 'workspace-agent', 'browser-worker', 'node-runtime')
    foreach ($role in $expectedRoles) {
        $records = @($artifacts | Where-Object { [string]$_.role -eq $role })
        if ($records.Count -ne 1) {
            throw "Execution-node manifest role is missing or duplicated: $role"
        }
        $record = $records[0]
        $artifactPath = Resolve-McpPublicChildPath -Root $release -RelativePath ([string]$record.path)
        if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
            throw "Execution-node artifact is missing: $($record.path)"
        }
        $item = Get-Item -LiteralPath $artifactPath
        if ([long]$record.sizeBytes -ne [long]$item.Length) {
            throw "Execution-node artifact size mismatch: $($record.path)"
        }
        $actualHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $expectedHash = ([string]$record.sha256).ToLowerInvariant()
        if ($expectedHash -notmatch '^[a-f0-9]{64}$' -or $actualHash -ne $expectedHash) {
            throw "Execution-node artifact hash mismatch: $($record.path)"
        }
        if ($record.authenticodeRequired -eq $true) {
            Assert-McpWindowsExecutionNodeSignature `
                -Path $artifactPath `
                -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
        }
    }

    $hostRecord = @($artifacts | Where-Object { [string]$_.role -eq 'mcp-host' })[0]
    if ($hostRecord.authenticodeRequired -ne $true) {
        throw 'McpHost must require Authenticode validation.'
    }

    foreach ($compatibilityExecutable in @(
        'compat\McpNodeHostLauncher.exe',
        'compat\McpCredentialBroker.exe'
    )) {
        $compatibilityPath = Join-Path $release $compatibilityExecutable
        if (-not (Test-Path -LiteralPath $compatibilityPath -PathType Leaf)) {
            throw "Signed compatibility artifact is missing: $compatibilityExecutable"
        }
        Assert-McpWindowsExecutionNodeSignature `
            -Path $compatibilityPath `
            -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    }

    if ($RuntimeSmoke) {
        $hostPath = Resolve-McpPublicChildPath -Root $release -RelativePath ([string]$hostRecord.path)
        $hostVersion = @(& $hostPath --version)
        if ($LASTEXITCODE -ne 0 -or $hostVersion.Count -ne 1 -or [string]$hostVersion[0] -ne 'mcp-host-contract-v2') {
            throw 'Signed McpHost failed its version smoke check.'
        }
        $hostValidation = @(& $hostPath --validate-release-root $release)
        if ($LASTEXITCODE -ne 0 -or $hostValidation.Count -ne 1 -or [string]$hostValidation[0] -ne 'release-root-valid') {
            throw 'Signed McpHost failed its release-root validation smoke check.'
        }

        $nodeRecord = @($artifacts | Where-Object { [string]$_.role -eq 'node-runtime' })[0]
        $nodePath = Resolve-McpPublicChildPath -Root $release -RelativePath ([string]$nodeRecord.path)
        $nodeVersion = @(& $nodePath --version)
        if ($LASTEXITCODE -ne 0 -or $nodeVersion.Count -ne 1 -or [string]$nodeVersion[0] -ne [string]$releaseManifest.nodeVersion) {
            throw 'Bundled Node.js runtime does not match the immutable release manifest.'
        }
    }

    return [pscustomobject]@{
        releaseId = $releaseId
        commit = $commit
        executionManifestSha256 = $actualExecutionHash
        releaseManifest = $releaseManifest
        executionManifest = $executionManifest
    }
}

function Assert-McpWindowsExecutionNodePointer {
    param(
        [AllowNull()][object]$Pointer,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Pointer) {
        return
    }
    if ([string]$Pointer.releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw "Execution-node state contains an invalid $Name releaseId."
    }
    if ([string]$Pointer.manifestSha256 -notmatch '^[a-f0-9]{64}$') {
        throw "Execution-node state contains an invalid $Name manifest hash."
    }
    try {
        $null = [DateTimeOffset]$Pointer.materializedAt
    }
    catch {
        throw "Execution-node state contains an invalid $Name materializedAt timestamp."
    }
}

function Read-McpWindowsExecutionNodeState {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($null -eq $state -or [int]$state.version -ne 1) {
        throw 'Unsupported execution-node state version.'
    }
    Assert-McpWindowsExecutionNodePointer -Pointer $state.active -Name 'active'
    Assert-McpWindowsExecutionNodePointer -Pointer $state.candidate -Name 'candidate'
    Assert-McpWindowsExecutionNodePointer -Pointer $state.previous -Name 'previous'

    if ($null -ne $state.active -and $null -ne $state.candidate -and
        [string]$state.active.releaseId -eq [string]$state.candidate.releaseId) {
        throw 'Execution-node state candidate must differ from active.'
    }
    if ($null -ne $state.active -and $null -ne $state.previous -and
        [string]$state.active.releaseId -eq [string]$state.previous.releaseId) {
        throw 'Execution-node state previous must differ from active.'
    }
    try {
        $null = [DateTimeOffset]$state.updatedAt
    }
    catch {
        throw 'Execution-node state contains an invalid updatedAt timestamp.'
    }
    return $state
}

function Write-McpWindowsExecutionNodeState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $directory = Split-Path -Parent $resolvedPath
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporaryPath = "$resolvedPath.tmp.$([guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText(
            $temporaryPath,
            (($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
        [IO.File]::Move($temporaryPath, $resolvedPath, $true)
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
}
