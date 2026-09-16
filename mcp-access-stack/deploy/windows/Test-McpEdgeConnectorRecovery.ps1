[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repairSource = Join-Path $PSScriptRoot 'Repair-McpEdgeConnectorTask.ps1'
if (-not (Test-Path -LiteralPath $repairSource -PathType Leaf)) {
    throw 'Edge Connector repair script is missing.'
}

function Write-TestJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    [IO.File]::WriteAllText(
        $Path,
        (($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('mcp-edge-repair-' + [guid]::NewGuid().ToString('N'))
$installationRoot = Join-Path $testRoot 'installation'
$releaseId = '1.1.0-beta.repair-fixture'
$releaseRoot = Join-Path $installationRoot "releases\$releaseId"
$releaseScripts = Join-Path $releaseRoot 'deploy\windows'
$manifestPath = Join-Path $releaseRoot 'execution-node-manifest.json'
$capturePath = Join-Path $testRoot 'capture.json'
$taskName = 'MCP Access Stack repair fixture ' + [guid]::NewGuid().ToString('N')
$global:McpEdgeRecoveryMockTaskState = 'Missing'

function Get-ScheduledTask {
    param([string]$TaskName, [object]$ErrorAction)
    if ($global:McpEdgeRecoveryMockTaskState -eq 'Missing') { return $null }
    return [pscustomobject]@{ State = $global:McpEdgeRecoveryMockTaskState }
}
function Stop-ScheduledTask {
    param([string]$TaskName, [object]$ErrorAction)
    $global:McpEdgeRecoveryMockTaskState = 'Ready'
}
function Start-ScheduledTask {
    param([string]$TaskName, [object]$ErrorAction)
    $global:McpEdgeRecoveryMockTaskState = 'Running'
}

try {
    New-Item -ItemType Directory -Force -Path $releaseScripts | Out-Null
    Copy-Item -LiteralPath $repairSource -Destination (Join-Path $releaseScripts 'Repair-McpEdgeConnectorTask.ps1')

    $fixtureInstaller = @'
[CmdletBinding()]
param(
    [string]$InstallationRoot,
    [string]$ReleaseId,
    [string]$RuntimeRoot,
    [string]$EdgeBaseUrl,
    [string]$ConnectorTokenFile,
    [string]$OwnerTokenFile,
    [string]$PolicyPath,
    [string]$AllowedOrigins,
    [string]$OwnerOAuthScopes,
    [int]$MaxConcurrentRequests,
    [int]$DelaySeconds,
    [string]$TaskName,
    [switch]$EnableBrowserWorker,
    [string]$BrowserWorkerUrl,
    [string]$BrowserWorkerTokenFile,
    [switch]$Execute,
    [switch]$Force,
    [switch]$Activate,
    [switch]$AllowUnsignedDevelopment
)
if ($env:MCP_EDGE_REPAIR_REQUIRE_FORCE -eq 'true' -and -not $Force) {
    throw "Scheduled Task exists with a different Edge Connector contract: $TaskName"
}
$status = if ([string]::IsNullOrWhiteSpace([string]$env:MCP_EDGE_REPAIR_INSTALLER_STATUS)) { 'installed' } else { [string]$env:MCP_EDGE_REPAIR_INSTALLER_STATUS }
$record = [ordered]@{
    installationRoot = $InstallationRoot
    releaseId = $ReleaseId
    runtimeRoot = $RuntimeRoot
    edgeBaseUrl = $EdgeBaseUrl
    connectorTokenFile = $ConnectorTokenFile
    ownerTokenFile = $OwnerTokenFile
    policyPath = $PolicyPath
    allowedOrigins = $AllowedOrigins
    ownerOAuthScopes = $OwnerOAuthScopes
    maxConcurrentRequests = $MaxConcurrentRequests
    delaySeconds = $DelaySeconds
    taskName = $TaskName
    browserEnabled = [bool]$EnableBrowserWorker
    browserWorkerUrl = $BrowserWorkerUrl
    browserWorkerTokenFile = $BrowserWorkerTokenFile
    execute = [bool]$Execute
    force = [bool]$Force
    activate = [bool]$Activate
    allowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
}
[IO.File]::WriteAllText($env:MCP_EDGE_REPAIR_CAPTURE, (($record | ConvertTo-Json -Depth 8) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ status = $status; activated = [bool]$Activate } | ConvertTo-Json -Compress
'@
    [IO.File]::WriteAllText(
        (Join-Path $releaseScripts 'Install-McpEdgeConnectorTask.ps1'),
        $fixtureInstaller,
        [Text.UTF8Encoding]::new($false)
    )

    [IO.File]::WriteAllText($manifestPath, "{}`n", [Text.UTF8Encoding]::new($false))
    $manifestSha = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-TestJson -Path (Join-Path $installationRoot 'state\lifecycle-state.v1.json') -Value ([ordered]@{
        version = 1
        active = [ordered]@{
            releaseId = $releaseId
            manifestSha256 = $manifestSha
            materializedAt = '2026-09-16T00:00:00.000Z'
        }
        candidate = $null
        previous = $null
        updatedAt = '2026-09-16T00:00:00.000Z'
    })
    Write-TestJson -Path (Join-Path $installationRoot 'state\edge-task-config.v1.json') -Value ([ordered]@{
        schemaVersion = 1
        taskName = $taskName
        runtimeRoot = (Join-Path $installationRoot 'runtime\edge-connector')
        edgeBaseUrl = 'https://edge.example'
        connectorTokenFile = (Join-Path $installationRoot 'secrets\connector-token.txt')
        ownerTokenFile = (Join-Path $installationRoot 'secrets\owner-token.txt')
        policyPath = (Join-Path $installationRoot 'workspace-agent\policy.json')
        allowedOrigins = 'https://chatgpt.com,https://chat.openai.com'
        ownerOAuthScopes = 'workspaces:read'
        maxConcurrentRequests = 8
        delaySeconds = 15
        browserEnabled = $false
        browserWorkerUrl = $null
        browserWorkerTokenFile = $null
        updatedAt = '2026-09-16T00:00:00.000Z'
    })

    $repair = Join-Path $releaseScripts 'Repair-McpEdgeConnectorTask.ps1'
    $plan = @(& $repair -InstallationRoot $installationRoot)
    if ($plan.Count -ne 1) { throw 'Recovery plan must emit exactly one JSON document.' }
    $planValue = [string]$plan[0] | ConvertFrom-Json
    if ([string]$planValue.status -ne 'planned' -or
        [string]$planValue.activeReleaseId -ne $releaseId -or
        $planValue.execute -ne $false -or
        (Test-Path -LiteralPath $capturePath)) {
        throw 'Recovery planning returned unexpected evidence or invoked the installer.'
    }

    $env:MCP_EDGE_REPAIR_CAPTURE = $capturePath
    try {
        $result = @(& $repair -InstallationRoot $installationRoot -Execute -AllowUnsignedDevelopment)
    }
    finally {
        $env:MCP_EDGE_REPAIR_CAPTURE = $null
    }
    if ($result.Count -ne 1) { throw 'Recovery execution must emit exactly one JSON document.' }
    $resultValue = [string]$result[0] | ConvertFrom-Json
    if ([string]$resultValue.status -ne 'repaired' -or
        [string]$resultValue.activeReleaseId -ne $releaseId -or
        $resultValue.activated -ne $true -or
        $resultValue.started -ne $true) {
        throw 'Recovery execution returned unexpected evidence.'
    }
    if ($global:McpEdgeRecoveryMockTaskState -ne 'Running') {
        throw 'Recovery did not start the repaired task.'
    }

    $capture = Get-Content -LiteralPath $capturePath -Raw | ConvertFrom-Json
    if ([string]$capture.releaseId -ne $releaseId -or
        [string]$capture.taskName -ne $taskName -or
        $capture.execute -ne $true -or
        $capture.force -ne $false -or
        $capture.activate -ne $true -or
        $capture.allowUnsignedDevelopment -ne $true) {
        throw 'Recovery did not invoke the canonical installer contract.'
    }
    [IO.File]::Delete($capturePath)
    $env:MCP_EDGE_REPAIR_CAPTURE = $capturePath
    $env:MCP_EDGE_REPAIR_INSTALLER_STATUS = 'already-installed'
    try {
        $alreadyRunning = @(& $repair -InstallationRoot $installationRoot -Execute -AllowUnsignedDevelopment)
    }
    finally {
        $env:MCP_EDGE_REPAIR_CAPTURE = $null
        $env:MCP_EDGE_REPAIR_INSTALLER_STATUS = $null
    }
    if ($alreadyRunning.Count -ne 1) { throw 'Running recovery validation must emit exactly one JSON document.' }
    $alreadyRunningValue = [string]$alreadyRunning[0] | ConvertFrom-Json
    $runningCapture = Get-Content -LiteralPath $capturePath -Raw | ConvertFrom-Json
    if ([string]$alreadyRunningValue.status -ne 'already-running' -or
        $alreadyRunningValue.started -ne $true -or
        $runningCapture.force -ne $false) {
        throw 'Recovery accepted a Running task without canonical no-force validation.'
    }

    [IO.File]::Delete($capturePath)
    $global:McpEdgeRecoveryMockTaskState = 'Running'
    $env:MCP_EDGE_REPAIR_CAPTURE = $capturePath
    $env:MCP_EDGE_REPAIR_REQUIRE_FORCE = 'true'
    try {
        $staleRepair = @(& $repair -InstallationRoot $installationRoot -Execute -AllowUnsignedDevelopment)
    }
    finally {
        $env:MCP_EDGE_REPAIR_CAPTURE = $null
        $env:MCP_EDGE_REPAIR_REQUIRE_FORCE = $null
    }
    if ($staleRepair.Count -ne 1) { throw 'Stale Running recovery must emit exactly one JSON document.' }
    $staleRepairValue = [string]$staleRepair[0] | ConvertFrom-Json
    $staleCapture = Get-Content -LiteralPath $capturePath -Raw | ConvertFrom-Json
    if ([string]$staleRepairValue.status -ne 'repaired' -or
        $staleRepairValue.started -ne $true -or
        $staleCapture.force -ne $true -or
        $global:McpEdgeRecoveryMockTaskState -ne 'Running') {
        throw 'Recovery did not force-repair a stale Running task after canonical mismatch detection.'
    }

    Add-Content -LiteralPath $manifestPath -Value 'tampered'
    $tamperRejected = $false
    try {
        $null = & $repair -InstallationRoot $installationRoot
    }
    catch {
        $tamperRejected = $_.Exception.Message.Contains('does not match lifecycle state')
    }
    if (-not $tamperRejected) {
        throw 'Recovery accepted an active release whose manifest no longer matches lifecycle state.'
    }

    Write-Output 'Edge Connector deterministic task recovery contract passed.'
}
finally {
    $env:MCP_EDGE_REPAIR_CAPTURE = $null
    Remove-Item Function:\Get-ScheduledTask -ErrorAction SilentlyContinue
    Remove-Item Function:\Stop-ScheduledTask -ErrorAction SilentlyContinue
    Remove-Item Function:\Start-ScheduledTask -ErrorAction SilentlyContinue
    Remove-Variable -Name McpEdgeRecoveryMockTaskState -Scope Global -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
