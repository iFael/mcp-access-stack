[CmdletBinding()]
param(
    [switch]$Execute,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$ExpectedReleaseId,

    [ValidateRange(30, 900)]
    [int]$TimeoutSeconds = 300,

    [switch]$RequireBrowserReady,

    [string]$TaskName = 'MCP Access Stack Docker production promotion'
)

. (Join-Path $PSScriptRoot 'Common.ps1')
$publicDistributionCommon = Join-Path (Get-McpProjectRoot) 'deploy\windows\PublicDistribution.Common.ps1'
if ((Get-AuthenticodeSignature -LiteralPath $publicDistributionCommon).Status -ne 'Valid') {
    throw 'Public distribution trust helper is not Authenticode-signed.'
}
. $publicDistributionCommon

if (-not $Execute) {
    throw 'Production promotion request is intentionally gated. Re-run with -Execute.'
}
if (Test-McpAdministrator) {
    throw 'Use the dedicated non-elevated request surface; do not invoke it from an elevated shell.'
}

$root = Get-McpProjectRoot
$candidate = Read-McpReleasePointer -Name 'candidate' -Root $root
$eligible = Assert-McpReleasePointerEligible -Pointer $candidate -Root $root
if ([string]$eligible.releaseId -ne $ExpectedReleaseId) {
    throw "Candidate mismatch. Expected $ExpectedReleaseId, got $($eligible.releaseId)."
}
Assert-McpPublicReleaseAttestation -ReleaseRoot ([string]$eligible.path) | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    throw "Dedicated production promotion task is not installed: $TaskName"
}
if ([string]$task.State -eq 'Running') {
    throw 'A production promotion task is already running.'
}
if ([string]$task.State -eq 'Disabled') {
    throw 'Dedicated production promotion task is disabled.'
}
if ([string]$task.Principal.RunLevel -ne 'Highest') {
    throw 'Dedicated production promotion task is not configured for the required elevated run level.'
}

$expectedPwsh = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$expectedScript = [System.IO.Path]::GetFullPath(
    (Join-Path $root 'deploy\docker\scripts\Invoke-McpProductionPromotionTask.ps1')
)
$actions = @($task.Actions)
if ($actions.Count -ne 1) {
    throw 'Dedicated production promotion task must contain exactly one action.'
}
if ([System.IO.Path]::GetFullPath([string]$actions[0].Execute) -ne [System.IO.Path]::GetFullPath($expectedPwsh)) {
    throw 'Dedicated production promotion task does not use the canonical PowerShell executable.'
}
$arguments = [string]$actions[0].Arguments
if (
    $arguments -notlike '*-ExecutionPolicy AllSigned*' -or
    $arguments -notlike "*Invoke-McpProductionPromotionTask.ps1*" -or
    $arguments -notlike "*$expectedScript*"
) {
    throw 'Dedicated production promotion task action does not match the canonical promotion broker.'
}

$requestPath = Join-Path $root '.runtime-private\docker\production\promotion-request.json'
if (Test-Path -LiteralPath $requestPath) {
    throw 'A production promotion request is already pending.'
}
$requestDirectory = Split-Path -Parent $requestPath
New-Item -ItemType Directory -Force -Path $requestDirectory | Out-Null
$requestId = [guid]::NewGuid().ToString('D')
$createdAt = [DateTimeOffset]::UtcNow
$request = [ordered]@{
    schemaVersion = 2
    requestId = $requestId
    releaseId = $ExpectedReleaseId
    createdAt = $createdAt.ToString('O')
    createdAtUnixTimeMilliseconds = $createdAt.ToUnixTimeMilliseconds()
    timeoutSeconds = $TimeoutSeconds
    requireBrowserReady = [bool]$RequireBrowserReady
}
$temporaryPath = "$requestPath.$requestId.tmp"
try {
    Write-McpJsonFile -Path $temporaryPath -Value $request
    Move-Item -LiteralPath $temporaryPath -Destination $requestPath
    Start-ScheduledTask -TaskName $TaskName
}
catch {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $requestPath) {
        Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    }
    throw
}

$resultPath = Join-Path $root "runtime\production-promotion\requests\$requestId\result.json"
Write-Output ([ordered]@{
    status = 'started'
    requestId = $requestId
    releaseId = $ExpectedReleaseId
    taskName = $TaskName
    resultPath = $resultPath
} | ConvertTo-Json -Compress)
