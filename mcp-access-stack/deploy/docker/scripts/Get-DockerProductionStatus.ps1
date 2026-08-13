[CmdletBinding()]
param(
    [string]$TaskPrefix = 'MCP Access Stack Docker'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')

function Get-TaskStatus {
    param([Parameter(Mandatory = $true)][string]$TaskName)

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        return [pscustomobject]@{
            state = 'Missing'
            releaseId = 'unknown'
            executable = 'missing'
            nodeRuntime = [pscustomobject]@{
                mode = 'unavailable'
                nodePath = $null
                runtimeRoot = $null
                releaseId = $null
            }
        }
    }
    $releaseId = Get-McpScheduledTaskReleaseId -Task $task
    $actions = @($task.Actions)
    $executable = if ($actions.Count -eq 1) {
        [System.IO.Path]::GetFileName([string]$actions[0].Execute)
    }
    else {
        'invalid'
    }
    return [pscustomobject]@{
        state = [string]$task.State
        releaseId = if ($releaseId) { [string]$releaseId } else { 'unknown' }
        executable = $executable
        nodeRuntime = Get-McpScheduledTaskNodeRuntimeDescriptor -Task $task
    }
}

function Get-HostOwnershipStatus {
    param([Parameter(Mandatory = $true)][ValidateSet('agent', 'browser-worker')][string]$Component)

    $runtimeDirectory = Join-Path $root "runtime\windows-services\production\$Component"
    $runnerLeasePath = Join-Path $runtimeDirectory 'runner-lease.json'
    if (-not (Test-Path -LiteralPath $runnerLeasePath -PathType Leaf)) {
        return 'missing'
    }

    try {
        $lease = Read-McpJsonFile -Path $runnerLeasePath
        $updatedAt = [DateTimeOffset]$lease.updatedAtUtc
        $ageSeconds = ([DateTimeOffset]::UtcNow - $updatedAt).TotalSeconds
        $runnerPid = [int]$lease.runnerPid
        if (
            [int]$lease.version -ne 2 -or
            [string]$lease.component -ne $Component -or
            [string]$lease.environment -ne 'production' -or
            $runnerPid -le 0
        ) {
            return 'invalid'
        }
        if (-not (Test-McpProcessAlive -ProcessId $runnerPid)) {
            return 'process-missing'
        }
        if ($ageSeconds -gt 15 -or $ageSeconds -lt -60) {
            return 'stale'
        }
        return 'task-owned-healthy'
    }
    catch {
        return 'invalid'
    }
}

function Get-RunningComponentReleaseText {
    param([Parameter(Mandatory = $true)][ValidateSet('agent', 'browser-worker')][string]$Component)

    $ids = @(
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $line = [string]$_.CommandLine
                $line.Contains('Run-DockerHostComponent.mjs') -and
                $line.Contains("--component $Component") -and
                $line.Contains('--environment production')
            } |
            ForEach-Object { Get-McpReleaseIdFromText -Text ([string]$_.CommandLine) } |
            Where-Object { $_ } |
            Select-Object -Unique
    )
    if ($ids.Count -eq 0) { return 'none' }
    if ($ids.Count -eq 1) { return [string]$ids[0] }
    return 'multiple:' + ($ids -join ',')
}

function Get-PointerReleaseText {
    param([Parameter(Mandatory = $true)][ValidateSet('active', 'candidate')][string]$Name)

    try {
        $pointer = Read-McpReleasePointer -Name $Name -Root $root -AllowMissing
        if (-not $pointer) { return 'missing' }
        $eligible = Assert-McpReleasePointerEligible -Pointer $pointer -Root $root
        return [string]$eligible.releaseId
    }
    catch {
        return 'invalid'
    }
}

function Get-HttpStatusText {
    param([Parameter(Mandatory = $true)][string]$Uri)

    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 5
        return [string][int]$response.StatusCode
    }
    catch {
        $responseProperty = $_.Exception.PSObject.Properties['Response']
        $response = if ($responseProperty) { $responseProperty.Value } else { $null }
        if ($response -and $null -ne $response.StatusCode) {
            return [string][int]$response.StatusCode
        }
        return 'unavailable'
    }
}

function Get-ContainerState {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$RequireHealth
    )

    $raw = & docker inspect $Name 2>$null
    if ($LASTEXITCODE -ne 0) {
        return [pscustomobject]@{ state = 'missing'; restarts = 0 }
    }

    $inspection = @($raw | ConvertFrom-Json)[0]
    $state = if (-not [bool]$inspection.State.Running) {
        'stopped'
    }
    elseif ($RequireHealth) {
        $healthProperty = $inspection.State.PSObject.Properties['Health']
        if ($healthProperty) { [string]$healthProperty.Value.Status } else { 'running' }
    }
    else {
        'running'
    }

    return [pscustomobject]@{
        state = $state
        restarts = [int]$inspection.RestartCount
    }
}

