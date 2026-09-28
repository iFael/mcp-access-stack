[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [string]$StateRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$TargetReleaseId,

    [string]$TaskName = 'MCP V3 local companion',

    [ValidateRange(1, 60)]
    [int]$StartupWaitSeconds = 10,

    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'MCP V3 local release switch is intentionally gated. Re-run with -Execute.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required MCP V3 local switch dependency is missing: $bootstrapPath"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $bootstrapPath
    if ($signature.Status -ne 'Valid' -and -not ($AllowUnsignedDevelopment -and $signature.Status -eq 'NotSigned')) {
        throw "Invalid Authenticode signature for $bootstrapPath. Status=$($signature.Status)"
    }
}

. $publicCommonPath
Assert-McpPublicSignature -Path $publicCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature -Path $executionCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
. $executionCommonPath
Assert-McpPublicWindowsX64

$installation = [IO.Path]::GetFullPath($InstallationRoot)
$stateRoot = [IO.Path]::GetFullPath($StateRoot)
$statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $installation
$stateBefore = Read-McpWindowsExecutionNodeState -Path $statePath
if ($null -eq $stateBefore) {
    throw 'MCP V3 local release switch requires staged execution-node state.'
}

$targetReleaseRoot = Join-Path $installation ("releases\$TargetReleaseId")
$targetVerification = Assert-McpWindowsExecutionNodeRelease -ReleaseRoot $targetReleaseRoot -ExpectedReleaseId $TargetReleaseId -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

$alreadyActive = $null -ne $stateBefore.active -and [string]$stateBefore.active.releaseId -eq $TargetReleaseId
if (-not $alreadyActive) {
    if ($null -eq $stateBefore.candidate -or [string]$stateBefore.candidate.releaseId -ne $TargetReleaseId) {
        throw 'MCP V3 local target must be the currently staged candidate.'
    }
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$taskSnapshot = $null
if ($existingTask) {
    $taskSnapshot = [pscustomobject]@{
        xml = [string](Export-ScheduledTask -TaskName $TaskName)
        enabled = [bool]$existingTask.Settings.Enabled
        running = [string]$existingTask.State -eq 'Running'
    }
}

$handoverSource = $null
if ($existingTask -and [string]$existingTask.State -eq 'Running' -and -not $alreadyActive) {
    $lockPath = Join-Path $stateRoot 'state\companion-instance.v1.json'
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        throw 'MCP V3 local running companion is missing its single-instance lock; refusing a gap-producing cutover.'
    }
    $lockRecord = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$lockRecord.instanceId) -or
        [int]$lockRecord.pid -le 0 -or
        [string]::IsNullOrWhiteSpace([string]$lockRecord.releaseRoot) -or
        -not (Get-Process -Id ([int]$lockRecord.pid) -ErrorAction SilentlyContinue)) {
        throw 'MCP V3 local companion lock is not a live handover source.'
    }
    $handoverSource = [pscustomobject]@{
        instanceId = [string]$lockRecord.instanceId
        pid = [int]$lockRecord.pid
        releaseRoot = [IO.Path]::GetFullPath([string]$lockRecord.releaseRoot)
        lockPath = $lockPath
    }
}

function Stop-McpV3LocalTask {
    param([Parameter(Mandatory = $true)][string]$Name)
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $task -or [string]$task.State -ne 'Running') {
        return
    }
    Stop-ScheduledTask -TaskName $Name
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 200
        $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        if (-not $task -or [string]$task.State -ne 'Running') {
            return
        }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "MCP V3 local task did not stop before replacement: $Name"
}

