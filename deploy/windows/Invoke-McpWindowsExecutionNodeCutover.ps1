[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Promote', 'Rollback')]
    [string]$Operation,

    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'Execution-node cutover is intentionally gated. Re-run with -Execute.'
}
if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath)) {
    throw 'Execution-node cutover must run as a script file.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required execution-node cutover dependency is missing: $bootstrapPath"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $bootstrapPath
    if ($signature.Status -ne 'Valid' -and
        -not ($AllowUnsignedDevelopment -and $signature.Status -eq 'NotSigned')) {
        throw "Invalid Authenticode signature for $bootstrapPath. Status=$($signature.Status)"
    }
}

. $publicCommonPath
Assert-McpPublicSignature -Path $publicCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature -Path $executionCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
. $executionCommonPath
Assert-McpPublicWindowsX64

function Assert-McpCutoverDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Execution-node cutover directory was not found: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Execution-node cutover rejects reparse-point directory: $Path"
    }
}

function Assert-McpCutoverPointerRelease {
    param(
        [Parameter(Mandatory = $true)][object]$Pointer,
        [Parameter(Mandatory = $true)][string]$ReleasesRoot,
        [Parameter(Mandatory = $true)][string]$Name
    )

    Assert-McpWindowsExecutionNodePointer -Pointer $Pointer -Name $Name
    $releaseRoot = Resolve-McpPublicChildPath -Root $ReleasesRoot -RelativePath ([string]$Pointer.releaseId)
    Assert-McpCutoverDirectory -Path $releaseRoot
    $verification = Assert-McpWindowsExecutionNodeRelease `
        -ReleaseRoot $releaseRoot `
        -ExpectedReleaseId ([string]$Pointer.releaseId) `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    if ([string]$verification.executionManifestSha256 -ne [string]$Pointer.manifestSha256) {
        throw "Execution-node $Name pointer does not match its materialized release."
    }
    return $verification
}

$installationRoot = [IO.Path]::GetFullPath($InstallationRoot)
Assert-McpCutoverDirectory -Path $installationRoot
$stateRoot = Join-Path $installationRoot 'state'
$releasesRoot = Join-Path $installationRoot 'releases'
Assert-McpCutoverDirectory -Path $stateRoot
Assert-McpCutoverDirectory -Path $releasesRoot

$statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $installationRoot
$lockPath = Join-Path $stateRoot 'state.lock'
$operationMutex = $null
$lockStream = $null
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
        throw 'Another execution-node state operation is already active.'
    }

    $state = Read-McpWindowsExecutionNodeState -Path $statePath
    if ($null -eq $state) {
        throw 'Execution-node cutover requires initialized state.'
    }

    $sourcePointer = $state.active
    if ($Operation -eq 'Promote') {
        if ($null -eq $state.candidate) {
            throw 'Execution-node promotion requires a candidate release.'
        }
        $targetPointer = $state.candidate
    }
    else {
        if ($null -eq $state.active -or $null -eq $state.previous) {
            throw 'Execution-node rollback requires active and previous releases.'
        }
        if ($null -ne $state.candidate) {
            throw 'Execution-node rollback requires candidate to be empty.'
        }
        $targetPointer = $state.previous
    }

    $null = Assert-McpCutoverPointerRelease `
        -Pointer $targetPointer `
        -ReleasesRoot $releasesRoot `
        -Name 'target'
    if ($null -ne $sourcePointer) {
        $null = Assert-McpCutoverPointerRelease `
            -Pointer $sourcePointer `
            -ReleasesRoot $releasesRoot `
            -Name 'active'
    }

    $now = [DateTimeOffset]::UtcNow.ToString('O')
    if ($Operation -eq 'Promote') {
        $nextState = [ordered]@{
            version = 1
            active = $targetPointer
            candidate = $null
            previous = $sourcePointer
            updatedAt = $now
        }
    }
    else {
        $nextState = [ordered]@{
            version = 1
            active = $targetPointer
            candidate = $sourcePointer
            previous = $null
            updatedAt = $now
        }
    }

    Write-McpWindowsExecutionNodeState -Path $statePath -Value $nextState
    $committed = Read-McpWindowsExecutionNodeState -Path $statePath
    if ($null -eq $committed.active -or
        [string]$committed.active.releaseId -ne [string]$targetPointer.releaseId -or
        [string]$committed.active.manifestSha256 -ne [string]$targetPointer.manifestSha256) {
        throw 'Execution-node cutover did not persist the validated target release.'
    }
    if ($Operation -eq 'Promote' -and $null -ne $committed.candidate) {
        throw 'Execution-node promotion did not clear candidate after commit.'
    }
    if ($Operation -eq 'Rollback' -and $null -ne $sourcePointer -and
        ($null -eq $committed.candidate -or
         [string]$committed.candidate.releaseId -ne [string]$sourcePointer.releaseId)) {
        throw 'Execution-node rollback did not preserve the displaced active release as candidate.'
    }

    [pscustomobject]@{
        status = 'cutover-ready'
        operation = $Operation.ToLowerInvariant()
        ownershipMode = 'edge-only'
        activeReleaseId = [string]$committed.active.releaseId
        candidateReleaseId = if ($null -eq $committed.candidate) { $null } else { [string]$committed.candidate.releaseId }
        previousReleaseId = if ($null -eq $committed.previous) { $null } else { [string]$committed.previous.releaseId }
    } | ConvertTo-Json -Compress
}
finally {
    if ($lockStream) {
        $lockStream.Dispose()
    }
    Exit-McpWindowsExecutionNodeOperationMutex -Mutex $operationMutex
}
