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

function Restore-McpV3LocalTask {
    param([AllowNull()][object]$Snapshot)
    $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($current) {
        if ([string]$current.State -eq 'Running') {
            Stop-McpV3LocalTask -Name $TaskName
        }
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
try {
    if ($existingTask -and [string]$existingTask.State -eq 'Running') {
        Stop-McpV3LocalTask -Name $TaskName
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
    $taskResult = & $taskInstaller -InstallationRoot $installation -ReleaseId $TargetReleaseId -StateRoot $stateRoot -TaskName $TaskName -Execute -Force -Activate -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
    if ([string]$taskResult.releaseId -ne $TargetReleaseId -or $taskResult.activated -ne $true) {
        throw 'MCP V3 local task installer returned unexpected evidence.'
    }

    Start-ScheduledTask -TaskName $TaskName
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
