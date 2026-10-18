[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallationRoot,
    [Parameter(Mandatory = $true)]
    [ValidateSet('State', 'Candidate', 'Active')][string]$Mode,
    [ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$')]
    [string]$ExpectedTag,
    [ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedCommit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1')
. (Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1')
Assert-McpPublicWindowsX64

# This is local integrity evidence only, NOT an authenticated remote receipt or
# a prepare_windows operationId witness. Never execute files from a release.
$root = [IO.Path]::GetFullPath($InstallationRoot)
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw 'Windows execution-node installation was not found.'
}
$stateRoot = Join-Path $root 'state'
$releasesRoot = Join-Path $root 'releases'
foreach ($directory in @($root, $stateRoot, $releasesRoot)) {
    $item = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or
        0 -ne ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Windows execution-node managed directory is invalid or redirected.'
    }
}
$statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $root
$stateItem = Get-Item -LiteralPath $statePath -Force -ErrorAction Stop
if (0 -ne ($stateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    [long]$stateItem.Length -lt 2 -or [long]$stateItem.Length -gt 16384) {
    throw 'Windows execution-node state is redirected or too large.'
}
$beforeHash = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash
$state = Read-McpWindowsExecutionNodeState -Path $statePath
if ($null -eq $state) { throw 'Windows execution-node state is missing.' }
if ($Mode -eq 'State' -and ($ExpectedTag -or $ExpectedCommit)) {
    throw 'Windows state-only read does not accept a release identity.'
}

function Get-ProjectedPointer {
    param([AllowNull()][object]$Pointer)
    if ($null -eq $Pointer) { return $null }
    return [ordered]@{
        releaseId = [string]$Pointer.releaseId
        manifestSha256 = [string]$Pointer.manifestSha256
    }
}
$projection = [ordered]@{
    active = Get-ProjectedPointer -Pointer $state.active
    previous = Get-ProjectedPointer -Pointer $state.previous
    candidate = Get-ProjectedPointer -Pointer $state.candidate
}
$evidence = [ordered]@{
    platform = 'windows'
    kind = $Mode.ToLowerInvariant()
    scope = 'local_hash_integrity_only'
    state = $projection
}
if ($Mode -ne 'State') {
    if (-not $ExpectedTag -or -not $ExpectedCommit) {
        throw 'Windows release integrity read requires an exact tag and commit.'
    }
    $releaseId = $ExpectedTag.Substring(1)
    $pointer = if ($Mode -eq 'Candidate') { $state.candidate } else { $state.active }
    if ($null -eq $pointer -or [string]$pointer.releaseId -cne $releaseId) {
        throw 'Windows release pointer does not match the expected release.'
    }
    if ($Mode -eq 'Candidate' -and $null -ne $state.active -and
        [string]$state.active.releaseId -eq $releaseId) {
        throw 'Windows candidate must differ from the active release.'
    }
    if ($Mode -eq 'Active' -and ($null -ne $state.candidate -or
        $null -eq $state.previous)) {
        throw 'Windows active inspection requires rollback state and no candidate.'
    }
    $releaseRoot = Resolve-McpPublicChildPath -Root $releasesRoot -RelativePath $releaseId
    # Reject junctions, symlinks and other reparse points before hashing any bytes.
    Assert-McpWindowsExecutionNodeNoReparsePoints -Root $releaseRoot
    $manifestPath = Join-Path $releaseRoot 'execution-node-manifest.json'
    $manifestItem = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
    if ([long]$manifestItem.Length -lt 2 -or [long]$manifestItem.Length -gt 131072) {
        throw 'Windows execution-node manifest is oversized.'
    }
    $manifestDigest = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($manifestDigest -cne [string]$pointer.manifestSha256) {
        throw 'Windows pointer digest does not match on-disk manifest.'
    }
    $manifest = Read-McpPublicJson -Path $manifestPath
    $integrity = [string]$manifest.integrityRoot
    if ([int]$manifest.version -ne 2 -or
        [string]$manifest.releaseId -cne $releaseId -or
        [string]$manifest.commit -cne $ExpectedCommit -or
        [string]$manifest.platform -cne 'win32-x64' -or
        [string]$manifest.runtimeMode -cne 'bundled-node' -or
        ($integrity -cne 'sha256-distribution-manifest' -and
        -not ($Mode -eq 'Active' -and $integrity -ceq 'signed-distribution-manifest'))) {
        throw 'Windows execution-node manifest identity is invalid.'
    }
    $releaseManifest = Read-McpPublicJson -Path (Join-Path $releaseRoot 'manifest.json')
    if ([string]$releaseManifest.releaseId -cne $releaseId -or
        [string]$releaseManifest.commit -cne $ExpectedCommit -or
        [int]$releaseManifest.executionNode.schemaVersion -ne 2 -or
        [string]$releaseManifest.executionNode.manifestPath -cne 'execution-node-manifest.json' -or
        [string]$releaseManifest.executionNode.manifestSha256 -cne $manifestDigest) {
        throw 'Windows release identity does not bind the execution-node manifest.'
    }
    # These are local checksums, not a cryptographically authenticated
    # provenance or a prepareOperationId observation.
    $signedEntries = @($releaseManifest.fileHashes)
    if ($signedEntries.Count -lt 1 -or $signedEntries.Count -gt 2048) {
        throw 'Windows release manifest has an invalid file count.'
    }
    $seenPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $signedEntries) {
        $relative = [string]$entry.path
        if (-not $seenPaths.Add($relative)) {
            throw 'Windows release manifest contains duplicate file paths.'
        }
        $file = Resolve-McpPublicChildPath -Root $releaseRoot -RelativePath $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or
            [string]$entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne
                [string]$entry.sha256) {
            throw 'Windows immutable release file integrity mismatch.'
        }
    }
    $artifacts = @($manifest.artifacts)
    if ($artifacts.Count -lt 1 -or $artifacts.Count -gt 64) {
        throw 'Windows execution-node artifact count is invalid.'
    }
    $artifactIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $artifacts) {
        if ([string]$entry.id -notmatch '^[a-z][a-z0-9-]{0,63}$' -or
            -not $artifactIds.Add([string]$entry.id) -or
            [string]$entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            [long]$entry.sizeBytes -le 0) {
            throw 'Windows execution-node artifact descriptor is invalid.'
        }
        $file = Resolve-McpPublicChildPath -Root $releaseRoot -RelativePath ([string]$entry.path)
        $info = Get-Item -LiteralPath $file -Force -ErrorAction Stop
        if (-not $info.PSIsContainer -and
            [long]$info.Length -eq [long]$entry.sizeBytes -and
            (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
                [string]$entry.sha256) { continue }
        throw 'Windows execution-node artifact bytes changed.'
    }
    foreach ($required in @('edge-host','edge-connector','edge-validation-launcher',
        'browser-worker-server','local-companion-runtime','node-host-launcher',
        'browser-credential-broker','elevation-broker','node-runtime')) {
        if (-not $artifactIds.Contains($required)) {
            throw 'Windows execution-node required artifact is absent.'
        }
    }
    $evidence['releaseTag'] = $ExpectedTag
    $evidence['sourceCommitSha'] = $ExpectedCommit
    $evidence['manifestSha256'] = $manifestDigest
    $evidence['verifiedArtifactCount'] = $artifacts.Count
}
$afterHash = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash
if ($beforeHash -cne $afterHash) {
    throw 'Windows lifecycle state changed during read.'
}
if ($Mode -ne 'State') {
    $afterManifest = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($afterManifest -cne $evidence['manifestSha256']) {
        throw 'Windows execution-node manifest changed during read.'
    }
}
$evidence | ConvertTo-Json -Compress -Depth 8
