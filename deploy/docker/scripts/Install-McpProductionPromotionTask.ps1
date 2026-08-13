[CmdletBinding()]
param(
    [switch]$Execute,
    [switch]$Force,
    [string]$TaskName = 'MCP Access Stack Docker production promotion'
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not $Execute) {
    throw 'Production promotion task installation is intentionally gated. Re-run with -Execute.'
}
Assert-McpAdministrator -Operation 'Production promotion task installation'

$root = Get-McpProjectRoot
$pwsh = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$brokerScript = Join-Path $root 'deploy\docker\scripts\Invoke-McpProductionPromotionTask.ps1'
if (-not (Test-Path -LiteralPath $brokerScript -PathType Leaf)) {
    throw "Production promotion broker is missing: $brokerScript"
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not $Force) {
    throw "Scheduled task already exists: $TaskName. Use -Force to replace it."
}
if ($existing -and [string]$existing.State -eq 'Running') {
    throw "Scheduled task is running and cannot be replaced: $TaskName"
}
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

function Quote-TaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) {
        throw 'Scheduled task arguments cannot contain quotes.'
    }
    return '"' + $Value + '"'
}

$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal `
    -UserId $userId `
    -LogonType Interactive `
    -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -Hidden
$arguments = @(
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'AllSigned',
    '-File',
    (Quote-TaskArgument $brokerScript),
    '-ProjectRoot',
    (Quote-TaskArgument $root)
) -join ' '
$action = New-ScheduledTaskAction `
    -Execute $pwsh `
    -Argument $arguments `
    -WorkingDirectory $root
$task = New-ScheduledTask `
    -Action $action `
    -Principal $principal `
    -Settings $settings `
    -Description 'Runs only release-ID based MCP production promotion requests through the canonical fail-closed promotion lifecycle.'
Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null

$installed = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
if ([string]$installed.Principal.RunLevel -ne 'Highest') {
    throw 'Installed production promotion task does not have the required elevated run level.'
}
if (@($installed.Actions).Count -ne 1) {
    throw 'Installed production promotion task has an unexpected action count.'
}
if ([System.IO.Path]::GetFullPath([string]$installed.Actions[0].Execute) -ne [System.IO.Path]::GetFullPath($pwsh)) {
    throw 'Installed production promotion task does not use the canonical PowerShell executable.'
}

Write-Output ([ordered]@{
    status = 'installed'
    taskName = $TaskName
    runLevel = [string]$installed.Principal.RunLevel
    manualOnly = $true
    broker = $brokerScript
    powershell = $pwsh
} | ConvertTo-Json -Compress)
