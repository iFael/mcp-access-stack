[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallationRoot,
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedRequestSha256,
    [Parameter(Mandatory = $true)][string]$BrokerTaskName,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-McpScheduledTaskSnapshot {
    param([Parameter(Mandatory = $true)][string]$TaskName)

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { return $null }
    [pscustomobject]@{
        taskName = $TaskName
        userId = [string]$task.Principal.UserId
        xml = Export-ScheduledTask -TaskName $TaskName
        wasRunning = [string]$task.State -eq 'Running'
        wasEnabled = [string]$task.State -ne 'Disabled'
    }
}

function Stop-McpScheduledTaskForReplacement {
    param([Parameter(Mandatory = $true)][string]$TaskName)

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task -or [string]$task.State -ne 'Running') { return }
    Stop-ScheduledTask -TaskName $TaskName
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 200
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not $task -or [string]$task.State -ne 'Running') { return }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "Scheduled Task did not stop before replacement: $TaskName"
}

function Remove-McpScheduledTaskIfPresent {
    param([Parameter(Mandatory = $true)][string]$TaskName)

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { return }
    Stop-McpScheduledTaskForReplacement -TaskName $TaskName
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

function Restore-McpScheduledTaskSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [AllowNull()][object]$Snapshot
    )

    $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $Snapshot) {
        if ($current) {
            Stop-McpScheduledTaskForReplacement -TaskName $TaskName
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }
        return
    }

    if ($current) {
        $currentXml = Export-ScheduledTask -TaskName $TaskName
        if ([string]$currentXml -eq [string]$Snapshot.xml) {
            $null = Set-McpWindowsScheduledTaskOwnerAccess -TaskName $TaskName -UserId ([string]$Snapshot.userId)
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

        Stop-McpScheduledTaskForReplacement -TaskName $TaskName
    }

    Register-ScheduledTask -TaskName $TaskName -Xml ([string]$Snapshot.xml) -Force | Out-Null
    $null = Set-McpWindowsScheduledTaskOwnerAccess -TaskName $TaskName -UserId ([string]$Snapshot.userId)
    if ([bool]$Snapshot.wasEnabled) { Enable-ScheduledTask -TaskName $TaskName | Out-Null }
    else { Disable-ScheduledTask -TaskName $TaskName | Out-Null }
    if ([bool]$Snapshot.wasRunning) { Start-ScheduledTask -TaskName $TaskName }
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

function Get-McpOptionalPropertyValue {
    param(
        [AllowNull()][object]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-McpEdgeHealthSnapshot {
    param([Parameter(Mandatory = $true)][string]$EdgeBaseUrl)

    $healthUrl = $EdgeBaseUrl.TrimEnd('/') + '/health'
    return Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 3 -ErrorAction Stop
}

function Wait-McpEdgeCutoverHealth {
    param(
        [Parameter(Mandatory = $true)][string]$EdgeBaseUrl,
        [AllowNull()][string]$PreviousConnectorInstanceId,
        [ValidateRange(5, 120)][int]$TimeoutSeconds = 30
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastDiagnostic = 'no health response'
    do {
        try {
            $health = Get-McpEdgeHealthSnapshot -EdgeBaseUrl $EdgeBaseUrl
            $runtime = Get-McpOptionalPropertyValue -InputObject $health -Name 'runtime'
            $connectorInstanceId = [string](Get-McpOptionalPropertyValue -InputObject $runtime -Name 'connectorInstanceId')
            $catalogContractRevision = [string](Get-McpOptionalPropertyValue -InputObject $runtime -Name 'catalogContractRevision')
            $service = [string](Get-McpOptionalPropertyValue -InputObject $health -Name 'service')
            $controlPlaneReady = [bool](Get-McpOptionalPropertyValue -InputObject $health -Name 'controlPlaneReady')
            $executionPlaneReady = [bool](Get-McpOptionalPropertyValue -InputObject $health -Name 'executionPlaneReady')
            $connectorReady = [bool](Get-McpOptionalPropertyValue -InputObject $health -Name 'connectorReady')
            $contractCompatible = [bool](Get-McpOptionalPropertyValue -InputObject $health -Name 'contractCompatible')
            $isNewConnector = -not [string]::IsNullOrWhiteSpace($connectorInstanceId) -and (
                [string]::IsNullOrWhiteSpace($PreviousConnectorInstanceId) -or
                $connectorInstanceId -ne $PreviousConnectorInstanceId
            )

            if ($service -eq 'mcp-edge-gateway' -and
                $controlPlaneReady -and
                $executionPlaneReady -and
                $connectorReady -and
                $contractCompatible -and
                $isNewConnector) {
                return [pscustomobject]@{
                    connectorInstanceId = $connectorInstanceId
                    catalogContractRevision = $catalogContractRevision
                    controlPlaneReady = $controlPlaneReady
                    executionPlaneReady = $executionPlaneReady
                    connectorReady = $connectorReady
                    contractCompatible = $contractCompatible
                }
            }

            $lastDiagnostic = "service=$service control=$controlPlaneReady execution=$executionPlaneReady connector=$connectorReady compatible=$contractCompatible connectorInstanceId=$connectorInstanceId"
        }
        catch {
            $lastDiagnostic = $_.Exception.Message
        }

        Start-Sleep -Milliseconds 500
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw "Edge post-cutover health gate failed after $TimeoutSeconds seconds. Last observation: $lastDiagnostic"
}

if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath)) {
    throw 'Access Stack cutover broker must run as a script file.'
}
$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
$edgeTaskInstaller = Join-Path $PSScriptRoot 'Install-McpEdgeConnectorTask.ps1'
$browserTaskInstaller = Join-Path $PSScriptRoot 'Install-McpBrowserWorkerTask.ps1'
$cutoverScript = Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeCutover.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath, $edgeTaskInstaller, $browserTaskInstaller, $cutoverScript)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required Access Stack cutover broker dependency is missing: $bootstrapPath"
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

$installation = [IO.Path]::GetFullPath($InstallationRoot)
$requestFile = [IO.Path]::GetFullPath($RequestPath)
$canonicalRequestPath = [IO.Path]::GetFullPath((Join-Path $installation 'state\access-stack-cutover-request.v1.json'))
if (-not $requestFile.Equals($canonicalRequestPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Access Stack cutover broker accepts only the canonical pending request path.'
}
$statePath = Join-Path $installation 'state\lifecycle-state.v1.json'
if (-not (Test-Path -LiteralPath $requestFile -PathType Leaf)) {
    throw 'No Access Stack cutover request is pending.'
}
$observedRequestSha256 = (Get-FileHash -LiteralPath $requestFile -Algorithm SHA256).Hash.ToLowerInvariant()
if ($observedRequestSha256 -ne $ExpectedRequestSha256.ToLowerInvariant()) {
    throw 'Access Stack cutover request failed SHA-256 validation.'
}

if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw 'Access Stack lifecycle state is missing.'
}

$request = Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json
$requestGuid = [guid]::Empty
if ([int]$request.schemaVersion -ne 1 -or
    -not [guid]::TryParse([string]$request.requestId, [ref]$requestGuid) -or
    $requestGuid -eq [guid]::Empty -or
    [string]$request.expectedReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or
    [string]$request.expectedManifestSha256 -notmatch '^[a-f0-9]{64}$' -or
    [int]$request.handoverDelaySeconds -lt 1 -or [int]$request.handoverDelaySeconds -gt 30) {
    throw 'Access Stack cutover request is malformed.'
}
try { $createdAt = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$request.createdAtUnixTimeMilliseconds) }
catch { throw 'Access Stack cutover request timestamp is invalid.' }
$age = [DateTimeOffset]::UtcNow - $createdAt
if ($age.TotalMinutes -lt -1 -or $age.TotalMinutes -gt 10) {
    throw 'Access Stack cutover request is outside the allowed freshness window.'
}

$state = Read-McpWindowsExecutionNodeState -Path $statePath
if ($null -eq $state -or $null -eq $state.candidate -or
    [string]$state.candidate.releaseId -ne [string]$request.expectedReleaseId -or
    [string]$state.candidate.manifestSha256 -ne [string]$request.expectedManifestSha256) {
    throw 'Access Stack cutover request no longer matches the staged candidate.'
}

$runsRoot = Join-Path $installation 'state\access-stack-cutover-runs'
$runDirectory = Join-Path $runsRoot ([string]$request.requestId)
if (Test-Path -LiteralPath $runDirectory) {
    throw 'Access Stack cutover request ID has already been consumed.'
}
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
Move-Item -LiteralPath $requestFile -Destination (Join-Path $runDirectory 'request.json')
$resultPath = Join-Path $runDirectory 'result.json'

function Write-McpCutoverBrokerResult {
    param([Parameter(Mandatory = $true)][object]$Value)
    $temporary = $resultPath + '.tmp-' + [guid]::NewGuid().ToString('N')
    try {
        [IO.File]::WriteAllText(
            $temporary,
            (($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
        [IO.File]::Move($temporary, $resultPath, $true)
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

$releaseId = [string]$request.expectedReleaseId
$edge = $request.edge
$mcpSessionMode = [string]$edge.mcpSessionMode
if ($mcpSessionMode -notin @('stateless', 'stateful-experiment')) {
    throw 'Access Stack cutover request contains an invalid MCP session mode.'
}
$browser = $request.browser
$edgeTaskName = [string]$edge.taskName
$browserTaskName = [string]$browser.taskName
$edgeRecoveryConfigPath = Join-Path $installation 'state\edge-task-config.v1.json'
$startedAt = [DateTimeOffset]::UtcNow.ToString('O')
Write-McpCutoverBrokerResult -Value ([ordered]@{
    schemaVersion = 1
    requestId = [string]$request.requestId
    releaseId = $releaseId
    status = 'running'
    brokerTaskName = $BrokerTaskName
    startedAt = $startedAt
})

$edgeParameters = @{
    InstallationRoot = $installation
    ReleaseId = $releaseId
    RuntimeRoot = [IO.Path]::GetFullPath([string]$edge.runtimeRoot)
    EdgeBaseUrl = [string]$edge.edgeBaseUrl
    ConnectorTokenFile = [IO.Path]::GetFullPath([string]$edge.connectorTokenFile)
    OwnerTokenFile = [IO.Path]::GetFullPath([string]$edge.ownerTokenFile)
    PolicyPath = [IO.Path]::GetFullPath([string]$edge.policyPath)
    AllowedOrigins = [string]$edge.allowedOrigins
    OwnerOAuthScopes = [string]$edge.ownerOAuthScopes
    McpSessionMode = $mcpSessionMode
    MaxConcurrentRequests = [int]$edge.maxConcurrentRequests
    DelaySeconds = [int]$edge.delaySeconds
    TaskName = $edgeTaskName
    EnableBrowserWorker = [bool]$browser.enabled
    BrowserWorkerUrl = "http://127.0.0.1:$([int]$browser.port)"
    Execute = $true
    Force = $true
    Activate = $false
    AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
}
if ([bool]$browser.enabled) {
    $edgeParameters.BrowserWorkerTokenFile = [IO.Path]::GetFullPath([string]$browser.tokenFile)
}

$browserParameters = $null
if ([bool]$browser.enabled) {
    $browserParameters = @{
        InstallationRoot = $installation
        ReleaseId = $releaseId
        RuntimeRoot = [IO.Path]::GetFullPath([string]$browser.runtimeRoot)
        BrowserTokenFile = [IO.Path]::GetFullPath([string]$browser.tokenFile)
        PrivateDirectory = [IO.Path]::GetFullPath([string]$browser.privateDirectory)
        UserDataDirectory = [IO.Path]::GetFullPath([string]$browser.userDataDirectory)
        SitePoliciesPath = [IO.Path]::GetFullPath([string]$browser.sitePoliciesPath)
        Port = [int]$browser.port
        TaskName = $browserTaskName
        Execute = $true
        Force = $true
        Activate = $false
        AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
    }
}

# Allow the initiating MCP request to return its handover evidence before replacing the Edge owner.
Start-Sleep -Seconds ([int]$request.handoverDelaySeconds)
$edgeTaskSnapshot = Get-McpScheduledTaskSnapshot -TaskName $edgeTaskName
$browserTaskSnapshot = if ([bool]$browser.enabled) { Get-McpScheduledTaskSnapshot -TaskName $browserTaskName } else { $null }
$previousConnectorInstanceId = $null
try {
    $previousHealth = Get-McpEdgeHealthSnapshot -EdgeBaseUrl ([string]$edge.edgeBaseUrl)
    $previousRuntime = Get-McpOptionalPropertyValue -InputObject $previousHealth -Name 'runtime'
    $previousConnectorInstanceId = [string](Get-McpOptionalPropertyValue -InputObject $previousRuntime -Name 'connectorInstanceId')
}
catch {
    $previousConnectorInstanceId = $null
}
$cutoverCommitted = $false
$edgeTaskResult = $null
$browserTaskResult = $null
$failureStage = $null
$failureCode = $null
$handoverTaskName = "$edgeTaskName handover $([string]$request.requestId)"
$handoverTaskCreated = $false
$handoverConnectorInstanceId = $null
$handoverEdgeParameters = @{}
foreach ($key in $edgeParameters.Keys) {
    $handoverEdgeParameters[$key] = $edgeParameters[$key]
}
$handoverEdgeParameters.TaskName = $handoverTaskName

try {
    if (Get-ScheduledTask -TaskName $handoverTaskName -ErrorAction SilentlyContinue) {
        throw "Access Stack handover Scheduled Task already exists: $handoverTaskName"
    }

    $handoverTaskResult = & $edgeTaskInstaller @handoverEdgeParameters | ConvertFrom-Json
    if ([string]$handoverTaskResult.taskName -ne $handoverTaskName) {
        throw 'Edge handover task installer returned unexpected evidence.'
    }
    $handoverTaskCreated = $true
    Enable-ScheduledTask -TaskName $handoverTaskName | Out-Null
    Start-ScheduledTask -TaskName $handoverTaskName

    $handoverHealth = Wait-McpEdgeCutoverHealth `
        -EdgeBaseUrl ([string]$edge.edgeBaseUrl) `
        -PreviousConnectorInstanceId $previousConnectorInstanceId
    $handoverConnectorInstanceId = [string]$handoverHealth.connectorInstanceId

    $cutoverResult = & $cutoverScript `
        -InstallationRoot $installation `
        -Operation Promote `
        -Execute `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
    if ([string]$cutoverResult.status -ne 'cutover-ready' -or
        [string]$cutoverResult.ownershipMode -ne 'edge-only' -or
        [string]$cutoverResult.activeReleaseId -ne $releaseId) {
        throw 'Execution-node Edge-only cutover returned unexpected evidence.'
    }
    $cutoverCommitted = $true

    Stop-McpScheduledTaskForReplacement -TaskName $edgeTaskName
    $edgeTaskResult = & $edgeTaskInstaller @edgeParameters | ConvertFrom-Json
    Enable-ScheduledTask -TaskName $edgeTaskName | Out-Null
    Start-ScheduledTask -TaskName $edgeTaskName
    try {
        $healthGate = Wait-McpEdgeCutoverHealth `
            -EdgeBaseUrl ([string]$edge.edgeBaseUrl) `
            -PreviousConnectorInstanceId $handoverConnectorInstanceId
    }
    catch {
        $failureStage = 'post-cutover-health'
        $failureCode = 'CUTOVER_POST_HEALTH_FAILED'
        throw
    }

    if ([bool]$browser.enabled) {
        Stop-McpScheduledTaskForReplacement -TaskName $browserTaskName
        $browserTaskResult = & $browserTaskInstaller @browserParameters | ConvertFrom-Json
        Enable-ScheduledTask -TaskName $browserTaskName | Out-Null
        Start-ScheduledTask -TaskName $browserTaskName
    }

    Remove-McpScheduledTaskIfPresent -TaskName $handoverTaskName
    $handoverTaskCreated = $false

    $edgeRecoveryConfig = [ordered]@{
        schemaVersion = 1
        taskName = $edgeTaskName
        runtimeRoot = [IO.Path]::GetFullPath([string]$edge.runtimeRoot)
        edgeBaseUrl = [string]$edge.edgeBaseUrl
        connectorTokenFile = [IO.Path]::GetFullPath([string]$edge.connectorTokenFile)
        ownerTokenFile = [IO.Path]::GetFullPath([string]$edge.ownerTokenFile)
        policyPath = [IO.Path]::GetFullPath([string]$edge.policyPath)
        allowedOrigins = [string]$edge.allowedOrigins
        ownerOAuthScopes = [string]$edge.ownerOAuthScopes
        mcpSessionMode = $mcpSessionMode
        maxConcurrentRequests = [int]$edge.maxConcurrentRequests
        delaySeconds = [int]$edge.delaySeconds
        browserEnabled = [bool]$browser.enabled
        browserWorkerUrl = if ([bool]$browser.enabled) { "http://127.0.0.1:$([int]$browser.port)" } else { $null }
        browserWorkerTokenFile = if ([bool]$browser.enabled) { [IO.Path]::GetFullPath([string]$browser.tokenFile) } else { $null }
        updatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    }
    Write-McpEdgeTaskRecoveryConfig -Path $edgeRecoveryConfigPath -Value $edgeRecoveryConfig

    Write-McpCutoverBrokerResult -Value ([ordered]@{
        schemaVersion = 1
        requestId = [string]$request.requestId
        releaseId = $releaseId
        status = 'passed'
        startedAt = $startedAt
        completedAt = [DateTimeOffset]::UtcNow.ToString('O')
        ownershipMode = 'edge-only'
        edgeTask = [string]$edgeTaskResult.taskName
        browserTask = if ([bool]$browser.enabled) { $browserTaskName } else { $null }
        healthGate = [ordered]@{
            status = 'passed'
            connectorInstanceId = [string]$healthGate.connectorInstanceId
            catalogContractRevision = [string]$healthGate.catalogContractRevision
            executionPlaneReady = [bool]$healthGate.executionPlaneReady
            connectorReady = [bool]$healthGate.connectorReady
            contractCompatible = [bool]$healthGate.contractCompatible
        }
        recoveryConfig = $edgeRecoveryConfigPath
    })
    exit 0
}
catch {
    $installationError = $_
    $recoveryErrors = [System.Collections.Generic.List[string]]::new()
    $rollbackAttempted = $false
    $rollbackStatus = 'not-attempted'
    $rollbackRestoredReleaseId = $null

    if ($cutoverCommitted) {
        $rollbackAttempted = $true
        try {
            $rollbackResult = & $cutoverScript `
                -InstallationRoot $installation `
                -Operation Rollback `
                -Execute `
                -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
            if ([string]$rollbackResult.status -ne 'cutover-ready') {
                throw 'Execution-node rollback returned unexpected evidence.'
            }
            $rollbackRestoredReleaseId = [string]$rollbackResult.activeReleaseId
        }
        catch { $recoveryErrors.Add("state rollback: $($_.Exception.Message)") }
    }

    try { Restore-McpScheduledTaskSnapshot -TaskName $edgeTaskName -Snapshot $edgeTaskSnapshot }
    catch { $recoveryErrors.Add("edge task restore: $($_.Exception.Message)") }
    if ([bool]$browser.enabled) {
        try { Restore-McpScheduledTaskSnapshot -TaskName $browserTaskName -Snapshot $browserTaskSnapshot }
        catch { $recoveryErrors.Add("browser task restore: $($_.Exception.Message)") }
    }

    if ($handoverTaskCreated) {
        try {
            Remove-McpScheduledTaskIfPresent -TaskName $handoverTaskName
            $handoverTaskCreated = $false
        }
        catch { $recoveryErrors.Add("handover task cleanup: $($_.Exception.Message)") }
    }

    if ($rollbackAttempted) {
        $rollbackStatus = if ($recoveryErrors.Count -eq 0) { 'passed' } else { 'failed' }
    }

    $errorMessage = if ($recoveryErrors.Count -gt 0) {
        "Installation failed: $($installationError.Exception.Message). Recovery also failed: $($recoveryErrors -join '; ')"
    }
    else { $installationError.Exception.Message }
    Write-McpCutoverBrokerResult -Value ([ordered]@{
        schemaVersion = 1
        requestId = [string]$request.requestId
        releaseId = $releaseId
        status = 'failed'
        startedAt = $startedAt
        completedAt = [DateTimeOffset]::UtcNow.ToString('O')
        failureStage = $failureStage
        failureCode = $failureCode
        rollback = [ordered]@{
            attempted = $rollbackAttempted
            status = $rollbackStatus
            restoredReleaseId = $rollbackRestoredReleaseId
        }
        error = $errorMessage
    })
    Write-Error $errorMessage
    exit 1
}
