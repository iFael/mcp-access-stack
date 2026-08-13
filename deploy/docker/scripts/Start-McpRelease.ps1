[CmdletBinding()]
param(
    [switch]$Execute,
    [string]$ReleaseId = ([DateTimeOffset]::UtcNow.ToString('yyyy-MM-dd.HHmmss')),
    [ValidateRange(0, 9223372036854775807)]
    [long]$GitHubCiRunId = 0
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not $Execute) {
    throw 'Detached release generation is intentionally gated. Re-run with -Execute.'
}
if ($ReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw 'ReleaseId contains unsupported characters or is too long.'
}

$root = Get-McpProjectRoot
$runtimeDirectory = Join-Path $root 'runtime\release-build'
$resultPath = Join-Path $runtimeDirectory "$ReleaseId.result.json"
$releaseDirectory = Join-Path $root "releases\$ReleaseId"
$runnerPath = Join-Path $PSScriptRoot 'Run-McpReleaseDetached.ps1'

if (Test-Path -LiteralPath $releaseDirectory) {
    throw "Release already exists: $ReleaseId"
}
if (Test-Path -LiteralPath $resultPath) {
    throw "Release build result already exists: $resultPath"
}
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "Detached release runner is missing: $runnerPath"
}

New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$startedAt = [DateTimeOffset]::UtcNow.ToString('O')
Write-McpJsonFile -Path $resultPath -Value ([ordered]@{
    releaseId = $ReleaseId
    status = 'starting'
    startedAt = $startedAt
})

function Quote-ReleaseArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

try {
    $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
    $arguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        (Quote-ReleaseArgument $runnerPath),
        '-Execute',
        '-ProjectRoot',
        (Quote-ReleaseArgument $root),
        '-ReleaseId',
        (Quote-ReleaseArgument $ReleaseId),
        '-GitHubCiRunId',
        [string]$GitHubCiRunId
    ) -join ' '

    $process = Start-Process `
        -FilePath $pwsh `
        -ArgumentList $arguments `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -PassThru
}
catch {
    Write-McpJsonFile -Path $resultPath -Value ([ordered]@{
        releaseId = $ReleaseId
        status = 'failed'
        startedAt = $startedAt
        completedAt = [DateTimeOffset]::UtcNow.ToString('O')
        error = 'Unable to start detached release generation.'
    })
    throw
}

[pscustomobject]@{
    releaseId = $ReleaseId
    status = 'started'
    pid = $process.Id
    resultPath = "runtime/release-build/$ReleaseId.result.json"
} | ConvertTo-Json
