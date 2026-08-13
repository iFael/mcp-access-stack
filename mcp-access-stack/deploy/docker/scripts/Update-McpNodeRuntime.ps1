[CmdletBinding()]
param(
    [string]$ReleaseRoot,
    [string]$ProjectRoot,
    [ValidateSet('Current', 'Lts')]
    [string]$Channel = 'Current',
    [string]$TargetVersion,
    [switch]$CheckOnly,
    [switch]$Rollback
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')

if ($CheckOnly -and $Rollback) {
    throw '-CheckOnly and -Rollback cannot be used together.'
}
if ($Rollback -and -not [string]::IsNullOrWhiteSpace($TargetVersion)) {
    throw '-Rollback cannot be combined with -TargetVersion.'
}

$root = if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    Get-McpProjectRoot
}
else {
    [System.IO.Path]::GetFullPath($ProjectRoot)
}
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $active = Read-McpReleasePointer -Name 'active' -Root $root
    $eligible = Assert-McpReleasePointerEligible -Pointer $active -Root $root
    $ReleaseRoot = [string]$eligible.path
}
$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
$manifest = Read-McpJsonFile -Path (Join-Path $ReleaseRoot 'manifest.json')
$releaseId = [string]$manifest.releaseId
$state = Initialize-McpReleaseNodeRuntimeState -ReleaseRoot $ReleaseRoot -ProjectRoot $root -InstallMissing
$currentVersion = ConvertTo-McpNodeVersion -Version ([string]$state.knownGood.version)


$target = if ([string]::IsNullOrWhiteSpace($TargetVersion)) {
    [string](Get-McpLatestNodeReleaseMetadata -Channel $Channel).version
}
else {
    ConvertTo-McpNodeVersion -Version $TargetVersion
}

if ($CheckOnly) {
    [pscustomobject]@{
        releaseId = $releaseId
        channel = $Channel
        knownGood = $currentVersion
        latest = $target
        updateAvailable = ((Compare-McpNodeVersion -Left $target -Right $currentVersion) -gt 0)
    } | ConvertTo-Json -Compress
    exit 0
}

if ($Rollback) {
    $rollbackLockDirectory = Join-Path (Get-McpManagedNodeRuntimeRoot -ProjectRoot $root) 'locks'
    New-Item -ItemType Directory -Force -Path $rollbackLockDirectory | Out-Null
    $rollbackLockPath = Join-Path $rollbackLockDirectory ("$releaseId.update.lock")
    $rollbackLockStream = $null
    try {
        try {
            $rollbackLockStream = [System.IO.File]::Open(
                $rollbackLockPath,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
        }
        catch [System.IO.IOException] {
            throw "A Node runtime update is already running for release $releaseId."
        }
        $result = Rollback-McpReleaseManagedNodeRuntime -ReleaseRoot $ReleaseRoot -ProjectRoot $root
        [pscustomobject]@{
            releaseId = $releaseId
            channel = [string]$state.channel
            status = [string]$result.status
            knownGood = [string]$result.knownGood
            rollback = [string]$result.rollback
            restarted = $false
            note = 'The qualified runtime pointer was rolled back. Live Agent and Browser Worker processes were not restarted.'
        } | ConvertTo-Json -Compress
    }
    finally {
        if ($rollbackLockStream) { $rollbackLockStream.Dispose() }
    }
    exit 0
}
$lockDirectory = Join-Path (Get-McpManagedNodeRuntimeRoot -ProjectRoot $root) 'locks'
New-Item -ItemType Directory -Force -Path $lockDirectory | Out-Null
$lockPath = Join-Path $lockDirectory ("$releaseId.update.lock")
$lockStream = $null
try {
    try {
        $lockStream = [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    }
    catch [System.IO.IOException] {
        throw "A Node runtime update is already running for release $releaseId."
    }

    $result = Update-McpReleaseManagedNodeRuntime `
        -ReleaseRoot $ReleaseRoot `
        -ProjectRoot $root `
        -Channel $Channel `
        -TargetVersion $target

    [pscustomobject]@{
        releaseId = $releaseId
        channel = $Channel
        status = [string]$result.status
        knownGood = [string]$result.knownGood
        rollback = if ($result.PSObject.Properties['rollback']) { [string]$result.rollback } else { $null }
        restarted = $false
        note = 'Live Agent and Browser Worker processes are never force-restarted by the Node runtime updater.'
    } | ConvertTo-Json -Compress
}
finally {
    if ($lockStream) { $lockStream.Dispose() }
}
