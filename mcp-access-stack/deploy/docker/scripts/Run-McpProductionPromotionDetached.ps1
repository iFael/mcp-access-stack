[CmdletBinding()]
param(
    [switch]$Execute,

    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$ExpectedReleaseId,

    [Parameter(Mandatory = $true)]
    [string]$RunDirectory,

    [ValidateRange(30, 900)]
    [int]$TimeoutSeconds = 180,

    [switch]$RequireBrowserReady,

    [ValidateRange(0, 100)]
    [int]$ExpectedPreviousBrowserRegistrySchemaVersion = 0
)

. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'ProductionLifecycle.Common.ps1')

if (-not $Execute) {
    throw 'Detached production promotion runner is intentionally gated. Re-run with -Execute.'
}

# PREFLIGHT_STEP: administrator
Assert-McpAdministrator -Operation 'Detached production promotion runner'

$root = [System.IO.Path]::GetFullPath($ProjectRoot)
$resolvedRunDirectory = [System.IO.Path]::GetFullPath($RunDirectory)
$runtimeRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'runtime\production-promotion'))
$runtimePrefix = $runtimeRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedRunDirectory.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Detached promotion run directory must be inside runtime\production-promotion.'
}

$resultPath = Join-Path $resolvedRunDirectory 'result.json'
$promotionScript = Join-Path $root 'deploy\docker\scripts\Promote-McpProduction.ps1'
$startedAt = [DateTimeOffset]::UtcNow.ToString('O')
$exitCode = 1
$errorMessage = $null
$status = 'failed'
$terminalResultPersisted = $false

New-Item -ItemType Directory -Force -Path $resolvedRunDirectory | Out-Null
Write-McpJsonFile -Path $resultPath -Value ([ordered]@{
    releaseId = $ExpectedReleaseId
    status = 'running'
    startedAt = $startedAt
})

try {
    if (-not (Test-Path -LiteralPath $promotionScript -PathType Leaf)) {
        throw "Production promotion script is missing: $promotionScript"
    }

    $arguments = @(
        '-NoLogo',
        '-NoProfile',
        '-File', $promotionScript,
        '-Execute',
        '-ExpectedReleaseId', $ExpectedReleaseId,
        '-TimeoutSeconds', [string]$TimeoutSeconds,
        '-LifecycleResultPath', $resultPath
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

    $global:LASTEXITCODE = 0
    & pwsh @arguments
    $exitCode = [int]$global:LASTEXITCODE
    if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
        $lifecycleResult = Read-McpJsonFile -Path $resultPath
        $terminalResultPersisted = Test-McpTerminalProductionLifecycleStatus -Status ([string]$lifecycleResult.status)
    }
    if ($exitCode -ne 0) {
        throw "Production promotion exited with code $exitCode."
    }

    if (-not $terminalResultPersisted) {
        throw 'Production promotion completed without persisting a terminal lifecycle result.'
    }
    $status = 'passed'
}
catch {
    $errorMessage = $_.Exception.Message
    if ($exitCode -eq 0) {
        $exitCode = 1
    }
}
finally {
    if (-not $terminalResultPersisted) {
        Write-McpJsonFile -Path $resultPath -Value ([ordered]@{
            releaseId = $ExpectedReleaseId
            status = $status
            startedAt = $startedAt
            completedAt = [DateTimeOffset]::UtcNow.ToString('O')
            exitCode = $exitCode
            error = $errorMessage
        })
    }
}

exit $exitCode
