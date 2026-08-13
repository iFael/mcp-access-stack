[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Get-McpProjectRoot
$starterPath = Join-Path $PSScriptRoot 'Start-McpRelease.ps1'
$runnerPath = Join-Path $PSScriptRoot 'Run-McpReleaseDetached.ps1'
$starter = Get-Content -Raw -LiteralPath $starterPath
$runner = Get-Content -Raw -LiteralPath $runnerPath

foreach ($requirement in @(
    'Get-Command pwsh',
    'Run-McpReleaseDetached\.ps1',
    'Start-Process',
    "status = 'starting'",
    'GitHubCiRunId'
)) {
    if ($starter -notmatch $requirement) {
        throw "Detached release starter requirement is missing: $requirement"
    }
}
if ($starter -match "Start-Process[\s\S]*-FilePath 'powershell\.exe'") {
    throw 'Detached release starter must never launch Windows PowerShell.'
}

foreach ($requirement in @(
    'Get-Command pwsh',
    'Start-Process',
    'RedirectStandardOutput',
    'RedirectStandardError',
    '-Wait',
    '\$process\.ExitCode',
    "status = 'succeeded'",
    "status = 'failed'",
    'GitHubCiRunId'
)) {
    if ($runner -notmatch $requirement) {
        throw "Detached release runner requirement is missing: $requirement"
    }
}
if ($runner -match '[12]\s*>>') {
    throw 'Detached release runner must not use PowerShell stream redirection for the child process.'
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('mcp-release-launcher-test-' + [guid]::NewGuid().ToString('N'))
$fakeScriptDirectory = Join-Path $tempRoot 'deploy\docker\scripts'
$fakeReleaseScript = Join-Path $fakeScriptDirectory 'New-McpRelease.ps1'
$testHostStdout = Join-Path $tempRoot 'host.stdout.log'
$testHostStderr = Join-Path $tempRoot 'host.stderr.log'

function Quote-TestArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Invoke-RunnerFixture {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [Parameter(Mandatory = $true)][int]$ExpectedHostExitCode,
        [long]$GitHubCiRunId = 0
    )

    $windowsPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $arguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        (Quote-TestArgument $runnerPath),
        '-Execute',
        '-ProjectRoot',
        (Quote-TestArgument $tempRoot),
        '-ReleaseId',
        (Quote-TestArgument $ReleaseId),
        '-GitHubCiRunId',
        [string]$GitHubCiRunId
    ) -join ' '

    $process = Start-Process `
        -FilePath $windowsPowerShell `
        -ArgumentList $arguments `
        -WorkingDirectory $root `
        -RedirectStandardOutput $testHostStdout `
        -RedirectStandardError $testHostStderr `
        -WindowStyle Hidden `
        -Wait `
        -PassThru

    if ([int]$process.ExitCode -ne $ExpectedHostExitCode) {
        throw "Fixture runner returned exit code $($process.ExitCode), expected $ExpectedHostExitCode."
    }

    return Read-McpJsonFile -Path (Join-Path $tempRoot "runtime\release-build\$ReleaseId.result.json")
}

try {
    New-Item -ItemType Directory -Force -Path $fakeScriptDirectory | Out-Null

    Write-McpUtf8NoBom -Path $fakeReleaseScript -Content @'
param([string]$ReleaseId, [long]$GitHubCiRunId = 0)
Write-Output "synthetic release succeeded: $ReleaseId ci=$GitHubCiRunId"
[Console]::Error.WriteLine('npm warn deprecated synthetic-warning')
exit 0
'@

    $successReleaseId = 'test-success'
    $successResult = Invoke-RunnerFixture -ReleaseId $successReleaseId -ExpectedHostExitCode 0 -GitHubCiRunId 987654321
    $successStdoutPath = Join-Path $tempRoot "runtime\release-build\$successReleaseId.stdout.log"
    $successStderrPath = Join-Path $tempRoot "runtime\release-build\$successReleaseId.stderr.log"

    if ([string]$successResult.status -ne 'succeeded' -or [int]$successResult.exitCode -ne 0) {
        throw 'A warning on stderr was incorrectly classified as a failed release.'
    }
    if ((Get-Content -Raw -LiteralPath $successStdoutPath) -notmatch 'synthetic release succeeded: test-success ci=987654321') {
        throw 'Detached release stdout was not persisted.'
    }
    if ((Get-Content -Raw -LiteralPath $successStderrPath) -notmatch 'npm warn deprecated synthetic-warning') {
        throw 'Detached release stderr warning was not persisted.'
    }

    Write-McpUtf8NoBom -Path $fakeReleaseScript -Content @'
param([string]$ReleaseId, [long]$GitHubCiRunId = 0)
[Console]::Error.WriteLine('synthetic release failure')
exit 7
'@

    $failureReleaseId = 'test-failure'
    $failureResult = Invoke-RunnerFixture -ReleaseId $failureReleaseId -ExpectedHostExitCode 1
    $failureStderrPath = Join-Path $tempRoot "runtime\release-build\$failureReleaseId.stderr.log"

    if ([string]$failureResult.status -ne 'failed' -or [int]$failureResult.exitCode -ne 7) {
        throw 'A non-zero release exit code was not persisted as a failure.'
    }
    if ((Get-Content -Raw -LiteralPath $failureStderrPath) -notmatch 'synthetic release failure') {
        throw 'Failed release stderr was not persisted.'
    }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output 'Detached release launcher test passed under Windows PowerShell with stdout, stderr and exit-code semantics preserved.'
