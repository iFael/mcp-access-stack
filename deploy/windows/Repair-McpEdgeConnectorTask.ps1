[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RequiredProperty {
    param(
        [Parameter(Mandatory = $true)][object]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        throw "Edge Connector recovery configuration is missing: $Name"
    }
    return $property.Value
}

function Assert-McpRepairInstallerResult {
    param([Parameter(Mandatory = $true)][object[]]$Output)

    if ($Output.Count -ne 1) {
        throw 'Edge Connector task repair installer failed.'
    }
    $result = [string]$Output[0] | ConvertFrom-Json
    if ([string]$result.status -notin @('installed', 'already-installed') -or $result.activated -ne $true) {
        throw 'Edge Connector task repair installer returned unexpected evidence.'
    }
    return $result
}

$installation = [IO.Path]::GetFullPath($InstallationRoot)
$statePath = Join-Path $installation 'state\lifecycle-state.v1.json'
$configPath = Join-Path $installation 'state\edge-task-config.v1.json'
foreach ($required in @($statePath, $configPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Edge Connector recovery dependency was not found: $required"
    }
}

$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if ([int]$state.version -ne 1 -or $null -eq $state.active) {
    throw 'Edge Connector recovery requires one active execution-node release.'
}
$releaseId = [string]$state.active.releaseId
$activeManifestSha256 = [string]$state.active.manifestSha256
if ($releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or
    $activeManifestSha256 -notmatch '^[a-f0-9]{64}$') {
    throw 'Edge Connector recovery active release pointer is invalid.'
}

$activeReleaseRoot = Join-Path $installation ("releases\$releaseId")
$activeManifestPath = Join-Path $activeReleaseRoot 'execution-node-manifest.json'
$installerPath = Join-Path $activeReleaseRoot 'deploy\windows\Install-McpEdgeConnectorTask.ps1'
foreach ($required in @($activeManifestPath, $installerPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Edge Connector recovery active release dependency was not found: $required"
    }
}
$observedManifestSha256 = (Get-FileHash -LiteralPath $activeManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($observedManifestSha256 -ne $activeManifestSha256.ToLowerInvariant()) {
    throw 'Edge Connector recovery active release manifest does not match lifecycle state.'
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ([int]$config.schemaVersion -ne 1) {
    throw 'Unsupported Edge Connector recovery configuration version.'
}
$taskName = [string](Get-RequiredProperty -InputObject $config -Name 'taskName')
$runtimeRoot = [IO.Path]::GetFullPath([string](Get-RequiredProperty -InputObject $config -Name 'runtimeRoot'))
$edgeBaseUrl = [string](Get-RequiredProperty -InputObject $config -Name 'edgeBaseUrl')
$connectorTokenFile = [IO.Path]::GetFullPath([string](Get-RequiredProperty -InputObject $config -Name 'connectorTokenFile'))
$ownerTokenFile = [IO.Path]::GetFullPath([string](Get-RequiredProperty -InputObject $config -Name 'ownerTokenFile'))
$policyPath = [IO.Path]::GetFullPath([string](Get-RequiredProperty -InputObject $config -Name 'policyPath'))
$allowedOrigins = [string](Get-RequiredProperty -InputObject $config -Name 'allowedOrigins')
$ownerOAuthScopes = [string](Get-RequiredProperty -InputObject $config -Name 'ownerOAuthScopes')
$mcpSessionModeProperty = $config.PSObject.Properties['mcpSessionMode']
$mcpSessionMode = if ($null -eq $mcpSessionModeProperty -or [string]::IsNullOrWhiteSpace([string]$mcpSessionModeProperty.Value)) { 'stateless' } else { [string]$mcpSessionModeProperty.Value }
if ($mcpSessionMode -notin @('stateless', 'stateful-experiment')) {
    throw 'Edge Connector recovery configuration contains an invalid MCP session mode.'
}
$maxConcurrentRequests = [int](Get-RequiredProperty -InputObject $config -Name 'maxConcurrentRequests')
$delaySeconds = [int](Get-RequiredProperty -InputObject $config -Name 'delaySeconds')
$browserEnabled = [bool](Get-RequiredProperty -InputObject $config -Name 'browserEnabled')

$plan = [ordered]@{
    status = if ($Execute) { 'ready-to-repair' } else { 'planned' }
    installationRoot = $installation
    taskName = $taskName
    activeReleaseId = $releaseId
    activeManifestSha256 = $activeManifestSha256
    configPath = $configPath
    installerPath = $installerPath
    execute = [bool]$Execute
}
if (-not $Execute) {
    [pscustomobject]$plan | ConvertTo-Json -Compress
    return
}

$parameters = @{
    InstallationRoot = $installation
    ReleaseId = $releaseId
    RuntimeRoot = $runtimeRoot
    EdgeBaseUrl = $edgeBaseUrl
    ConnectorTokenFile = $connectorTokenFile
    OwnerTokenFile = $ownerTokenFile
    PolicyPath = $policyPath
    AllowedOrigins = $allowedOrigins
    OwnerOAuthScopes = $ownerOAuthScopes
    McpSessionMode = $mcpSessionMode
    MaxConcurrentRequests = $maxConcurrentRequests
    DelaySeconds = $delaySeconds
    TaskName = $taskName
    Execute = $true
    Force = $false
    Activate = $true
    AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
}
if ($browserEnabled) {
    $parameters.EnableBrowserWorker = $true
    $parameters.BrowserWorkerUrl = [string](Get-RequiredProperty -InputObject $config -Name 'browserWorkerUrl')
    $parameters.BrowserWorkerTokenFile = [IO.Path]::GetFullPath([string](Get-RequiredProperty -InputObject $config -Name 'browserWorkerTokenFile'))
}

$forceRepair = $false
$installerResult = $null
try {
    $installerOutput = @(& $installerPath @parameters)
    $installerResult = Assert-McpRepairInstallerResult -Output $installerOutput
}
catch {
    if (-not $_.Exception.Message.StartsWith('Scheduled Task exists with a different Edge Connector contract:', [StringComparison]::Ordinal)) {
        throw
    }
    $forceRepair = $true
}

if ($forceRepair) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing -and [string]$existing.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
        $stopDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 250
            $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        } while ($existing -and [string]$existing.State -eq 'Running' -and [DateTimeOffset]::UtcNow -lt $stopDeadline)
        if ($existing -and [string]$existing.State -eq 'Running') {
            throw "Edge Connector recovery could not stop the stale task: $taskName"
        }
    }

    $parameters.Force = $true
    $installerOutput = @(& $installerPath @parameters)
    $installerResult = Assert-McpRepairInstallerResult -Output $installerOutput
}

$currentTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $forceRepair -and
    [string]$installerResult.status -eq 'already-installed' -and
    $currentTask -and [string]$currentTask.State -eq 'Running') {
    [pscustomobject]@{
        status = 'already-running'
        taskName = $taskName
        activeReleaseId = $releaseId
        activeManifestSha256 = $activeManifestSha256
        installerStatus = [string]$installerResult.status
        activated = $true
        started = $true
    } | ConvertTo-Json -Compress
    return
}

if ($null -eq $currentTask -or [string]$currentTask.State -ne 'Running') {
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
}
$startDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
do {
    Start-Sleep -Milliseconds 250
    $startedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
} while (($null -eq $startedTask -or [string]$startedTask.State -ne 'Running') -and [DateTimeOffset]::UtcNow -lt $startDeadline)
if ($null -eq $startedTask -or [string]$startedTask.State -ne 'Running') {
    throw "Edge Connector recovery did not reach Running: $taskName"
}

[pscustomobject]@{
    status = 'repaired'
    taskName = $taskName
    activeReleaseId = $releaseId
    activeManifestSha256 = $activeManifestSha256
    installerStatus = [string]$installerResult.status
    forced = [bool]$forceRepair
    activated = $true
    started = $true
} | ConvertTo-Json -Compress