function Get-NodeExecutableVersionText {
    param([AllowNull()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return 'unknown' }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'missing' }
    try {
        $version = [string](& $Path --version 2>$null)
        if ($LASTEXITCODE -ne 0) { return 'invalid' }
        $version = $version.Trim()
        if ($version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { return 'invalid' }
        return $version
    }
    catch {
        return 'invalid'
    }
}

$root = Get-McpProjectRoot
$activeRelease = Get-PointerReleaseText -Name 'active'
$candidateRelease = Get-PointerReleaseText -Name 'candidate'
$composeEnvPath = Join-Path $root '.runtime-private\docker\production\compose.env'
$imageTagLine = if (Test-Path -LiteralPath $composeEnvPath -PathType Leaf) {
    Get-Content -LiteralPath $composeEnvPath | Where-Object { $_ -match '^MCP_IMAGE_TAG=' } | Select-Object -First 1
}
else {
    $null
}
$containerRelease = if ($imageTagLine) { $imageTagLine.Substring('MCP_IMAGE_TAG='.Length) } else { 'unknown' }
$agentTask = Get-TaskStatus -TaskName "$TaskPrefix production agent"
$browserTask = Get-TaskStatus -TaskName "$TaskPrefix production browser-worker"
$nodeRuntimeUpdateTask = Get-TaskStatus -TaskName "$TaskPrefix production node-runtime-update"
$promotionTaskName = "$TaskPrefix production promotion"
$promotionTask = Get-ScheduledTask -TaskName $promotionTaskName -ErrorAction SilentlyContinue
$promotionTaskState = if ($promotionTask) { [string]$promotionTask.State } else { 'NotInstalled' }
$promotionTaskRunLevel = if ($promotionTask) { [string]$promotionTask.Principal.RunLevel } else { 'not-installed' }
$promotionTaskAction = if ($promotionTask -and @($promotionTask.Actions).Count -eq 1) {
    [System.IO.Path]::GetFileName([string]$promotionTask.Actions[0].Execute)
}
else {
    if ($promotionTask) { 'invalid' } else { 'not-installed' }
}
$nodeRuntimeMode = if (
    [string]$agentTask.nodeRuntime.mode -eq [string]$browserTask.nodeRuntime.mode
) {
    [string]$agentTask.nodeRuntime.mode
}
else {
    'mixed-invalid'
}
$nodeBuildVersion = 'unknown'
$nodeTaskRuntimeVersion = 'unknown'
$nodeKnownGoodVersion = 'not-applicable'
$nodeRollbackVersion = 'not-applicable'
$nodeUpdaterTaskStatus = if ($nodeRuntimeUpdateTask.state -eq 'Missing') {
    'not-applicable'
}
else {
    'unexpected:' + [string]$nodeRuntimeUpdateTask.state
}

if ($nodeRuntimeMode -eq 'direct-pinned') {
    $nodePaths = @(
        @(
            [string]$agentTask.nodeRuntime.nodePath,
            [string]$browserTask.nodeRuntime.nodePath
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    )
    $nodeTaskRuntimeVersion = if ($nodePaths.Count -eq 1) {
        Get-NodeExecutableVersionText -Path ([string]$nodePaths[0])
    }
    else {
        'mixed-invalid'
    }
}
elseif ($nodeRuntimeMode -eq 'managed') {
    $nodeKnownGoodVersion = 'state-uninitialized'
    $nodeRollbackVersion = 'none'
    $nodeUpdaterTaskStatus = [string]$nodeRuntimeUpdateTask.state
}
else {
    $nodeKnownGoodVersion = 'unavailable'
    $nodeRollbackVersion = 'unavailable'
    $nodeUpdaterTaskStatus = [string]$nodeRuntimeUpdateTask.state
}

try {
    $activePointer = Read-McpReleasePointer -Name 'active' -Root $root -AllowMissing
    if ($activePointer) {
        $activeEligible = Assert-McpReleasePointerEligible -Pointer $activePointer -Root $root
        $activeManifest = Read-McpJsonFile -Path (Join-Path ([string]$activeEligible.path) 'manifest.json')
        $nodeBuildVersion = [string]$activeManifest.nodeVersion
        if ($nodeRuntimeMode -eq 'managed') {
            $nodeState = Read-McpNodeReleaseState -ReleaseId ([string]$activeEligible.releaseId) -ProjectRoot $root -AllowMissing
            if ($nodeState) {
                $nodeKnownGoodVersion = [string]$nodeState.knownGood.version
                $nodeTaskRuntimeVersion = $nodeKnownGoodVersion
                if ($nodeState.rollback) {
                    $nodeRollbackVersion = [string]$nodeState.rollback.version
                }
            }
        }
    }
}
catch {
    if ($nodeRuntimeMode -eq 'managed') {
        $nodeKnownGoodVersion = 'invalid'
        $nodeTaskRuntimeVersion = 'invalid'
    }
}
$agentOwnership = Get-HostOwnershipStatus -Component 'agent'
$browserOwnership = Get-HostOwnershipStatus -Component 'browser-worker'
$agentProcessRelease = Get-RunningComponentReleaseText -Component 'agent'
$browserProcessRelease = Get-RunningComponentReleaseText -Component 'browser-worker'
$gatewayLive = Get-HttpStatusText -Uri 'http://127.0.0.1:3310/health/live'
$gatewayReady = Get-HttpStatusText -Uri 'http://127.0.0.1:3310/health/ready'
$proxyLive = Get-HttpStatusText -Uri 'http://127.0.0.1:3300/health/live'
$browserLive = Get-HttpStatusText -Uri 'http://127.0.0.1:3350/health/live'
$browserReady = Get-HttpStatusText -Uri 'http://127.0.0.1:3350/health/ready'
$gatewayContainer = Get-ContainerState -Name 'mcp-access-stack-production-gateway-1' -RequireHealth
$proxyContainer = Get-ContainerState -Name 'mcp-access-stack-production-proxy-1' -RequireHealth
$tunnelContainer = Get-ContainerState -Name 'mcp-access-stack-production-tunnel-1'
$restartCount = $gatewayContainer.restarts + $proxyContainer.restarts + $tunnelContainer.restarts

Write-Output ('Active release:           {0}' -f $activeRelease)
Write-Output ('Candidate release:        {0}' -f $candidateRelease)
Write-Output ('Container release:        {0}' -f $containerRelease)
Write-Output ('Agent task release:       {0}' -f $agentTask.releaseId)
Write-Output ('Agent process release:    {0}' -f $agentProcessRelease)
Write-Output ('Browser task release:     {0}' -f $browserTask.releaseId)
Write-Output ('Browser process release:  {0}' -f $browserProcessRelease)
Write-Output ('Node runtime mode:        {0}' -f $nodeRuntimeMode)
Write-Output ('Node build version:       {0}' -f $nodeBuildVersion)
Write-Output ('Node task runtime:        {0}' -f $nodeTaskRuntimeVersion)
Write-Output ('Node known-good runtime:  {0}' -f $nodeKnownGoodVersion)
Write-Output ('Node rollback runtime:    {0}' -f $nodeRollbackVersion)
Write-Output ('Node updater task:        {0}' -f $nodeUpdaterTaskStatus)
Write-Output ('Promotion task:           {0}' -f $promotionTaskState)
Write-Output ('Promotion run level:      {0}' -f $promotionTaskRunLevel)
Write-Output ('Promotion executable:     {0}' -f $promotionTaskAction)
Write-Output ''
Write-Output ('Agent task:               {0}' -f $agentTask.state)
Write-Output ('Agent task executable:    {0}' -f $agentTask.executable)
Write-Output ('Agent ownership:          {0}' -f $agentOwnership)
Write-Output ('Agent connected:          {0}' -f ($gatewayReady -eq '200').ToString().ToLowerInvariant())
Write-Output ('Gateway live:             {0}' -f $gatewayLive)
Write-Output ('Gateway ready:            {0}' -f $gatewayReady)
Write-Output ('Proxy live:               {0}' -f $proxyLive)
Write-Output ''
Write-Output ('Browser Worker task:      {0}' -f $browserTask.state)
Write-Output ('Browser task executable:  {0}' -f $browserTask.executable)
Write-Output ('Browser ownership:        {0}' -f $browserOwnership)
Write-Output ('Browser Worker live:      {0}' -f $browserLive)
Write-Output ('Browser connected:        {0}' -f ($browserReady -eq '200').ToString().ToLowerInvariant())
Write-Output ('Browser ready:            {0}' -f $browserReady)
Write-Output ''
Write-Output ('Gateway container:        {0}' -f $gatewayContainer.state)
Write-Output ('Proxy container:          {0}' -f $proxyContainer.state)
Write-Output ('Tunnel container:         {0}' -f $tunnelContainer.state)
Write-Output ('Container restarts:       {0}' -f $restartCount)
