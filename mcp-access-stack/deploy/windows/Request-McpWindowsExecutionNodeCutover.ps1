[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [ValidateSet('development', 'production')]
    [string]$Environment,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Promote', 'Rollback')]
    [string]$Operation,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$ExpectedReleaseId,

    [ValidateRange(5, 300)]
    [int]$HealthTimeoutSeconds = 120,

    [string]$TaskName,
    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'Execution-node cutover request is intentionally gated. Re-run with -Execute.'
}
if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath)) {
    throw 'Execution-node cutover request must run as a script file.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath,$publicCommonPath,$executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required execution-node cutover request dependency is missing: $bootstrapPath"
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

$installationRoot = [IO.Path]::GetFullPath($InstallationRoot)
$projectRoot = [IO.Path]::GetFullPath($ProjectRoot)
if ([string]::IsNullOrWhiteSpace($TaskName)) {
    $TaskName = "MCP Access Stack $Environment cutover"
}
$statePath = Join-Path $installationRoot 'state\execution-node.json'
$requestPath = Join-Path $installationRoot 'state\cutover-request.json'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw 'Execution-node state is missing.'
}
if (Test-Path -LiteralPath $requestPath) {
    throw 'An execution-node cutover request is already pending.'
}
$state = Read-McpWindowsExecutionNodeState -Path $statePath
$target = if ($Operation -eq 'Promote') { $state.candidate } else { $state.previous }
if ($null -eq $target) {
    throw "Execution-node $($Operation.ToLowerInvariant()) target pointer is empty."
}
Assert-McpWindowsExecutionNodePointer -Pointer $target -Name ($Operation.ToLowerInvariant() + '-target')
if ([string]$target.releaseId -ne $ExpectedReleaseId) {
    throw "Execution-node cutover target mismatch. Expected $ExpectedReleaseId, got $($target.releaseId)."
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    throw "Dedicated execution-node cutover Task is not installed: $TaskName"
}
if ([string]$task.State -eq 'Running') {
    throw 'An execution-node cutover Task is already running.'
}
if ([string]$task.State -eq 'Disabled') {
    throw 'Dedicated execution-node cutover Task is disabled.'
}
if ([string]$task.Principal.RunLevel -ne 'Limited' -or
    [string]$task.Principal.LogonType -notin @('Interactive','InteractiveToken')) {
    throw 'Dedicated execution-node cutover Task has an unexpected principal contract.'
}
$actions = @($task.Actions)
if ($actions.Count -ne 1) {
    throw 'Dedicated execution-node cutover Task must contain exactly one action.'
}
$expectedPwsh = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if ([IO.Path]::GetFullPath([string]$actions[0].Execute) -ne [IO.Path]::GetFullPath($expectedPwsh)) {
    throw 'Dedicated execution-node cutover Task does not use canonical PowerShell.'
}
$taskArguments = [string]$actions[0].Arguments
$expectedExecutionPolicy = if ($AllowUnsignedDevelopment) { 'Bypass' } else { 'AllSigned' }
if ($taskArguments -notlike "*-ExecutionPolicy $expectedExecutionPolicy*" -or
    $taskArguments -notlike '*Invoke-McpWindowsExecutionNodeCutoverTask.ps1*' -or
    $taskArguments -notlike "*$installationRoot*" -or
    $taskArguments -notlike "*$projectRoot*" -or
    $taskArguments -notlike "*-Environment $Environment*") {
    throw 'Dedicated execution-node cutover Task action does not match the expected broker contract.'
}
$brokerScript = [string]$actions[0].WorkingDirectory | ForEach-Object { Join-Path $_ 'Invoke-McpWindowsExecutionNodeCutoverTask.ps1' }
if (-not (Test-Path -LiteralPath $brokerScript -PathType Leaf)) {
    throw 'Dedicated execution-node cutover broker script is missing.'
}
Assert-McpPublicSignature -Path $brokerScript -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

$requestId = [guid]::NewGuid().ToString('D')
$createdAt = [DateTimeOffset]::UtcNow
$request = [ordered]@{
    schemaVersion = 1
    requestId = $requestId
    operation = $Operation
    expectedReleaseId = [string]$target.releaseId
    expectedManifestSha256 = [string]$target.manifestSha256
    createdAt = $createdAt.ToString('O')
    createdAtUnixTimeMilliseconds = $createdAt.ToUnixTimeMilliseconds()
    healthTimeoutSeconds = $HealthTimeoutSeconds
}
$temporary = $requestPath + '.' + $requestId + '.tmp'
try {
    [IO.File]::WriteAllText(
        $temporary,
        (($request | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporary -Destination $requestPath
    Start-ScheduledTask -TaskName $TaskName
}
catch {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $requestPath) {
        Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    }
    throw
}

$resultPath = Join-Path $installationRoot ("state\cutover-runs\$requestId\result.json")
[pscustomobject]@{
    status = 'started'
    requestId = $requestId
    releaseId = [string]$target.releaseId
    operation = $Operation.ToLowerInvariant()
    taskName = $TaskName
    resultPath = $resultPath
    detached = $true
} | ConvertTo-Json -Compress
