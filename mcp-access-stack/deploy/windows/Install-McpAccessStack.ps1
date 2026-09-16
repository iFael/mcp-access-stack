[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$EdgeBaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$ConnectorTokenFile,

    [Parameter(Mandatory = $true)]
    [string]$OwnerTokenFile,

    [Parameter(Mandatory = $true)]
    [string]$PolicyPath,

    [string]$EdgeRuntimeRoot,
    [string]$AllowedOrigins = 'https://chatgpt.com,https://chat.openai.com',
    [string]$OwnerOAuthScopes = 'workspaces:read',

    [switch]$EnableBrowserWorker,
    [string]$BrowserWorkerTokenFile,
    [string]$BrowserPrivateDirectory,
    [string]$BrowserUserDataDirectory,
    [string]$BrowserSitePoliciesPath,
    [string]$BrowserRuntimeRoot,
    [ValidateRange(1, 65535)]
    [int]$BrowserPort = 3350,

    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-McpScheduledTaskSnapshot {
    param([Parameter(Mandatory = $true)][string]$TaskName)

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        return $null
    }
    return [pscustomobject]@{
        taskName = $TaskName
        xml = Export-ScheduledTask -TaskName $TaskName
        wasRunning = [string]$task.State -eq 'Running'
        wasEnabled = [string]$task.State -ne 'Disabled'
    }
}

function Stop-McpScheduledTaskForReplacement {
    param([Parameter(Mandatory = $true)][string]$TaskName)

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task -or [string]$task.State -ne 'Running') {
        return
    }
    Stop-ScheduledTask -TaskName $TaskName
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 200
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not $task -or [string]$task.State -ne 'Running') {
            return
        }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "Scheduled Task did not stop before replacement: $TaskName"
}

function Restore-McpScheduledTaskSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [AllowNull()][object]$Snapshot
    )

    $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $Snapshot -and $current) {
        $currentXml = Export-ScheduledTask -TaskName $TaskName
        if ([string]$currentXml -eq [string]$Snapshot.xml) {
            if ([bool]$Snapshot.wasEnabled -and [string]$current.State -eq 'Disabled') {
                Enable-ScheduledTask -TaskName $TaskName | Out-Null
            }
            elseif (-not [bool]$Snapshot.wasEnabled -and [string]$current.State -ne 'Disabled') {
                Disable-ScheduledTask -TaskName $TaskName | Out-Null
            }
            if ([bool]$Snapshot.wasRunning -and [string]$current.State -ne 'Running') {
                Start-ScheduledTask -TaskName $TaskName
            }
            return
        }
    }

    if ($current) {
        Stop-McpScheduledTaskForReplacement -TaskName $TaskName
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    if ($null -eq $Snapshot) {
        return
    }

    Register-ScheduledTask -TaskName $TaskName -Xml ([string]$Snapshot.xml) | Out-Null
    if ([bool]$Snapshot.wasEnabled) {
        Enable-ScheduledTask -TaskName $TaskName | Out-Null
    }
    else {
        Disable-ScheduledTask -TaskName $TaskName | Out-Null
    }
    if ([bool]$Snapshot.wasRunning) {
        Start-ScheduledTask -TaskName $TaskName
    }
}

