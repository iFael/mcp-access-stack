[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DistributionRoot,

    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$ExpectedReleaseId,

    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'Execution-node candidate staging is intentionally gated. Re-run with -Execute.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath)) {
    throw 'Execution-node stager must run as a script file.'
}
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required execution-node staging dependency is missing: $bootstrapPath"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $bootstrapPath
    if ($signature.Status -ne 'Valid' -and
        -not ($AllowUnsignedDevelopment -and $signature.Status -eq 'NotSigned')) {
        throw "Invalid Authenticode signature for $bootstrapPath. Status=$($signature.Status)"
    }
}

. $publicCommonPath
Assert-McpPublicSignature `
    -Path $publicCommonPath `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature `
    -Path $executionCommonPath `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
. $executionCommonPath

Assert-McpPublicWindowsX64

$distributionRoot = [System.IO.Path]::GetFullPath($DistributionRoot)
$installationRoot = [System.IO.Path]::GetFullPath($InstallationRoot)
if (-not (Test-Path -LiteralPath $distributionRoot -PathType Container)) {
    throw "Execution-node distribution root was not found: $distributionRoot"
}
function Test-McpPathContains {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )
    $resolvedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $resolvedChild = [System.IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
    return $resolvedChild.Equals($resolvedParent, [StringComparison]::OrdinalIgnoreCase) -or
        $resolvedChild.StartsWith(
            $resolvedParent + [System.IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )
}
if ((Test-McpPathContains -Parent $distributionRoot -Child $installationRoot) -or
    (Test-McpPathContains -Parent $installationRoot -Child $distributionRoot)) {
    throw 'Execution-node distribution and installation roots must not overlap.'
}
Assert-McpWindowsExecutionNodeNoReparsePoints -Root $distributionRoot

$distribution = Assert-McpPublicDistribution `
    -Root $distributionRoot `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpWindowsExecutionNodeDistributionCompleteness `
    -Root $distributionRoot `
    -Manifest $distribution
$releaseId = [string]$distribution.releaseId
$distributionCommit = [string]$distribution.commit
if ($distributionCommit -notmatch '^[a-f0-9]{40}$') {
    throw 'Signed distribution contains an invalid commit identity.'
}
if ($ExpectedReleaseId -and $releaseId -ne $ExpectedReleaseId) {
    throw 'Signed distribution releaseId does not match ExpectedReleaseId.'
}
$sourceRelease = Resolve-McpPublicChildPath `
    -Root $distributionRoot `
    -RelativePath ("releases/{0}" -f $releaseId)
if (-not (Test-Path -LiteralPath $sourceRelease -PathType Container)) {
    throw "Signed distribution is missing execution-node release: $releaseId"
}

$sourceVerification = Assert-McpWindowsExecutionNodeRelease `
    -ReleaseRoot $sourceRelease `
    -ExpectedReleaseId $releaseId `
    -ExpectedCommit $distributionCommit `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

function Assert-McpManagedDirectoryBoundary {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Execution-node managed directory must not be a reparse point: $Path"
    }
}

New-Item -ItemType Directory -Force -Path $installationRoot | Out-Null
Assert-McpManagedDirectoryBoundary -Path $installationRoot
$releasesRoot = Join-Path $installationRoot 'releases'
$stateRoot = Join-Path $installationRoot 'state'
New-Item -ItemType Directory -Force -Path $releasesRoot, $stateRoot | Out-Null
Assert-McpManagedDirectoryBoundary -Path $releasesRoot
Assert-McpManagedDirectoryBoundary -Path $stateRoot

$targetRelease = Resolve-McpPublicChildPath `
    -Root $releasesRoot `
    -RelativePath $releaseId
$statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $installationRoot
$lockPath = Join-Path $stateRoot 'state.lock'
$operationMutex = $null
$lockStream = $null
$stagingPath = $null
try {
    $operationMutex = Enter-McpWindowsExecutionNodeOperationMutex -InstallationRoot $installationRoot
    try {
        $lockStream = [IO.File]::Open(
            $lockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
    }
    catch [IO.IOException] {
        throw 'Another execution-node staging operation is already active.'
    }

    $state = Read-McpWindowsExecutionNodeState -Path $statePath
    if ($null -ne $state -and $null -ne $state.active -and
        [string]$state.active.releaseId -eq $releaseId) {
        throw 'Candidate staging cannot target the currently active execution-node release.'
    }

    $materialized = $false
    if (Test-Path -LiteralPath $targetRelease) {
        if (-not (Test-Path -LiteralPath $targetRelease -PathType Container)) {
            throw "Execution-node release target exists but is not a directory: $releaseId"
        }
        $targetVerification = Assert-McpWindowsExecutionNodeRelease `
            -ReleaseRoot $targetRelease `
            -ExpectedReleaseId $releaseId `
            -ExpectedCommit ([string]$sourceVerification.commit) `
            -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
        if ([string]$targetVerification.executionManifestSha256 -ne
            [string]$sourceVerification.executionManifestSha256) {
            throw 'Existing execution-node release does not match the signed candidate.'
        }
        Assert-McpWindowsExecutionNodeMaterializedRelease `
            -DistributionManifest $distribution `
            -ReleaseId $releaseId `
            -ReleaseRoot $targetRelease
    }
    else {
        $stagingPath = Join-Path $releasesRoot (
            '.staging-{0}-{1}' -f $releaseId, [guid]::NewGuid().ToString('N')
        )
        Copy-Item -LiteralPath $sourceRelease -Destination $stagingPath -Recurse
        $stagedVerification = Assert-McpWindowsExecutionNodeRelease `
            -ReleaseRoot $stagingPath `
            -ExpectedReleaseId $releaseId `
            -ExpectedCommit ([string]$sourceVerification.commit) `
            -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
        if ([string]$stagedVerification.executionManifestSha256 -ne
            [string]$sourceVerification.executionManifestSha256) {
            throw 'Materialized execution-node candidate changed during staging.'
        }
        Assert-McpWindowsExecutionNodeMaterializedRelease `
            -DistributionManifest $distribution `
            -ReleaseId $releaseId `
            -ReleaseRoot $stagingPath
        [IO.Directory]::Move($stagingPath, $targetRelease)
        $stagingPath = $null
        $finalVerification = Assert-McpWindowsExecutionNodeRelease `
            -ReleaseRoot $targetRelease `
            -ExpectedReleaseId $releaseId `
            -ExpectedCommit ([string]$sourceVerification.commit) `
            -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
        if ([string]$finalVerification.executionManifestSha256 -ne
            [string]$sourceVerification.executionManifestSha256) {
            throw 'Final execution-node candidate verification failed after materialization.'
        }
        Assert-McpWindowsExecutionNodeMaterializedRelease `
            -DistributionManifest $distribution `
            -ReleaseId $releaseId `
            -ReleaseRoot $targetRelease
        $materialized = $true
    }

    $manifestSha256 = [string]$sourceVerification.executionManifestSha256
    if ($null -ne $state -and $null -ne $state.candidate -and
        [string]$state.candidate.releaseId -eq $releaseId -and
        [string]$state.candidate.manifestSha256 -eq $manifestSha256) {
        [pscustomobject]@{
            status = 'ready'
            releaseId = $releaseId
            candidatePrepared = $true
            alreadyPrepared = $true
            materialized = $materialized
            activeChanged = $false
        } | ConvertTo-Json -Compress
        return
    }

    $now = [DateTimeOffset]::UtcNow.ToString('O')
    $candidate = [ordered]@{
        releaseId = $releaseId
        manifestSha256 = $manifestSha256
        materializedAt = $now
    }
    $nextState = [ordered]@{
        version = 1
        active = if ($null -eq $state) { $null } else { $state.active }
        candidate = $candidate
        previous = if ($null -eq $state) { $null } else { $state.previous }
        updatedAt = $now
    }
    Write-McpWindowsExecutionNodeState -Path $statePath -Value $nextState
    Read-McpWindowsExecutionNodeState -Path $statePath | Out-Null

    [pscustomobject]@{
        status = 'ready'
        releaseId = $releaseId
        candidatePrepared = $true
        alreadyPrepared = $false
        materialized = $materialized
        activeChanged = $false
    } | ConvertTo-Json -Compress
}
finally {
    if ($lockStream) {
        $lockStream.Dispose()
    }
    if ($stagingPath -and (Test-Path -LiteralPath $stagingPath)) {
        Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
    }
    Exit-McpWindowsExecutionNodeOperationMutex -Mutex $operationMutex
}
