[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [string]$StateRoot,

    [string]$Repository = 'iFael/mcp-access-stack',
    [string]$CompanionTaskName = 'MCP V3 local companion',
    [string]$TaskName = 'MCP V3 local updater',

    [ValidateRange(0, 23)]
    [int]$Hour = 3,

    [switch]$Execute,
    [switch]$Force,
    [switch]$Activate,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'MCP V3 local auto-update task installation is intentionally gated. Re-run with -Execute.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required MCP V3 updater task dependency is missing: $bootstrapPath"
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
$state = [IO.Path]::GetFullPath($StateRoot)
$statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $installation
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw "MCP V3 execution state was not found: $statePath"
}

function ConvertTo-McpSingleQuotedLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

$script = @(
    '$ErrorActionPreference=''Stop''',
    ('$state=Get-Content -LiteralPath {0} -Raw | ConvertFrom-Json' -f (ConvertTo-McpSingleQuotedLiteral $statePath)),
    'if($null -eq $state.active){throw ''MCP V3 active release is unavailable.''}',
    ('$releaseRoot=Join-Path {0} ([string]$state.active.releaseId)' -f (ConvertTo-McpSingleQuotedLiteral (Join-Path $installation 'releases'))),
    '$updater=Join-Path $releaseRoot ''deploy\windows\Update-McpV3Local.ps1''',
    'if(-not (Test-Path -LiteralPath $updater -PathType Leaf)){throw ''MCP V3 local updater is missing from the active release.''}',
    ('& $updater -Repository {0} -InstallationRoot {1} -StateRoot {2} -TaskName {3} -Execute' -f
        (ConvertTo-McpSingleQuotedLiteral $Repository),
        (ConvertTo-McpSingleQuotedLiteral $installation),
        (ConvertTo-McpSingleQuotedLiteral $state),
        (ConvertTo-McpSingleQuotedLiteral $CompanionTaskName)),
    'if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}'
) -join '; '
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy AllSigned -EncodedCommand $encoded"
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powershell -PathType Leaf)) {
    throw "Windows PowerShell was not found: $powershell"
}

$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$alreadyInstalled = $false
if ($existing) {
    $actions = @($existing.Actions)
    $matches = $actions.Count -eq 1 -and
        [IO.Path]::GetFullPath([string]$actions[0].Execute) -eq [IO.Path]::GetFullPath($powershell) -and
        [string]$actions[0].Arguments -eq $arguments -and
        (Test-McpWindowsAccountIdentityEquivalent -Left ([string]$existing.Principal.UserId) -Right $userId) -and
        [string]$existing.Principal.LogonType -in @('Interactive', 'InteractiveToken') -and
        [string]$existing.Principal.RunLevel -eq 'Limited'
    if ($matches) {
        $alreadyInstalled = $true
    }
    elseif (-not $Force) {
        throw "Scheduled Task exists with a different MCP V3 updater contract: $TaskName"
    }
    elseif ([string]$existing.State -eq 'Running') {
        throw "Scheduled Task is running and must be stopped before replacement: $TaskName"
    }
}

if (-not $alreadyInstalled) {
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -Hidden
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $state
    $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours($Hour))
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Checks for and atomically activates signed MCP V3 local releases.'
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
}

$null = Set-McpWindowsScheduledTaskOwnerAccess -TaskName $TaskName -UserId $userId
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
    companionTaskName = $CompanionTaskName
    repository = $Repository
    hour = $Hour
} | ConvertTo-Json -Compress
