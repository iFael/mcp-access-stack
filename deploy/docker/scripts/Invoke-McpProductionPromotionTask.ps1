[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
)

$root = [System.IO.Path]::GetFullPath($ProjectRoot)
$commonPath = Join-Path $root 'deploy\docker\scripts\Common.ps1'
$runnerPath = Join-Path $root 'deploy\docker\scripts\Run-McpProductionPromotionDetached.ps1'
if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf)) {
    throw "Promotion task Common.ps1 is missing: $commonPath"
}
. $commonPath
$publicDistributionCommon = Join-Path $root 'deploy\windows\PublicDistribution.Common.ps1'
if ((Get-AuthenticodeSignature -LiteralPath $publicDistributionCommon).Status -ne 'Valid') {
    throw 'Public distribution trust helper is not Authenticode-signed.'
}
. $publicDistributionCommon

Assert-McpAdministrator -Operation 'Dedicated production promotion task'
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "Production promotion runner is missing: $runnerPath"
}

$requestPath = Join-Path $root '.runtime-private\docker\production\promotion-request.json'
if (-not (Test-Path -LiteralPath $requestPath -PathType Leaf)) {
    throw 'No production promotion request is pending.'
}
$request = Read-McpJsonFile -Path $requestPath
if (
    [int]$request.schemaVersion -ne 2 -or
    [string]$request.releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or
    [int]$request.timeoutSeconds -lt 30 -or
    [int]$request.timeoutSeconds -gt 900
) {
    throw 'Production promotion request is malformed.'
}

$requestGuid = [guid]::Empty
if (-not [guid]::TryParse([string]$request.requestId, [ref]$requestGuid) -or $requestGuid -eq [guid]::Empty) {
    throw 'Production promotion request ID is invalid.'
}
if (-not $request.PSObject.Properties['createdAtUnixTimeMilliseconds']) {
    throw 'Production promotion request timestamp epoch is missing.'
}
try {
    $createdAt = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$request.createdAtUnixTimeMilliseconds)
}
catch {
    throw 'Production promotion request timestamp epoch is invalid.'
}
$age = [DateTimeOffset]::UtcNow - $createdAt
if ($age.TotalMinutes -lt -1 -or $age.TotalMinutes -gt 10) {
    throw 'Production promotion request is outside the allowed freshness window.'
}

$candidate = Read-McpReleasePointer -Name 'candidate' -Root $root
$eligible = Assert-McpReleasePointerEligible -Pointer $candidate -Root $root
if ([string]$eligible.releaseId -ne [string]$request.releaseId) {
    throw 'Production promotion request does not match the current eligible candidate.'
}
Assert-McpPublicReleaseAttestation -ReleaseRoot ([string]$eligible.path) | Out-Null

$requestsRoot = Join-Path $root 'runtime\production-promotion\requests'
$runDirectory = Join-Path $requestsRoot ([string]$request.requestId)
if (Test-Path -LiteralPath $runDirectory) {
    throw 'Production promotion request ID has already been consumed.'
}
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
Move-Item -LiteralPath $requestPath -Destination (Join-Path $runDirectory 'request.json')

$arguments = @(
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'AllSigned',
    '-File',
    $runnerPath,
    '-Execute',
    '-ProjectRoot',
    $root,
    '-ExpectedReleaseId',
    ([string]$request.releaseId),
    '-RunDirectory',
    $runDirectory,
    '-TimeoutSeconds',
    ([string][int]$request.timeoutSeconds)
)
if ($request.PSObject.Properties['requireBrowserReady'] -and $request.requireBrowserReady -eq $true) {
    $arguments += '-RequireBrowserReady'
}

$global:LASTEXITCODE = 0
& pwsh @arguments
$exitCode = [int]$global:LASTEXITCODE
if ($exitCode -ne 0) {
    throw "Dedicated production promotion task failed with exit code $exitCode."
}

Write-Output ([ordered]@{
    status = 'completed'
    requestId = [string]$request.requestId
    releaseId = [string]$request.releaseId
    resultPath = (Join-Path $runDirectory 'result.json')
} | ConvertTo-Json -Compress)