function Get-McpV3LocalCompanionLaunchers {
    param([Parameter(Mandatory = $true)][string]$InstallationRoot)

    $releasesRoot = ([IO.Path]::GetFullPath((Join-Path $InstallationRoot 'releases'))).TrimEnd('\') + '\'
    return @(
        Get-CimInstance Win32_Process -Filter "Name='McpNodeHostLauncher.exe'" -ErrorAction Stop |
            Where-Object {
                $commandLine = [string]$_.CommandLine
                -not [string]::IsNullOrWhiteSpace($commandLine) -and
                $commandLine.IndexOf($releasesRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $commandLine.IndexOf('companion-cli.js', [StringComparison]::OrdinalIgnoreCase) -ge 0
            }
    )
}

function Wait-McpV3LocalHandover {
    param(
        [Parameter(Mandatory = $true)][object]$Source,
        [Parameter(Mandatory = $true)][string]$TargetReleaseRoot,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )

    $target = [IO.Path]::GetFullPath($TargetReleaseRoot)
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $record = $null
        if (Test-Path -LiteralPath ([string]$Source.lockPath) -PathType Leaf) {
            try {
                $record = Get-Content -LiteralPath ([string]$Source.lockPath) -Raw | ConvertFrom-Json
            }
            catch {
                $record = $null
            }
        }
        $newOwnerReady = $null -ne $record -and
            -not [string]::IsNullOrWhiteSpace([string]$record.instanceId) -and
            [string]$record.instanceId -ne [string]$Source.instanceId -and
            [int]$record.pid -gt 0 -and
            (Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue) -and
            [string]::Equals([IO.Path]::GetFullPath([string]$record.releaseRoot), $target, [StringComparison]::OrdinalIgnoreCase)
        $oldOwnerExited = -not (Get-Process -Id ([int]$Source.pid) -ErrorAction SilentlyContinue)
        if ($newOwnerReady -and $oldOwnerExited) {
            return $record
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw 'MCP V3 local handover did not transfer readiness before timeout.'
}

function Stop-McpV3LocalCompanionLaunchers {
    param([Parameter(Mandatory = $true)][string]$InstallationRoot)

    $launchers = @(Get-McpV3LocalCompanionLaunchers -InstallationRoot $InstallationRoot)
    foreach ($launcher in $launchers) {
        $pidValue = [int]$launcher.ProcessId
        & taskkill.exe /PID ([string]$pidValue) /T /F *> $null
        if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
            throw "MCP V3 local companion launcher could not be stopped: pid=$pidValue"
        }
    }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
    do {
        if (@(Get-McpV3LocalCompanionLaunchers -InstallationRoot $InstallationRoot).Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw 'MCP V3 local companion launcher remained alive after task stop.'
}

function Restore-McpV3LocalTask {
    param([AllowNull()][object]$Snapshot)
    $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($current) {
        if ([string]$current.State -eq 'Running') {
            Stop-McpV3LocalTask -Name $TaskName
        }
        Stop-McpV3LocalCompanionLaunchers -InstallationRoot $installation
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    if ($null -eq $Snapshot) {
        return
    }
    Register-ScheduledTask -TaskName $TaskName -Xml ([string]$Snapshot.xml) -Force | Out-Null
    if ([bool]$Snapshot.enabled) {
        Enable-ScheduledTask -TaskName $TaskName | Out-Null
    }
    else {
        Disable-ScheduledTask -TaskName $TaskName | Out-Null
    }
    if ([bool]$Snapshot.running) {
        Start-ScheduledTask -TaskName $TaskName
    }
}

$promoted = $false
$usedZeroGapHandover = $null -ne $handoverSource
try {
    if (-not $usedZeroGapHandover) {
        if ($existingTask -and [string]$existingTask.State -eq 'Running') {
            Stop-McpV3LocalTask -Name $TaskName
        }
        Stop-McpV3LocalCompanionLaunchers -InstallationRoot $installation
    }

    if (-not $alreadyActive) {
        $cutoverScript = Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeCutover.ps1'
        Assert-McpPublicSignature -Path $cutoverScript -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
        $cutover = & $cutoverScript -InstallationRoot $installation -Operation Promote -Execute -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
        if ([string]$cutover.status -ne 'cutover-ready' -or [string]$cutover.activeReleaseId -ne $TargetReleaseId) {
            throw 'MCP V3 local release promotion returned unexpected evidence.'
        }
        $promoted = $true
    }

    $taskInstaller = Join-Path $targetReleaseRoot 'deploy\windows\Install-McpV3LocalTask.ps1'
    Assert-McpPublicSignature -Path $taskInstaller -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    if ($usedZeroGapHandover) {
        $handoverResult = & $taskInstaller `
            -InstallationRoot $installation `
            -ReleaseId $TargetReleaseId `
            -StateRoot $stateRoot `
            -TaskName $TaskName `
            -MultipleInstances Parallel `
            -HandoverFromInstanceId ([string]$handoverSource.instanceId) `
            -AllowRunningReplacement `
            -Execute -Force -Activate `
            -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
        if ([string]$handoverResult.releaseId -ne $TargetReleaseId -or
            $handoverResult.activated -ne $true -or
            [string]$handoverResult.multipleInstances -ne 'Parallel' -or
            $handoverResult.handover -ne $true) {
            throw 'MCP V3 local handover task installer returned unexpected evidence.'
        }
        Start-ScheduledTask -TaskName $TaskName
        $null = Wait-McpV3LocalHandover `
            -Source $handoverSource `
            -TargetReleaseRoot $targetReleaseRoot `
            -TimeoutSeconds $StartupWaitSeconds
        $taskResult = & $taskInstaller `
            -InstallationRoot $installation `
            -ReleaseId $TargetReleaseId `
            -StateRoot $stateRoot `
            -TaskName $TaskName `
            -MultipleInstances IgnoreNew `
            -AllowRunningReplacement `
            -Execute -Force -Activate `
            -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
    }
    else {
        $taskResult = & $taskInstaller -InstallationRoot $installation -ReleaseId $TargetReleaseId -StateRoot $stateRoot -TaskName $TaskName -Execute -Force -Activate -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
        Start-ScheduledTask -TaskName $TaskName
    }
    if ([string]$taskResult.releaseId -ne $TargetReleaseId -or
        $taskResult.activated -ne $true -or
        [string]$taskResult.multipleInstances -ne 'IgnoreNew' -or
        $taskResult.handover -ne $false) {
        throw 'MCP V3 local task installer returned unexpected final evidence.'
    }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($StartupWaitSeconds)
    $running = $false
    do {
        Start-Sleep -Milliseconds 250
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $running = $null -ne $task -and [string]$task.State -eq 'Running'
        if ($running) {
            break
        }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if (-not $running) {
        throw 'MCP V3 local task did not remain running after activation.'
    }

    [pscustomobject]@{
        status = 'active'
        releaseId = $TargetReleaseId
        promoted = $promoted
        zeroGapHandover = $usedZeroGapHandover
        taskName = $TaskName
        taskRunning = $true
        executionManifestSha256 = [string]$targetVerification.executionManifestSha256
    } | ConvertTo-Json -Compress
}
catch {
    $switchError = $_
    try {
        Restore-McpV3LocalTask -Snapshot $taskSnapshot
    }
    catch {
        throw "MCP V3 local switch failed and task rollback also failed. Original=$($switchError.Exception.Message) Rollback=$($_.Exception.Message)"
    }

    if ($promoted) {
        $mutex = $null
        try {
            $mutex = Enter-McpWindowsExecutionNodeOperationMutex -InstallationRoot $installation
            Write-McpWindowsExecutionNodeState -Path $statePath -Value $stateBefore
            $restored = Read-McpWindowsExecutionNodeState -Path $statePath
            $expectedActive = if ($null -eq $stateBefore.active) { $null } else { [string]$stateBefore.active.releaseId }
            $actualActive = if ($null -eq $restored.active) { $null } else { [string]$restored.active.releaseId }
            if ($expectedActive -ne $actualActive) {
                throw 'MCP V3 local execution state rollback verification failed.'
            }
        }
        finally {
            Exit-McpWindowsExecutionNodeOperationMutex -Mutex $mutex
        }
    }
    throw $switchError
}
