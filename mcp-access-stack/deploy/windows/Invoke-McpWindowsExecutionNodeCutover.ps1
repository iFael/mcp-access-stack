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

    [string]$PersistentTaskName,
    [string]$LegacyAgentTaskName,
    [string]$LegacyBrowserTaskName,
    [string]$CredentialBrokerPath,
    [switch]$EdgeOnly,

    [ValidateRange(5, 300)]
    [int]$HealthTimeoutSeconds = 60,

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
$transitionPath = Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeTransition.ps1'
$taskInstallerPath = Join-Path $PSScriptRoot 'Install-McpWindowsExecutionNodeHostTask.ps1'
foreach ($bootstrapPath in @(
    $PSCommandPath,
    $publicCommonPath,
    $executionCommonPath,
    $transitionPath,
    $taskInstallerPath
)) {
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
Assert-McpPublicSignature -Path $transitionPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature -Path $taskInstallerPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
. $executionCommonPath
Assert-McpPublicWindowsX64

$installationRoot = [IO.Path]::GetFullPath($InstallationRoot)
$projectRoot = [IO.Path]::GetFullPath($ProjectRoot)
if ([string]::IsNullOrWhiteSpace($PersistentTaskName)) {
    $PersistentTaskName = "MCP Access Stack $Environment host"
}
if ([string]::IsNullOrWhiteSpace($LegacyAgentTaskName)) {
    $LegacyAgentTaskName = "MCP Access Stack Docker $Environment agent"
}
if ([string]::IsNullOrWhiteSpace($LegacyBrowserTaskName)) {
    $LegacyBrowserTaskName = "MCP Access Stack Docker $Environment browser-worker"
}

function Test-McpCutoverPathContains {
    param([string]$Parent, [string]$Child)
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $childPath = [IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
    return $childPath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or
        $childPath.StartsWith(
            $parentPath + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )
}

if ((Test-McpCutoverPathContains -Parent $installationRoot -Child $projectRoot) -or
    (Test-McpCutoverPathContains -Parent $projectRoot -Child $installationRoot)) {
    throw 'Execution-node installation root and project root must not overlap.'
}
foreach ($rootPath in @($installationRoot, $projectRoot)) {
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
        throw "Execution-node cutover root was not found: $rootPath"
    }
    if (((Get-Item -LiteralPath $rootPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Execution-node cutover rejects reparse-point root: $rootPath"
    }
}

$stateRoot = Join-Path $installationRoot 'state'
$releasesRoot = Join-Path $installationRoot 'releases'
$hostRoot = Join-Path $installationRoot 'host'
$statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $installationRoot
$stableHostPath = Join-Path $hostRoot 'McpHost.exe'
$runtimeRoot = Join-Path $projectRoot ("runtime\windows-execution-node\{0}" -f $Environment)
$healthStatePath = Join-Path $runtimeRoot 'host-state.json'
foreach ($requiredRoot in @($stateRoot, $releasesRoot)) {
    if (-not (Test-Path -LiteralPath $requiredRoot -PathType Container)) {
        throw "Execution-node cutover required root was not found: $requiredRoot"
    }
}
New-Item -ItemType Directory -Force -Path $hostRoot, $runtimeRoot | Out-Null
foreach ($managedRoot in @($stateRoot, $releasesRoot, $hostRoot, $runtimeRoot)) {
    if (((Get-Item -LiteralPath $managedRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Execution-node cutover rejects reparse-point managed root: $managedRoot"
    }
}

function Test-McpCutoverProcessAlive {
    param([int]$Id)
    return $Id -gt 0 -and $null -ne (Get-Process -Id $Id -ErrorAction SilentlyContinue)
}

function Get-McpCutoverTaskSnapshot {
    param([Parameter(Mandatory = $true)][string]$TaskName)
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        return [pscustomobject]@{
            exists = $false
            enabled = $false
            running = $false
        }
    }
    return [pscustomobject]@{
        exists = $true
        enabled = [string]$task.State -ne 'Disabled'
        running = [string]$task.State -eq 'Running'
    }
}

function Wait-McpCutoverTaskNotRunning {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [int]$TimeoutSeconds = 20
    )
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not $task -or [string]$task.State -ne 'Running') {
            return
        }
        Start-Sleep -Milliseconds 200
    }
    throw "Scheduled Task did not stop before deadline: $TaskName"
}

function Stop-McpCutoverTaskIfRunning {
    param([Parameter(Mandatory = $true)][string]$TaskName)
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and [string]$task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName
        Wait-McpCutoverTaskNotRunning -TaskName $TaskName
    }
}

