[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [ValidateSet('development', 'production')]
    [string]$Environment,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Promote', 'Rollback')]
    [string]$Operation,

    [ValidateRange(5, 300)]
    [int]$HealthTimeoutSeconds = 60,

    [ValidateRange(0, 100)]
    [int]$RestartCount = 2,

    [ValidateRange(1, 3600)]
    [int]$RestartIntervalSeconds = 1,

    [ValidateRange(5, 600)]
    [int]$ReadinessTimeoutSeconds = 45,

    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'Execution-node transition is intentionally gated. Re-run with -Execute.'
}
if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath)) {
    throw 'Execution-node transition must run as a script file.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required execution-node transition dependency is missing: $bootstrapPath"
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

function Assert-McpTransitionDirectoryBoundary {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Execution-node transition directory was not found: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Execution-node transition rejects reparse-point directory: $Path"
    }
}

function Test-McpTransitionProcessAlive {
    param([int]$Id)
    if ($Id -le 0) {
        return $false
    }
    return $null -ne (Get-Process -Id $Id -ErrorAction SilentlyContinue)
}

function Assert-McpTransitionPointerRelease {
    param(
        [Parameter(Mandatory = $true)][object]$Pointer,
        [Parameter(Mandatory = $true)][string]$ReleasesRoot,
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$AllowUnsignedDevelopment
    )

    Assert-McpWindowsExecutionNodePointer -Pointer $Pointer -Name $Name
    $releaseId = [string]$Pointer.releaseId
    $releaseRoot = Resolve-McpPublicChildPath -Root $ReleasesRoot -RelativePath $releaseId
    Assert-McpTransitionDirectoryBoundary -Path $releaseRoot
    $verification = Assert-McpWindowsExecutionNodeRelease `
        -ReleaseRoot $releaseRoot `
        -ExpectedReleaseId $releaseId `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    if ([string]$verification.executionManifestSha256 -ne [string]$Pointer.manifestSha256) {
        throw "Execution-node $Name pointer does not match its materialized release."
    }
    return [pscustomobject]@{
        pointer = $Pointer
        releaseRoot = $releaseRoot
        verification = $verification
    }
}

function Read-McpTransitionHealthState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [Parameter(Mandatory = $true)][string]$ManifestSha256,
        [Parameter(Mandatory = $true)][string]$Environment
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        $health = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
    if ($null -eq $health -or
        [int]$health.version -ne 1 -or
        [string]$health.contractVersion -ne 'mcp-host-contract-v3' -or
        [string]$health.releaseId -ne $ReleaseId -or
        [string]$health.executionManifestSha256 -ne $ManifestSha256 -or
        [string]$health.environment -ne $Environment) {
        return $null
    }
    return $health
}

function Stop-McpTransitionQualificationHost {
    param([AllowNull()][Diagnostics.Process]$Process)

    if ($null -eq $Process) {
        return
    }
    try {
        if (-not $Process.HasExited) {
            Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
            $Process.WaitForExit(10000) | Out-Null
        }
    }
    catch {
    }
}

$installationRoot = [IO.Path]::GetFullPath($InstallationRoot)
$projectRoot = [IO.Path]::GetFullPath($ProjectRoot)
Assert-McpTransitionDirectoryBoundary -Path $installationRoot
Assert-McpTransitionDirectoryBoundary -Path $projectRoot

$releasesRoot = Join-Path $installationRoot 'releases'
$stateRoot = Join-Path $installationRoot 'state'
Assert-McpTransitionDirectoryBoundary -Path $releasesRoot
Assert-McpTransitionDirectoryBoundary -Path $stateRoot

$statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $installationRoot
$lockPath = Join-Path $stateRoot 'state.lock'
$runtimeRoot = Join-Path $projectRoot ("runtime\windows-execution-node\{0}" -f $Environment)
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
Assert-McpTransitionDirectoryBoundary -Path $runtimeRoot
$healthStatePath = Join-Path $runtimeRoot 'host-state.json'

$operationMutex = $null
$lockStream = $null
$hostProcess = $null
$stateCommitted = $false
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
        throw 'Execution-node transition requires initialized state.'
    }

    $targetPointer = $null
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

    $target = Assert-McpTransitionPointerRelease `
        -Pointer $targetPointer `
        -ReleasesRoot $releasesRoot `
        -Name 'target' `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    if ($null -ne $sourcePointer) {
        $null = Assert-McpTransitionPointerRelease `
            -Pointer $sourcePointer `
            -ReleasesRoot $releasesRoot `
            -Name 'active' `
            -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    }

    if (Test-Path -LiteralPath $healthStatePath -PathType Leaf) {
        try {
            $existingHealth = Get-Content -LiteralPath $healthStatePath -Raw | ConvertFrom-Json
            $existingPid = [int]$existingHealth.pid
            if (Test-McpTransitionProcessAlive -Id $existingPid) {
                throw 'Execution-node transition requires the existing McpHost to be stopped by the cutover orchestrator.'
            }
        }
        catch {
            if ($_.Exception.Message -like '*existing McpHost*') {
                throw
            }
        }
        Remove-Item -LiteralPath $healthStatePath -Force -ErrorAction SilentlyContinue
    }

    $hostRecord = @($target.verification.executionManifest.artifacts | Where-Object { [string]$_.role -eq 'mcp-host' })[0]
    $hostPath = Resolve-McpPublicChildPath `
        -Root $target.releaseRoot `
        -RelativePath ([string]$hostRecord.path)

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $hostPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    foreach ($argument in @(
        '--supervise',
        '--release-root', $target.releaseRoot,
        '--project-root', $projectRoot,
        '--environment', $Environment,
        '--expected-manifest-sha256', ([string]$targetPointer.manifestSha256),
        '--restart-count', ([string]$RestartCount),
        '--restart-interval-seconds', ([string]$RestartIntervalSeconds),
        '--readiness-timeout-seconds', ([string]$ReadinessTimeoutSeconds),
        '--qualification-owner-pid', ([string]$PID)
    )) {
        $null = $startInfo.ArgumentList.Add([string]$argument)
    }

    $hostProcess = [Diagnostics.Process]::new()
    $hostProcess.StartInfo = $startInfo
    if (-not $hostProcess.Start()) {
        throw 'Execution-node qualification McpHost did not start.'
    }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($HealthTimeoutSeconds)
    $readyHealth = $null
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if ($hostProcess.HasExited) {
            throw "Execution-node qualification McpHost exited before readiness. Exit=$($hostProcess.ExitCode)"
        }
        $health = Read-McpTransitionHealthState `
            -Path $healthStatePath `
            -ReleaseId ([string]$targetPointer.releaseId) `
            -ManifestSha256 ([string]$targetPointer.manifestSha256) `
            -Environment $Environment
        if ($null -ne $health -and [string]$health.status -eq 'failed') {
            throw 'Execution-node qualification McpHost reported terminal failure.'
        }
        if ($null -ne $health -and
            [string]$health.status -eq 'ready' -and
            $health.agent.ready -eq $true -and
            $health.browserWorker.ready -eq $true -and
            [int]$health.pid -eq $hostProcess.Id) {
            $readyHealth = $health
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if ($null -eq $readyHealth) {
        throw 'Execution-node qualification did not reach ready before the health deadline.'
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
    $committedState = Read-McpWindowsExecutionNodeState -Path $statePath
    if ($null -eq $committedState.active -or
        [string]$committedState.active.releaseId -ne [string]$targetPointer.releaseId -or
        [string]$committedState.active.manifestSha256 -ne [string]$targetPointer.manifestSha256) {
        throw 'Execution-node state commit did not persist the validated target release.'
    }
    if ($Operation -eq 'Promote' -and $null -ne $committedState.candidate) {
        throw 'Execution-node promotion did not clear candidate after commit.'
    }
    if ($Operation -eq 'Rollback' -and $null -ne $sourcePointer -and
        ($null -eq $committedState.candidate -or
         [string]$committedState.candidate.releaseId -ne [string]$sourcePointer.releaseId)) {
        throw 'Execution-node rollback did not preserve the displaced active release as candidate.'
    }
    $stateCommitted = $true

    [pscustomobject]@{
        status = if ($Operation -eq 'Promote') { 'promoted' } else { 'rolled-back' }
        operation = $Operation.ToLowerInvariant()
        activeReleaseId = [string]$committedState.active.releaseId
        candidateReleaseId = if ($null -eq $committedState.candidate) { $null } else { [string]$committedState.candidate.releaseId }
        previousReleaseId = if ($null -eq $committedState.previous) { $null } else { [string]$committedState.previous.releaseId }
        healthValidated = $true
        qualificationHostPid = $hostProcess.Id
        qualificationHostRetained = $false
    } | ConvertTo-Json -Compress
}
finally {
    Stop-McpTransitionQualificationHost -Process $hostProcess
    if ($lockStream) {
        $lockStream.Dispose()
    }
    Exit-McpWindowsExecutionNodeOperationMutex -Mutex $operationMutex
    if (-not $stateCommitted -and $hostProcess) {
        # State remains unchanged on any pre-commit health or validation failure.
    }
}