function Write-McpEdgeTaskRecoveryConfig {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText(
            $temporary,
            (($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
        [IO.File]::Move($temporary, $Path, $true)
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}
$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
if (-not (Test-Path -LiteralPath $publicCommonPath -PathType Leaf)) {
    throw "Public distribution helper was not found: $publicCommonPath"
}
$publicCommonSignature = Get-AuthenticodeSignature -LiteralPath $publicCommonPath
if (
    $publicCommonSignature.Status -ne 'Valid' -and
    -not ($AllowUnsignedDevelopment -and $publicCommonSignature.Status -eq 'NotSigned')
) {
    throw "Invalid Authenticode signature for $publicCommonPath. Status=$($publicCommonSignature.Status)"
}
. $publicCommonPath

if (-not $Execute) {
    throw 'Installation is intentionally gated. Re-run with -Execute.'
}

Assert-McpPublicWindowsX64

$distributionRoot = Get-McpPublicProjectRoot
$installation = [IO.Path]::GetFullPath($InstallationRoot)
$edgeRecoveryConfigPath = Join-Path $installation 'state\edge-task-config.v1.json'
$project = [IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $project -PathType Container)) {
    throw "Project root was not found: $project"
}
foreach ($requiredFile in @(
    [pscustomobject]@{ Name = 'Connector token'; Path = $ConnectorTokenFile },
    [pscustomobject]@{ Name = 'Owner token'; Path = $OwnerTokenFile },
    [pscustomobject]@{ Name = 'Workspace policy'; Path = $PolicyPath }
)) {
    $resolved = [IO.Path]::GetFullPath([string]$requiredFile.Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "$($requiredFile.Name) file was not found: $resolved"
    }
}
if ($EnableBrowserWorker) {
    foreach ($entry in @(
        [pscustomobject]@{ Name = 'Browser Worker token'; Path = $BrowserWorkerTokenFile; Kind = 'Leaf' },
        [pscustomobject]@{ Name = 'Browser private directory'; Path = $BrowserPrivateDirectory; Kind = 'Container' },
        [pscustomobject]@{ Name = 'Browser user-data directory'; Path = $BrowserUserDataDirectory; Kind = 'Container' },
        [pscustomobject]@{ Name = 'Browser site policies'; Path = $BrowserSitePoliciesPath; Kind = 'Leaf' }
    )) {
        if ([string]::IsNullOrWhiteSpace([string]$entry.Path)) {
            throw "EnableBrowserWorker requires $($entry.Name)."
        }
        $resolved = [IO.Path]::GetFullPath([string]$entry.Path)
        if (-not (Test-Path -LiteralPath $resolved -PathType ([string]$entry.Kind))) {
            throw "$($entry.Name) was not found: $resolved"
        }
    }
}

Assert-McpPublicSignature -Path $PSCommandPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature `
    -Path (Join-Path $PSScriptRoot 'Update-McpAccessStack.ps1') `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
$distribution = Assert-McpPublicDistribution `
    -Root $distributionRoot `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
if ([int]$distribution.schemaVersion -ne 2) {
    throw 'Current installation requires distribution manifest v2.'
}
$releaseId = [string]$distribution.releaseId
$sourceRelease = Resolve-McpPublicChildPath `
    -Root $distributionRoot `
    -RelativePath ("releases/{0}" -f $releaseId)
$releaseManifest = Assert-McpPublicReleaseFiles -ReleaseRoot $sourceRelease
$releaseAttestation = Assert-McpPublicReleaseAttestation `
    -ReleaseRoot $sourceRelease `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
if (
    [int]$releaseAttestation.schemaVersion -ne 2 -or
    [string]$releaseManifest.releaseId -ne $releaseId -or
    [string]$releaseAttestation.releaseId -ne $releaseId
) {
    throw 'Current installation requires matching release and attestation v2 identities.'
}

$stageScript = Join-Path $PSScriptRoot 'Stage-McpWindowsExecutionNodeCandidate.ps1'
$cutoverScript = Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeCutover.ps1'
$edgeTaskInstaller = Join-Path $PSScriptRoot 'Install-McpEdgeConnectorTask.ps1'
$browserTaskInstaller = Join-Path $PSScriptRoot 'Install-McpBrowserWorkerTask.ps1'
foreach ($scriptPath in @($stageScript, $cutoverScript, $edgeTaskInstaller, $browserTaskInstaller)) {
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "Required Windows runtime script was not found: $scriptPath"
    }
    Assert-McpPublicSignature -Path $scriptPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
}

$stageParameters = @{
    DistributionRoot = $distributionRoot
    InstallationRoot = $installation
    ExpectedReleaseId = $releaseId
    Execute = $true
    AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
}
$stageResult = & $stageScript @stageParameters | ConvertFrom-Json
if ([string]$stageResult.status -ne 'ready') {
    throw 'Execution-node candidate staging did not reach ready.'
}

$edgeRuntime = if ([string]::IsNullOrWhiteSpace($EdgeRuntimeRoot)) {
    Join-Path $installation 'runtime\edge-connector'
}
else {
    [IO.Path]::GetFullPath($EdgeRuntimeRoot)
}
New-Item -ItemType Directory -Force -Path $edgeRuntime | Out-Null

$browserTaskName = 'MCP Access Stack production browser-worker'
$browserTaskResult = $null
$browserParameters = $null
if ($EnableBrowserWorker) {
    $browserRuntime = if ([string]::IsNullOrWhiteSpace($BrowserRuntimeRoot)) {
        Join-Path $installation 'runtime\browser-worker'
    }
    else {
        [IO.Path]::GetFullPath($BrowserRuntimeRoot)
    }
    New-Item -ItemType Directory -Force -Path $browserRuntime | Out-Null

    $browserParameters = @{
        InstallationRoot = $installation
        ReleaseId = $releaseId
        RuntimeRoot = $browserRuntime
        BrowserTokenFile = [IO.Path]::GetFullPath($BrowserWorkerTokenFile)
        PrivateDirectory = [IO.Path]::GetFullPath($BrowserPrivateDirectory)
        UserDataDirectory = [IO.Path]::GetFullPath($BrowserUserDataDirectory)
        SitePoliciesPath = [IO.Path]::GetFullPath($BrowserSitePoliciesPath)
        Port = $BrowserPort
        TaskName = $browserTaskName
        Execute = $true
        Force = $true
        Activate = $false
        AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
    }
}

$edgeTaskName = 'MCP Access Stack production edge-connector'
$edgeMaxConcurrentRequests = 8
$edgeDelaySeconds = 15
$edgeParameters = @{
    InstallationRoot = $installation
    ReleaseId = $releaseId
    RuntimeRoot = $edgeRuntime
    EdgeBaseUrl = $EdgeBaseUrl
    ConnectorTokenFile = [IO.Path]::GetFullPath($ConnectorTokenFile)
    OwnerTokenFile = [IO.Path]::GetFullPath($OwnerTokenFile)
    PolicyPath = [IO.Path]::GetFullPath($PolicyPath)
    AllowedOrigins = $AllowedOrigins
    OwnerOAuthScopes = $OwnerOAuthScopes
    MaxConcurrentRequests = $edgeMaxConcurrentRequests
    DelaySeconds = $edgeDelaySeconds
    TaskName = $edgeTaskName
    EnableBrowserWorker = [bool]$EnableBrowserWorker
    BrowserWorkerUrl = "http://127.0.0.1:$BrowserPort"
    Execute = $true
    Force = $true
    Activate = $false
    AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
}
if ($EnableBrowserWorker) {
    $edgeParameters.BrowserWorkerTokenFile = [IO.Path]::GetFullPath($BrowserWorkerTokenFile)
}

$edgeTaskSnapshot = Get-McpScheduledTaskSnapshot -TaskName $edgeTaskName
$browserTaskSnapshot = if ($EnableBrowserWorker) {
    Get-McpScheduledTaskSnapshot -TaskName $browserTaskName
}
else {
    $null
}
$cutoverCommitted = $false
$edgeTaskResult = $null
try {
    if ($EnableBrowserWorker) {
        Stop-McpScheduledTaskForReplacement -TaskName $browserTaskName
        $browserTaskResult = & $browserTaskInstaller @browserParameters | ConvertFrom-Json
    }

    Stop-McpScheduledTaskForReplacement -TaskName $edgeTaskName
    $edgeTaskResult = & $edgeTaskInstaller @edgeParameters | ConvertFrom-Json

    $cutoverParameters = @{
        InstallationRoot = $installation
        Operation = 'Promote'
        Execute = $true
        AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
    }
    $cutoverResult = & $cutoverScript @cutoverParameters | ConvertFrom-Json
    if (
        [string]$cutoverResult.status -ne 'cutover-ready' -or
        [string]$cutoverResult.ownershipMode -ne 'edge-only' -or
        [string]$cutoverResult.activeReleaseId -ne $releaseId
    ) {
        throw 'Execution-node Edge-only cutover returned unexpected evidence.'
    }
    $cutoverCommitted = $true

    if ($EnableBrowserWorker) {
        Enable-ScheduledTask -TaskName $browserTaskName | Out-Null
        Start-ScheduledTask -TaskName $browserTaskName
    }
    Enable-ScheduledTask -TaskName $edgeTaskName | Out-Null
    Start-ScheduledTask -TaskName $edgeTaskName
    $edgeRecoveryConfig = [ordered]@{
        schemaVersion = 1
        taskName = $edgeTaskName
        runtimeRoot = $edgeRuntime
        edgeBaseUrl = $EdgeBaseUrl
        connectorTokenFile = [IO.Path]::GetFullPath($ConnectorTokenFile)
        ownerTokenFile = [IO.Path]::GetFullPath($OwnerTokenFile)
        policyPath = [IO.Path]::GetFullPath($PolicyPath)
        allowedOrigins = $AllowedOrigins
        ownerOAuthScopes = $OwnerOAuthScopes
        maxConcurrentRequests = $edgeMaxConcurrentRequests
        delaySeconds = $edgeDelaySeconds
        browserEnabled = [bool]$EnableBrowserWorker
        browserWorkerUrl = if ($EnableBrowserWorker) { "http://127.0.0.1:$BrowserPort" } else { $null }
        browserWorkerTokenFile = if ($EnableBrowserWorker) { [IO.Path]::GetFullPath($BrowserWorkerTokenFile) } else { $null }
        updatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    }
    Write-McpEdgeTaskRecoveryConfig -Path $edgeRecoveryConfigPath -Value $edgeRecoveryConfig
}
catch {
    $installationError = $_
    $recoveryErrors = [System.Collections.Generic.List[string]]::new()

    if ($cutoverCommitted) {
        try {
            $rollbackResult = & $cutoverScript `
                -InstallationRoot $installation `
                -Operation Rollback `
                -Execute `
                -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
            if ([string]$rollbackResult.status -ne 'cutover-ready') {
                throw 'Execution-node rollback returned unexpected evidence.'
            }
        }
        catch {
            $recoveryErrors.Add("state rollback: $($_.Exception.Message)")
        }
    }

    try {
        Restore-McpScheduledTaskSnapshot -TaskName $edgeTaskName -Snapshot $edgeTaskSnapshot
    }
    catch {
        $recoveryErrors.Add("edge task restore: $($_.Exception.Message)")
    }
    if ($EnableBrowserWorker) {
        try {
            Restore-McpScheduledTaskSnapshot -TaskName $browserTaskName -Snapshot $browserTaskSnapshot
        }
        catch {
            $recoveryErrors.Add("browser task restore: $($_.Exception.Message)")
        }
    }

    if ($recoveryErrors.Count -gt 0) {
        throw "Installation failed: $($installationError.Exception.Message). Recovery also failed: $($recoveryErrors -join '; ')"
    }
    throw $installationError
}

[pscustomobject]@{
    installed = $true
    releaseId = $releaseId
    ownershipMode = 'edge-only'
    edgeTask = [string]$edgeTaskResult.taskName
    recoveryConfig = $edgeRecoveryConfigPath
    browserTask = if ($EnableBrowserWorker) { $browserTaskName } else { $null }
    installationRoot = $installation
    projectRoot = $project
} | ConvertTo-Json -Compress