function Stop-McpPersistentHost {
    $healthPid = 0
    if (Test-Path -LiteralPath $healthStatePath -PathType Leaf) {
        try {
            $healthPid = [int]((Get-Content -LiteralPath $healthStatePath -Raw | ConvertFrom-Json).pid)
        }
        catch {
            $healthPid = 0
        }
    }
    $task = Get-ScheduledTask -TaskName $PersistentTaskName -ErrorAction SilentlyContinue
    if ($task -and [string]$task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $PersistentTaskName
        Wait-McpCutoverTaskNotRunning -TaskName $PersistentTaskName
    }
    if ($healthPid -gt 0) {
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
        while ([DateTimeOffset]::UtcNow -lt $deadline -and (Test-McpCutoverProcessAlive -Id $healthPid)) {
            Start-Sleep -Milliseconds 200
        }
        if (Test-McpCutoverProcessAlive -Id $healthPid) {
            throw 'Persistent McpHost process remained alive after its Scheduled Task was stopped.'
        }
    }
}

function Disable-McpLegacyOwnership {
    foreach ($taskName in @($LegacyAgentTaskName, $LegacyBrowserTaskName)) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            if ([string]$task.State -eq 'Running') {
                Stop-ScheduledTask -TaskName $taskName
                Wait-McpCutoverTaskNotRunning -TaskName $taskName
            }
            Disable-ScheduledTask -TaskName $taskName | Out-Null
        }
    }
}

function Restore-McpLegacyOwnership {
    param([object]$AgentSnapshot, [object]$BrowserSnapshot)
    foreach ($entry in @(
        [pscustomobject]@{ name = $LegacyAgentTaskName; snapshot = $AgentSnapshot },
        [pscustomobject]@{ name = $LegacyBrowserTaskName; snapshot = $BrowserSnapshot }
    )) {
        if (-not $entry.snapshot.exists) {
            continue
        }
        if ($entry.snapshot.enabled) {
            Enable-ScheduledTask -TaskName $entry.name | Out-Null
        }
        else {
            Disable-ScheduledTask -TaskName $entry.name | Out-Null
        }
        if ($entry.snapshot.running) {
            Start-ScheduledTask -TaskName $entry.name
        }
    }
}

