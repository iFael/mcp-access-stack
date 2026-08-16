[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [ValidateSet('development', 'production')]
    [string]$Environment,

    [string]$TaskName,
    [string]$CredentialBrokerPath,

    [ValidateRange(0, 100)]
    [int]$RestartCount = 5,

    [ValidateRange(1, 3600)]
    [int]$RestartIntervalSeconds = 5,

    [ValidateRange(5, 600)]
    [int]$ReadinessTimeoutSeconds = 45,

    [ValidateRange(0, 300)]
    [int]$DelaySeconds = 15,

    [switch]$Execute,
    [switch]$Force,
    [switch]$Activate,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Quote-McpHostTaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"')) {
        throw 'Execution-node Scheduled Task arguments cannot contain quotes.'
    }
    return '"' + $Value + '"'
}

$installationRoot = [IO.Path]::GetFullPath($InstallationRoot)
$projectRoot = [IO.Path]::GetFullPath($ProjectRoot)
if ([string]::IsNullOrWhiteSpace($TaskName)) {
    $TaskName = "MCP Access Stack $Environment host"
}
$stableHostRoot = Join-Path $installationRoot 'host'
$stableHostPath = Join-Path $stableHostRoot 'McpHost.exe'
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$arguments = [System.Collections.Generic.List[string]]::new()
foreach ($value in @(
    '--run-active',
    '--installation-root', (Quote-McpHostTaskArgument $installationRoot),
    '--project-root', (Quote-McpHostTaskArgument $projectRoot),
    '--environment', $Environment,
    '--restart-count', ([string]$RestartCount),
    '--restart-interval-seconds', ([string]$RestartIntervalSeconds),
    '--readiness-timeout-seconds', ([string]$ReadinessTimeoutSeconds)
)) {
    $arguments.Add([string]$value)
}
if (-not [string]::IsNullOrWhiteSpace($CredentialBrokerPath)) {
    $resolvedBroker = [IO.Path]::GetFullPath($CredentialBrokerPath)
    $arguments.Add('--credential-broker-path')
    $arguments.Add((Quote-McpHostTaskArgument $resolvedBroker))
}
$argumentText = $arguments -join ' '

$plan = [ordered]@{
    taskName = $TaskName
    execute = $stableHostPath
    arguments = $argumentText
    workingDirectory = $stableHostRoot
    trigger = 'AtLogOn'
    triggerUser = $userId
    triggerDelaySeconds = $DelaySeconds
    logonType = 'Interactive'
    runLevel = 'Limited'
    multipleInstances = 'IgnoreNew'
    restartCount = 5
    restartIntervalSeconds = 60
    executionTimeLimitSeconds = 0
    hidden = $true
}

if (-not $Execute) {
    [pscustomobject]@{
        status = 'planned'
        changed = $false
        activated = $false
        plan = $plan
    } | ConvertTo-Json -Depth 8 -Compress
    return
}

if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath)) {
    throw 'Execution-node host task installer must run as a script file.'
}
$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required execution-node host-task dependency is missing: $bootstrapPath"
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

if (-not (Test-Path -LiteralPath $stableHostPath -PathType Leaf)) {
    throw "Stable McpHost executable was not found: $stableHostPath"
}
Assert-McpWindowsExecutionNodeSignature `
    -Path $stableHostPath `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
if (-not [string]::IsNullOrWhiteSpace($CredentialBrokerPath)) {
    $resolvedBroker = [IO.Path]::GetFullPath($CredentialBrokerPath)
    if (-not (Test-Path -LiteralPath $resolvedBroker -PathType Leaf)) {
        throw "Configured credential broker was not found: $resolvedBroker"
    }
    Assert-McpWindowsExecutionNodeSignature `
        -Path $resolvedBroker `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$alreadyInstalled = $false
if ($existing) {
    $actions = @($existing.Actions)
    $matches = $actions.Count -eq 1 -and
        [string]$actions[0].Execute -eq $stableHostPath -and
        [string]$actions[0].Arguments -eq $argumentText -and
        [string]$actions[0].WorkingDirectory -eq $stableHostRoot -and
        [string]$existing.Principal.UserId -eq $userId -and
        [string]$existing.Principal.LogonType -in @('Interactive', 'InteractiveToken') -and
        [string]$existing.Principal.RunLevel -eq 'Limited'
    if ($matches) {
        $alreadyInstalled = $true
    }
    elseif (-not $Force) {
        throw "Scheduled Task exists with a different execution-node contract: $TaskName"
    }
    else {
        if ([string]$existing.State -eq 'Running') {
            throw "Scheduled Task is running and must be stopped before replacement: $TaskName"
        }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        $existing = $null
    }
}

if (-not $alreadyInstalled) {
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -Hidden
    $action = New-ScheduledTaskAction `
        -Execute $stableHostPath `
        -Argument $argumentText `
        -WorkingDirectory $stableHostRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    if ($DelaySeconds -gt 0) {
        $trigger.Delay = 'PT{0}S' -f $DelaySeconds
    }
    $task = New-ScheduledTask `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description 'Owns the single persistent MCP Windows execution node host for the interactive user session.'
    Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null
}

if ($Activate) {
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
}
else {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
}

[pscustomobject]@{
    status = if ($alreadyInstalled) { 'already-installed' } else { 'installed' }
    changed = -not $alreadyInstalled
    activated = [bool]$Activate
    taskName = $TaskName
    stableHostPath = $stableHostPath
} | ConvertTo-Json -Compress
