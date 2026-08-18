[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [ValidateSet('development', 'production')]
    [string]$Environment,

    [string]$PersistentTaskName,
    [string]$LegacyAgentTaskName,
    [string]$LegacyBrowserTaskName,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath)) {
    throw 'Execution-node cutover broker must run as a script file.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
$cutoverPath = Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeCutover.ps1'
$transitionPath = Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeTransition.ps1'
$hostTaskPath = Join-Path $PSScriptRoot 'Install-McpWindowsExecutionNodeHostTask.ps1'
foreach ($bootstrapPath in @($PSCommandPath,$publicCommonPath,$executionCommonPath,$cutoverPath,$transitionPath,$hostTaskPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required execution-node cutover broker dependency is missing: $bootstrapPath"
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
Assert-McpPublicSignature -Path $cutoverPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature -Path $transitionPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature -Path $hostTaskPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
. $executionCommonPath
Assert-McpPublicWindowsX64

$installationRoot = [IO.Path]::GetFullPath($InstallationRoot)
$projectRoot = [IO.Path]::GetFullPath($ProjectRoot)
if ([string]::IsNullOrWhiteSpace($PersistentTaskName)) { $PersistentTaskName = "MCP Access Stack $Environment host" }
if ([string]::IsNullOrWhiteSpace($LegacyAgentTaskName)) { $LegacyAgentTaskName = "MCP Access Stack Docker $Environment agent" }
if ([string]::IsNullOrWhiteSpace($LegacyBrowserTaskName)) { $LegacyBrowserTaskName = "MCP Access Stack Docker $Environment browser-worker" }
$stateRoot = Join-Path $installationRoot 'state'
$statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $installationRoot
$requestPath = Join-Path $stateRoot 'cutover-request.json'
$runsRoot = Join-Path $stateRoot 'cutover-runs'
$brokerPath = Join-Path $installationRoot 'host\McpCredentialBroker.exe'
if (-not (Test-Path -LiteralPath $requestPath -PathType Leaf)) {
    throw 'No execution-node cutover request is pending.'
}
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw 'Execution-node state is missing.'
}
if (-not (Test-Path -LiteralPath $brokerPath -PathType Leaf)) {
    throw 'Stable execution-node credential broker is missing.'
}
Assert-McpWindowsExecutionNodeSignature -Path $brokerPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

$request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
if ([int]$request.schemaVersion -ne 1 -or
    [string]$request.operation -notin @('Promote','Rollback') -or
    [string]$request.expectedReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or
    [string]$request.expectedManifestSha256 -notmatch '^[a-f0-9]{64}$' -or
    [int]$request.healthTimeoutSeconds -lt 5 -or
    [int]$request.healthTimeoutSeconds -gt 300) {
    throw 'Execution-node cutover request is malformed.'
}
$requestGuid = [guid]::Empty
if (-not [guid]::TryParse([string]$request.requestId,[ref]$requestGuid) -or $requestGuid -eq [guid]::Empty) {
    throw 'Execution-node cutover request ID is invalid.'
}
try {
    $createdAt = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$request.createdAtUnixTimeMilliseconds)
}
catch {
    throw 'Execution-node cutover request timestamp is invalid.'
}
$age = [DateTimeOffset]::UtcNow - $createdAt
if ($age.TotalMinutes -lt -1 -or $age.TotalMinutes -gt 10) {
    throw 'Execution-node cutover request is outside the allowed freshness window.'
}

$state = Read-McpWindowsExecutionNodeState -Path $statePath
if ($null -eq $state) { throw 'Execution-node state is empty.' }
$target = if ([string]$request.operation -eq 'Promote') { $state.candidate } else { $state.previous }
if ($null -eq $target -or
    [string]$target.releaseId -ne [string]$request.expectedReleaseId -or
    [string]$target.manifestSha256 -ne [string]$request.expectedManifestSha256) {
    throw 'Execution-node cutover request no longer matches the current target pointer.'
}

New-Item -ItemType Directory -Force -Path $runsRoot | Out-Null
$runDirectory = Join-Path $runsRoot ([string]$request.requestId)
if (Test-Path -LiteralPath $runDirectory) {
    throw 'Execution-node cutover request ID has already been consumed.'
}
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
Move-Item -LiteralPath $requestPath -Destination (Join-Path $runDirectory 'request.json')
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
        Move-Item -LiteralPath $temporary -Destination $resultPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

$startedAt = [DateTimeOffset]::UtcNow.ToString('O')
Write-McpCutoverBrokerResult -Value ([ordered]@{
    schemaVersion = 1
    requestId = [string]$request.requestId
    releaseId = [string]$request.expectedReleaseId
    operation = ([string]$request.operation).ToLowerInvariant()
    status = 'running'
    startedAt = $startedAt
})

$exitCode = 1
try {

    $parameters = @{
        InstallationRoot = $installationRoot
        ProjectRoot = $projectRoot
        Environment = $Environment
        Operation = [string]$request.operation
        PersistentTaskName = $persistentTaskName
        LegacyAgentTaskName = $legacyAgentTaskName
        LegacyBrowserTaskName = $legacyBrowserTaskName
        CredentialBrokerPath = $brokerPath
        HealthTimeoutSeconds = [int]$request.healthTimeoutSeconds
        Execute = $true
        AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
    }
    $cutoverOutput = & $cutoverPath @parameters
    $cutover = $cutoverOutput | ConvertFrom-Json
    if ([string]$cutover.status -ne 'cutover-ready' -or
        [string]$cutover.activeReleaseId -ne [string]$request.expectedReleaseId) {
        throw 'Execution-node cutover completed without the expected READY evidence.'
    }
    Write-McpCutoverBrokerResult -Value ([ordered]@{
        schemaVersion = 1
        requestId = [string]$request.requestId
        releaseId = [string]$request.expectedReleaseId
        operation = ([string]$request.operation).ToLowerInvariant()
        status = 'passed'
        startedAt = $startedAt
        completedAt = [DateTimeOffset]::UtcNow.ToString('O')
        cutover = $cutover
    })
    $exitCode = 0
}
catch {
    Write-McpCutoverBrokerResult -Value ([ordered]@{
        schemaVersion = 1
        requestId = [string]$request.requestId
        releaseId = [string]$request.expectedReleaseId
        operation = ([string]$request.operation).ToLowerInvariant()
        status = 'failed'
        startedAt = $startedAt
        completedAt = [DateTimeOffset]::UtcNow.ToString('O')
        error = $_.Exception.Message
    })
    $exitCode = 1
}

exit $exitCode
