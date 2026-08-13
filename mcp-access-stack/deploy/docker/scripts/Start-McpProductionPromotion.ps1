[CmdletBinding()]
param(
    [switch]$Execute,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$ExpectedReleaseId,

    [ValidateRange(30, 900)]
    [int]$TimeoutSeconds = 180,

    [switch]$RequireBrowserReady,

    [ValidateRange(0, 100)]
    [int]$ExpectedPreviousBrowserRegistrySchemaVersion = 0
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not $Execute) {
    throw 'Detached production promotion is intentionally gated. Re-run with -Execute.'
}

# PREFLIGHT_STEP: administrator
Assert-McpAdministrator -Operation 'Detached production promotion launcher'

$root = Get-McpProjectRoot
$runnerPath = Join-Path $PSScriptRoot 'Run-McpProductionPromotionDetached.ps1'
$timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
$runDirectory = Join-Path $root "runtime\production-promotion\detached-$timestamp"
$stdoutPath = Join-Path $runDirectory 'stdout.log'
$stderrPath = Join-Path $runDirectory 'stderr.log'
$resultPath = Join-Path $runDirectory 'result.json'

if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "Detached production promotion runner is missing: $runnerPath"
}
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null

function Quote-ProcessArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"')) {
        throw 'Detached promotion arguments cannot contain quotes.'
    }
    return '"' + $Value + '"'
}

$arguments = @(
    '-NoLogo',
    '-NoProfile',
    '-File',
    (Quote-ProcessArgument $runnerPath),
    '-Execute',
    '-ProjectRoot',
    (Quote-ProcessArgument $root),
    '-ExpectedReleaseId',
    (Quote-ProcessArgument $ExpectedReleaseId),
    '-RunDirectory',
    (Quote-ProcessArgument $runDirectory),
    '-TimeoutSeconds',
    [string]$TimeoutSeconds
)
if ($RequireBrowserReady) {
    $arguments += '-RequireBrowserReady'
}
if ($ExpectedPreviousBrowserRegistrySchemaVersion -gt 0) {
    $arguments += @(
        '-ExpectedPreviousBrowserRegistrySchemaVersion',
        [string]$ExpectedPreviousBrowserRegistrySchemaVersion
    )
}

$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$process = Start-Process `
    -FilePath $pwsh `
    -ArgumentList ($arguments -join ' ') `
    -WorkingDirectory $root `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru

[pscustomobject]@{
    status = 'started'
    releaseId = $ExpectedReleaseId
    processId = [int]$process.Id
    runDirectory = $runDirectory
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    resultPath = $resultPath
    expectedPreviousBrowserRegistrySchemaVersion = $ExpectedPreviousBrowserRegistrySchemaVersion
} | ConvertTo-Json -Depth 4
