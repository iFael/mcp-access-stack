[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [string]$StateRoot,

    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'iFael/mcp-access-stack',

    [string]$CompanionTaskName = 'MCP V3 local companion',
    [string]$UpdaterTaskName = 'MCP V3 local updater',

    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'MCP V3 local updater task runner is intentionally gated. Re-run with -Execute.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required MCP V3 updater runner dependency is missing: $bootstrapPath"
    }
}

. $publicCommonPath
Assert-McpPublicFile -Path $publicCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicFile -Path $executionCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
. $executionCommonPath
Assert-McpPublicWindowsX64

$installation = [IO.Path]::GetFullPath($InstallationRoot)
$state = [IO.Path]::GetFullPath($StateRoot)
$requestPath = Join-Path $state 'update-request.v1.json'
$updatesRoot = Join-Path $state 'updates'
New-Item -ItemType Directory -Force -Path $updatesRoot | Out-Null

$request = $null
$operationId = $null
$requestedTag = $null
$resultPath = $null

function Write-McpV3UpdateResult {
    param([Parameter(Mandatory = $true)][object]$Value)
    if ([string]::IsNullOrWhiteSpace($script:resultPath)) {
        return
    }
    $temporary = "$($script:resultPath).tmp.$([guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText(
            $temporary,
            (($Value | ConvertTo-Json -Depth 6) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporary -Destination $script:resultPath -Force
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

# The existing five-minute updater task also supervises the already-installed
# companion. A version check may be skipped for 20 hours, but liveness must not.
# Never re-enable a disabled task or launch an unexpected executable.
function Ensure-McpV3LocalCompanionRunning {
    param(
        [Parameter(Mandatory = $true)][string]$InstallationRoot,
        [Parameter(Mandatory = $true)][string]$StateRoot,
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$CurrentUser
    )

    $tasks = @(Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop)
    if ($tasks.Count -ne 1) {
        throw 'MCP V3 local companion task is missing or ambiguous.'
    }
    $task = $tasks[0]
    $statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $InstallationRoot
    $releaseState = Read-McpWindowsExecutionNodeState -Path $statePath
    if ($null -eq $releaseState -or $null -eq $releaseState.active) {
        throw 'MCP V3 local companion recovery requires an active signed release.'
    }
    $releaseId = [string]$releaseState.active.releaseId
    if ($releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw 'MCP V3 local companion recovery release identity is invalid.'
    }
    $releaseRoot = [IO.Path]::GetFullPath((Join-Path $InstallationRoot ("releases\$releaseId")))
    $launcher = [IO.Path]::GetFullPath((Join-Path $releaseRoot 'compat\McpNodeHostLauncher.exe'))
    $actions = @($task.Actions)
    if ($actions.Count -ne 1 -or
        [string]$task.TaskPath -ne '\' -or
        -not (Test-McpWindowsAccountIdentityEquivalent -Left ([string]$task.Principal.UserId) -Right $CurrentUser) -or
        [string]$task.Principal.LogonType -notin @('Interactive', 'InteractiveToken') -or
        [string]$task.Principal.RunLevel -ne 'Limited' -or
        [string]$task.Settings.MultipleInstances -ne 'IgnoreNew' -or
        [string]$actions[0].Execute -ne $launcher -or
        [string]$actions[0].WorkingDirectory -ne $releaseRoot -or
        -not ([string]$actions[0].Arguments).Contains("MCP_V3_RELEASE_ROOT=$releaseRoot") -or
        -not ([string]$actions[0].Arguments).Contains("MCP_V3_STATE_ROOT=$StateRoot") -or
        -not ([string]$actions[0].Arguments).Contains('companion-cli.js')) {
        throw 'MCP V3 local companion task differs from the active release or owner; refusing recovery.'
    }

    if ([string]$task.State -eq 'Running') {
        return 'running'
    }
    if (-not [bool]$task.Settings.Enabled -or [string]$task.State -eq 'Disabled') {
        return 'disabled'
    }
    if ([string]$task.State -ne 'Ready') {
        throw "MCP V3 local companion task is not recoverable in state: $($task.State)"
    }
    Assert-McpPublicFile -Path $launcher -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    Start-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
        if ([string]$task.State -eq 'Running') {
            return 'restarted'
        }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw 'MCP V3 local companion task did not remain running after recovery.'
}

try {
    if (Test-Path -LiteralPath $requestPath -PathType Leaf) {
        $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
        if ([int]$request.version -ne 1) {
            throw 'MCP V3 local update request version is unsupported.'
        }
        $operationId = [string]$request.operationId
        if ($operationId -notmatch '^[a-f0-9]{32}$') {
            throw 'MCP V3 local update request operationId is invalid.'
        }
        $requestedTag = [string]$request.tag
        if (-not [string]::IsNullOrWhiteSpace($requestedTag) -and
            $requestedTag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z.-]+)?$') {
            throw 'MCP V3 local update request tag is invalid.'
        }
        $resultPath = Join-Path $updatesRoot ("result-$operationId.json")
    }
    else {
        $companionRecovery = Ensure-McpV3LocalCompanionRunning -InstallationRoot $installation -StateRoot $state -TaskName $CompanionTaskName -CurrentUser ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
        $settingsPath = Join-Path $state 'updater\settings.json'
        $autoUpdate = $true
        if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
            $autoUpdate = [bool](Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).autoUpdate
        }
        if (-not $autoUpdate) {
            [pscustomobject]@{ status = 'idle'; reason = 'no-request-and-auto-update-off'; companionRecovery = $companionRecovery } | ConvertTo-Json -Compress
            return
        }
        # The task also runs every few minutes to pick up requests; the release
        # check itself stays daily. The time is recorded before the check so a
        # failing check is not retried on every run.
        $lastCheckPath = Join-Path $state 'updater\last-auto-check.json'
        $lastCheck = $null
        if (Test-Path -LiteralPath $lastCheckPath -PathType Leaf) {
            try {
                $lastCheck = [DateTimeOffset](Get-Content -LiteralPath $lastCheckPath -Raw | ConvertFrom-Json).checkedAt
            }
            catch {
                $lastCheck = $null
            }
        }
        $now = [DateTimeOffset]::UtcNow
        if ($null -ne $lastCheck -and $lastCheck -le $now -and ($now - $lastCheck) -lt [TimeSpan]::FromHours(20)) {
            [pscustomobject]@{ status = 'idle'; reason = 'auto-update-checked-recently'; companionRecovery = $companionRecovery } | ConvertTo-Json -Compress
            return
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lastCheckPath) | Out-Null
        [IO.File]::WriteAllText(
            $lastCheckPath,
            (([ordered]@{ version = 1; checkedAt = $now.ToString('O') } | ConvertTo-Json -Compress) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
    }

    $updater = Join-Path $PSScriptRoot 'Update-McpV3Local.ps1'
    Assert-McpPublicFile -Path $updater -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

    $updaterArguments = @{
        Repository = $Repository
        InstallationRoot = $installation
        StateRoot = $state
        TaskName = $CompanionTaskName
        Execute = $true
        AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
    }
    if (-not [string]::IsNullOrWhiteSpace($requestedTag)) {
        $updaterArguments.Tag = $requestedTag
    }

    $output = @(& $updater @updaterArguments)
    if ($null -ne $request) {
        Write-McpV3UpdateResult -Value ([ordered]@{
            version = 1
            operationId = $operationId
            status = 'succeeded'
            tag = if ([string]::IsNullOrWhiteSpace($requestedTag)) { $null } else { $requestedTag }
            completedAt = [DateTimeOffset]::UtcNow.ToString('O')
            updaterOutput = ($output -join [Environment]::NewLine)
        })
    }
    $output
}
catch {
    if ($null -ne $request) {
        Write-McpV3UpdateResult -Value ([ordered]@{
            version = 1
            operationId = $operationId
            status = 'failed'
            tag = if ([string]::IsNullOrWhiteSpace($requestedTag)) { $null } else { $requestedTag }
            completedAt = [DateTimeOffset]::UtcNow.ToString('O')
            error = $_.Exception.Message
        })
    }
    throw
}
finally {
    if ($null -ne $request) {
        Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    }
}
