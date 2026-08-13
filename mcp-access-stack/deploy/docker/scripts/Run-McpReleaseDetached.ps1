[CmdletBinding()]
param(
    [switch]$Execute,

    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$ReleaseId,
    [ValidateRange(0, 9223372036854775807)]
    [long]$GitHubCiRunId = 0
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not $Execute) {
    throw 'Detached release runner is intentionally gated. Re-run with -Execute.'
}
if ($ReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw 'ReleaseId contains unsupported characters or is too long.'
}

$root = [System.IO.Path]::GetFullPath($ProjectRoot)
$runtimeDirectory = Join-Path $root 'runtime\release-build'
$resultPath = Join-Path $runtimeDirectory "$ReleaseId.result.json"
$stdoutPath = Join-Path $runtimeDirectory "$ReleaseId.stdout.log"
$stderrPath = Join-Path $runtimeDirectory "$ReleaseId.stderr.log"
$releaseScriptPath = Join-Path $root 'deploy\docker\scripts\New-McpRelease.ps1'
$startedAt = [DateTimeOffset]::UtcNow.ToString('O')
$exitCode = $null
$succeeded = $false

New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Write-McpJsonFile -Path $resultPath -Value ([ordered]@{
    releaseId = $ReleaseId
    status = 'running'
    startedAt = $startedAt
})

function Quote-ReleaseArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

try {
    if (-not (Test-Path -LiteralPath $releaseScriptPath -PathType Leaf)) {
        throw "Release script is missing: $releaseScriptPath"
    }

    $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
    $arguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        (Quote-ReleaseArgument $releaseScriptPath),
        '-ReleaseId',
        (Quote-ReleaseArgument $ReleaseId),
        '-GitHubCiRunId',
        [string]$GitHubCiRunId
    ) -join ' '

    $process = Start-Process `
        -FilePath $pwsh `
        -ArgumentList $arguments `
        -WorkingDirectory $root `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -Wait `
        -PassThru

    $exitCode = [int]$process.ExitCode
    if ($exitCode -ne 0) {
        throw "Release script exited with code $exitCode."
    }

    $succeeded = $true
}
catch {
    $errorMessage = if ($null -ne $exitCode) {
        "Release generation failed with exit code $exitCode. Inspect the persisted stdout and stderr logs."
    }
    else {
        'Release generation failed before an exit code was available. Inspect the persisted result and logs.'
    }

    Write-McpJsonFile -Path $resultPath -Value ([ordered]@{
        releaseId = $ReleaseId
        status = 'failed'
        startedAt = $startedAt
        completedAt = [DateTimeOffset]::UtcNow.ToString('O')
        exitCode = $exitCode
        error = $errorMessage
    })
}

if ($succeeded) {
    Write-McpJsonFile -Path $resultPath -Value ([ordered]@{
        releaseId = $ReleaseId
        status = 'succeeded'
        startedAt = $startedAt
        completedAt = [DateTimeOffset]::UtcNow.ToString('O')
        exitCode = $exitCode
    })
    Write-Output "Detached release generation completed: $ReleaseId"
    exit 0
}

exit 1