function Assert-McpCutoverPointerRelease {
    param([Parameter(Mandatory = $true)][object]$Pointer)
    Assert-McpWindowsExecutionNodePointer -Pointer $Pointer -Name 'active'
    $releaseRoot = Resolve-McpPublicChildPath -Root $releasesRoot -RelativePath ([string]$Pointer.releaseId)
    $verification = Assert-McpWindowsExecutionNodeRelease `
        -ReleaseRoot $releaseRoot `
        -ExpectedReleaseId ([string]$Pointer.releaseId) `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    if ([string]$verification.executionManifestSha256 -ne [string]$Pointer.manifestSha256) {
        throw 'Active execution-node pointer does not match the materialized release.'
    }
    return [pscustomobject]@{
        pointer = $Pointer
        releaseRoot = $releaseRoot
        verification = $verification
    }
}

function Sync-McpStableHost {
    param([Parameter(Mandatory = $true)][object]$Pointer)
    $active = Assert-McpCutoverPointerRelease -Pointer $Pointer
    $hostRecord = @($active.verification.executionManifest.artifacts | Where-Object { [string]$_.role -eq 'mcp-host' })[0]
    $sourceHost = Resolve-McpPublicChildPath `
        -Root $active.releaseRoot `
        -RelativePath ([string]$hostRecord.path)
    Assert-McpWindowsExecutionNodeSignature `
        -Path $sourceHost `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

    $temporary = Join-Path $hostRoot ('.McpHost.' + [guid]::NewGuid().ToString('N') + '.exe')
    try {
        Copy-Item -LiteralPath $sourceHost -Destination $temporary
        Assert-McpWindowsExecutionNodeSignature `
            -Path $temporary `
            -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
        $sourceHash = (Get-FileHash -LiteralPath $sourceHost -Algorithm SHA256).Hash.ToLowerInvariant()
        $temporaryHash = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($sourceHash -ne $temporaryHash) {
            throw 'Stable McpHost changed while being materialized.'
        }
        [IO.File]::Move($temporary, $stableHostPath, $true)
        $temporary = $null
        $stableHash = (Get-FileHash -LiteralPath $stableHostPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($stableHash -ne $sourceHash) {
            throw 'Stable McpHost hash does not match the active release.'
        }
        Assert-McpWindowsExecutionNodeSignature `
            -Path $stableHostPath `
            -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    }
    finally {
        if ($temporary -and (Test-Path -LiteralPath $temporary)) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-McpStateTransition {
    param([Parameter(Mandatory = $true)][ValidateSet('Promote', 'Rollback')][string]$TransitionOperation)
    $parameters = @{
        InstallationRoot = $installationRoot
        ProjectRoot = $projectRoot
        Environment = $Environment
        Operation = $TransitionOperation
        HealthTimeoutSeconds = $HealthTimeoutSeconds
        Execute = $true
        AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
    }
    $result = & $transitionPath @parameters
    return $result | ConvertFrom-Json
}

function Ensure-McpPersistentTask {
    $parameters = @{
        InstallationRoot = $installationRoot
        ProjectRoot = $projectRoot
        Environment = $Environment
        TaskName = $PersistentTaskName
        Execute = $true
        Activate = $true
        AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
    }
    if (-not [string]::IsNullOrWhiteSpace($CredentialBrokerPath)) {
        $parameters.CredentialBrokerPath = [IO.Path]::GetFullPath($CredentialBrokerPath)
    }
    $result = & $taskInstallerPath @parameters
    return $result | ConvertFrom-Json
}

function Wait-McpPersistentReady {
    param([Parameter(Mandatory = $true)][object]$Pointer)
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($HealthTimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $task = Get-ScheduledTask -TaskName $PersistentTaskName -ErrorAction SilentlyContinue
        if ($task -and [string]$task.State -eq 'Running' -and
            (Test-Path -LiteralPath $healthStatePath -PathType Leaf)) {
            try {
                $health = Get-Content -LiteralPath $healthStatePath -Raw | ConvertFrom-Json
                if ([int]$health.version -eq 1 -and
                    [string]$health.contractVersion -eq 'mcp-host-contract-v3' -and
                    [string]$health.status -eq 'ready' -and
                    [string]$health.releaseId -eq [string]$Pointer.releaseId -and
                    [string]$health.executionManifestSha256 -eq [string]$Pointer.manifestSha256 -and
                    [string]$health.environment -eq $Environment -and
                    $health.agent.ready -eq $true -and
                    $health.browserWorker.ready -eq $true -and
                    (Test-McpCutoverProcessAlive -Id ([int]$health.pid))) {
                    return $health
                }
            }
            catch {
            }
        }
        Start-Sleep -Milliseconds 250
    }
    throw 'Persistent McpHost did not reach ready before the cutover health deadline.'
}

function Restore-McpPersistentOwnership {
    param(
        [Parameter(Mandatory = $true)][object]$Snapshot,
        [AllowNull()][object]$RestoredState
    )

    $task = Get-ScheduledTask -TaskName $PersistentTaskName -ErrorAction SilentlyContinue
    if (-not $Snapshot.exists) {
        if ($task) {
            if ([string]$task.State -eq 'Running') {
                Stop-ScheduledTask -TaskName $PersistentTaskName
                Wait-McpCutoverTaskNotRunning -TaskName $PersistentTaskName
            }
            Unregister-ScheduledTask -TaskName $PersistentTaskName -Confirm:$false
        }
        return
    }

    if ($null -eq $RestoredState -or $null -eq $RestoredState.active) {
        throw 'Previous persistent ownership cannot be restored without its active release.'
    }
    Sync-McpStableHost -Pointer $RestoredState.active
    $null = Ensure-McpPersistentTask
    if ($Snapshot.enabled) {
        Enable-ScheduledTask -TaskName $PersistentTaskName | Out-Null
    }
    else {
        Disable-ScheduledTask -TaskName $PersistentTaskName | Out-Null
    }
    if ($Snapshot.running) {
        Enable-ScheduledTask -TaskName $PersistentTaskName | Out-Null
        Start-ScheduledTask -TaskName $PersistentTaskName
        $null = Wait-McpPersistentReady -Pointer $RestoredState.active
        if (-not $Snapshot.enabled) {
            # A running task cannot normally be disabled, but preserve the captured flag if a provider reports it.
            Disable-ScheduledTask -TaskName $PersistentTaskName | Out-Null
        }
    }
}

function Restore-McpStateSnapshot {
    param([Parameter(Mandatory = $true)][object]$State)
    $stateLockPath = Join-Path $stateRoot 'state.lock'
    $stateLock = $null
    try {
        $stateLock = [IO.File]::Open(
            $stateLockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
        Write-McpWindowsExecutionNodeState -Path $statePath -Value $State
        $null = Read-McpWindowsExecutionNodeState -Path $statePath
    }
    finally {
        if ($stateLock) {
            $stateLock.Dispose()
        }
    }
}

$operationMutex = $null
$transitionCommitted = $false
$preState = $null
$legacyAgent = $null
$legacyBrowser = $null
$persistentBefore = $null
try {
    $operationMutex = Enter-McpWindowsExecutionNodeOperationMutex -InstallationRoot $installationRoot

    $preState = Read-McpWindowsExecutionNodeState -Path $statePath
    if ($null -eq $preState) {
        throw 'Execution-node cutover requires initialized state.'
    }
    $legacyAgent = Get-McpCutoverTaskSnapshot -TaskName $LegacyAgentTaskName
    $legacyBrowser = Get-McpCutoverTaskSnapshot -TaskName $LegacyBrowserTaskName
    $persistentBefore = Get-McpCutoverTaskSnapshot -TaskName $PersistentTaskName

    Stop-McpPersistentHost
    Disable-McpLegacyOwnership
    if (Test-Path -LiteralPath $healthStatePath) {
        Remove-Item -LiteralPath $healthStatePath -Force -ErrorAction SilentlyContinue
    }

    $transitionResult = Invoke-McpStateTransition -TransitionOperation $Operation
    $transitionCommitted = $true
    $stateAfterTransition = Read-McpWindowsExecutionNodeState -Path $statePath
    if ($null -eq $stateAfterTransition.active) {
        throw 'Execution-node transition committed without an active release.'
    }

    if ($EdgeOnly) {
        $null = Assert-McpCutoverPointerRelease -Pointer $stateAfterTransition.active
        $persistentTask = Get-ScheduledTask -TaskName $PersistentTaskName -ErrorAction SilentlyContinue
        $persistentTaskRemoved = $false
        if ($persistentTask) {
            if ([string]$persistentTask.State -eq 'Running') {
                Stop-ScheduledTask -TaskName $PersistentTaskName
                Wait-McpCutoverTaskNotRunning -TaskName $PersistentTaskName
            }
            Unregister-ScheduledTask -TaskName $PersistentTaskName -Confirm:$false
            $persistentTaskRemoved = $true
        }
        $taskStatus = if ($persistentTaskRemoved) { 'retired-edge-only' } else { 'absent-edge-only' }
        $persistentHostPid = 0
    }
    else {
        Sync-McpStableHost -Pointer $stateAfterTransition.active
        $taskResult = Ensure-McpPersistentTask
        Start-ScheduledTask -TaskName $PersistentTaskName
        $readyHealth = Wait-McpPersistentReady -Pointer $stateAfterTransition.active
        $taskStatus = [string]$taskResult.status
        $persistentHostPid = [int]$readyHealth.pid
    }

    [pscustomobject]@{
        status = 'cutover-ready'
        operation = $Operation.ToLowerInvariant()
        ownershipMode = if ($EdgeOnly) { 'edge-only' } else { 'persistent-host' }
        activeReleaseId = [string]$stateAfterTransition.active.releaseId
        persistentTaskName = $PersistentTaskName
        persistentHostPid = $persistentHostPid
        legacyAgentTaskDisabled = [bool]$legacyAgent.exists
        legacyBrowserTaskDisabled = [bool]$legacyBrowser.exists
        transitionStatus = [string]$transitionResult.status
        taskStatus = $taskStatus
        productionLegacyRemoved = $false
    } | ConvertTo-Json -Compress
}
catch {
    $primaryError = $_
    try {
        Stop-McpPersistentHost
    }
    catch {
    }

    if ($transitionCommitted -and $null -ne $preState) {
        Restore-McpStateSnapshot -State $preState
    }

    try {
        $restoredState = Read-McpWindowsExecutionNodeState -Path $statePath
        Restore-McpPersistentOwnership -Snapshot $persistentBefore -RestoredState $restoredState
        if (-not $persistentBefore.running) {
            Restore-McpLegacyOwnership -AgentSnapshot $legacyAgent -BrowserSnapshot $legacyBrowser
        }
    }
    catch {
        try {
            Restore-McpLegacyOwnership -AgentSnapshot $legacyAgent -BrowserSnapshot $legacyBrowser
        }
        catch {
        }
    }
    throw $primaryError
}
finally {
    Exit-McpWindowsExecutionNodeOperationMutex -Mutex $operationMutex
}
