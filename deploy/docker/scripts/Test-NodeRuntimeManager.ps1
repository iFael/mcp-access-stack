[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'Managed Node runtime test is supported only on Windows.'
}

function New-FakeNodeExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Version
    )

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText(
        $Path,
        'managed-node-runtime-fixture' + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
        ($Path + '.fixture-version'),
        $Version + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )
}

function New-FixtureRelease {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [Parameter(Mandatory = $true)][string]$NodeVersion
    )

    $releaseRoot = Join-Path $Root "releases\$ReleaseId"
    New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
    Write-McpJsonFile -Path (Join-Path $releaseRoot 'manifest.json') -Value ([ordered]@{
        releaseId = $ReleaseId
        version = 'test'
        commit = ('commit-' + $ReleaseId)
        nodeVersion = $NodeVersion
        testsPassed = $true
        dirty = $false
        source = 'clean-git-snapshot'
    })
    return $releaseRoot
}

function Quote-TestArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) { throw 'Fixture argument contains a quote.' }
    return '"' + $Value + '"'
}

$projectRoot = Get-McpProjectRoot
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('mcp-node-runtime-manager-' + [guid]::NewGuid().ToString('N'))
$script:OriginalTestMcpNodeExecutableVersion = ${function:Test-McpNodeExecutableVersion}
$script:FixtureNodeRuntimeRoot = [IO.Path]::GetFullPath((Get-McpManagedNodeRuntimeRoot -ProjectRoot $tempRoot))
function Test-McpNodeExecutableVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion
    )

    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $fixturePrefix = $script:FixtureNodeRuntimeRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if ($resolvedPath.StartsWith($fixturePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $fixtureVersionPath = $resolvedPath + '.fixture-version'
        if (Test-Path -LiteralPath $fixtureVersionPath -PathType Leaf) {
            $fixtureVersion = (Get-Content -Raw -LiteralPath $fixtureVersionPath).Trim()
            return $fixtureVersion -eq (ConvertTo-McpNodeVersion -Version $ExpectedVersion)
        }
    }

    return & $script:OriginalTestMcpNodeExecutableVersion -Path $Path -ExpectedVersion $ExpectedVersion
}
try {
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

    if ((ConvertTo-McpNodeVersion -Version 'v24.10.0') -ne 'v24.10.0') {
        throw 'Stable Node version normalization changed a valid version.'
    }
    if ((Compare-McpNodeVersion -Left 'v26.0.0' -Right 'v24.99.99') -le 0) {
        throw 'Node semantic version ordering is invalid.'
    }
    $invalidVersionRejected = $false
    try { [void](ConvertTo-McpNodeVersion -Version 'latest') } catch { $invalidVersionRejected = $true }
    if (-not $invalidVersionRejected) {
        throw 'Non-semver Node version was accepted.'
    }

    $runtimeRoot = Get-McpManagedNodeRuntimeRoot -ProjectRoot $tempRoot
    New-FakeNodeExecutable `
        -Path (Get-McpManagedNodeExecutablePath -Version 'v1.0.0' -ProjectRoot $tempRoot) `
        -Version 'v1.0.0'
    New-FakeNodeExecutable `
        -Path (Get-McpManagedNodeExecutablePath -Version 'v2.0.0' -ProjectRoot $tempRoot) `
        -Version 'v2.0.0'

    $passRelease = New-FixtureRelease -Root $tempRoot -ReleaseId 'runtime-pass' -NodeVersion 'v1.0.0'
    $initial = Initialize-McpReleaseNodeRuntimeState -ReleaseRoot $passRelease -ProjectRoot $tempRoot
    if ([string]$initial.knownGood.version -ne 'v1.0.0') {
        throw 'Initial release Node runtime state did not pin the build version.'
    }
    $promoted = Update-McpReleaseManagedNodeRuntime `
        -ReleaseRoot $passRelease `
        -ProjectRoot $tempRoot `
        -TargetVersion 'v2.0.0' `
        -QualificationScriptBlock { param($nodePath, $version); if ($version -ne 'v2.0.0') { throw 'unexpected candidate' } }
    if ([string]$promoted.status -ne 'promoted' -or [string]$promoted.rollback -ne 'v1.0.0') {
        throw 'Passing Node candidate was not promoted with rollback preserved.'
    }
    $passState = Read-McpNodeReleaseState -ReleaseId 'runtime-pass' -ProjectRoot $tempRoot
    if (
        [string]$passState.knownGood.version -ne 'v2.0.0' -or
        [string]$passState.rollback.version -ne 'v1.0.0'
    ) {
        throw 'Promoted Node runtime state is inconsistent.'
    }
    $passPointer = (Get-Content -Raw -LiteralPath (Get-McpNodeReleaseKnownGoodPointerPath -ReleaseId 'runtime-pass' -ProjectRoot $tempRoot)).Trim()
    if ($passPointer -ne 'v2.0.0') {
        throw 'Launcher known-good pointer did not follow the promoted runtime.'
    }
    if ([string]$passState.knownGood.sha256 -notmatch '^[a-f0-9]{64}$') {
        throw 'Promoted runtime state did not preserve the Node executable SHA-256.'
    }
    $rolledBack = Rollback-McpReleaseManagedNodeRuntime -ReleaseRoot $passRelease -ProjectRoot $tempRoot
    if (
        [string]$rolledBack.status -ne 'rolled-back' -or
        [string]$rolledBack.knownGood -ne 'v1.0.0' -or
        [string]$rolledBack.rollback -ne 'v2.0.0'
    ) {
        throw 'Qualified Node runtime rollback did not swap known-good and rollback versions.'
    }
    $rolledBackState = Read-McpNodeReleaseState -ReleaseId 'runtime-pass' -ProjectRoot $tempRoot
    if ([string]$rolledBackState.knownGood.version -ne 'v1.0.0') {
        throw 'Qualified Node runtime rollback did not persist the previous runtime.'
    }

    $failRelease = New-FixtureRelease -Root $tempRoot -ReleaseId 'runtime-fail' -NodeVersion 'v1.0.0'
    [void](Initialize-McpReleaseNodeRuntimeState -ReleaseRoot $failRelease -ProjectRoot $tempRoot)
    $qualificationRejected = $false
    try {
        Update-McpReleaseManagedNodeRuntime `
            -ReleaseRoot $failRelease `
            -ProjectRoot $tempRoot `
            -TargetVersion 'v2.0.0' `
            -QualificationScriptBlock { throw 'synthetic compatibility failure' } | Out-Null
    }
    catch {
        $qualificationRejected = $_.Exception.Message -match 'synthetic compatibility failure'
    }
    if (-not $qualificationRejected) {
        throw 'Failing Node candidate was not rejected.'
    }
    $failState = Read-McpNodeReleaseState -ReleaseId 'runtime-fail' -ProjectRoot $tempRoot
    if (
        [string]$failState.knownGood.version -ne 'v1.0.0' -or
        [string]$failState.lastFailure.version -ne 'v2.0.0'
    ) {
        throw 'Rejected Node candidate changed known-good state or lost failure evidence.'
    }
    $failPointer = (Get-Content -Raw -LiteralPath (Get-McpNodeReleaseKnownGoodPointerPath -ReleaseId 'runtime-fail' -ProjectRoot $tempRoot)).Trim()
    if ($failPointer -ne 'v1.0.0') {
        throw 'Rejected Node candidate changed the launcher pointer.'
    }

    $globalNode = @(Get-Command node.exe -CommandType Application -All -ErrorAction Stop | Select-Object -ExpandProperty Source -Unique)[0]
    $globalVersion = (& $globalNode --version).Trim()
    $managedGlobalPath = Get-McpManagedNodeExecutablePath -Version $globalVersion -ProjectRoot $tempRoot
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $managedGlobalPath) | Out-Null
    Copy-Item -LiteralPath $globalNode -Destination $managedGlobalPath
    $launcherReleaseId = 'launcher-managed'
    $launcherStateDirectory = Get-McpNodeReleaseStateDirectory -ReleaseId $launcherReleaseId -ProjectRoot $tempRoot
    New-Item -ItemType Directory -Force -Path $launcherStateDirectory | Out-Null
    Write-McpAtomicTextFile `
        -Path (Get-McpNodeReleaseKnownGoodPointerPath -ReleaseId $launcherReleaseId -ProjectRoot $tempRoot) `
        -Content ($globalVersion + [Environment]::NewLine)

    $launcherPath = Get-McpNodeHostLauncherExecutable -ProjectRoot $tempRoot -ReleaseRoot $projectRoot
    $fixturePath = Join-Path $tempRoot 'managed-fixture.mjs'
    $stdoutPath = Join-Path $tempRoot 'managed.stdout.log'
    $stderrPath = Join-Path $tempRoot 'managed.stderr.log'
    [IO.File]::WriteAllText(
        $fixturePath,
        'process.stdout.write(process.version + "\n");',
        [Text.UTF8Encoding]::new($false)
    )
    $arguments = @(
        '--node-runtime-root', (Quote-TestArgument $runtimeRoot),
        '--node-release-id', $launcherReleaseId,
        '--stdout-log', (Quote-TestArgument $stdoutPath),
        '--stderr-log', (Quote-TestArgument $stderrPath),
        '--', (Quote-TestArgument $fixturePath)
    ) -join ' '
    $process = Start-Process -FilePath $launcherPath -ArgumentList $arguments -WorkingDirectory $tempRoot -Wait -PassThru -WindowStyle Hidden
    if ([int]$process.ExitCode -ne 0) {
        throw 'Managed launcher fixture failed.'
    }
    if ((Get-Content -Raw -LiteralPath $stdoutPath).Trim() -ne $globalVersion) {
        throw 'Managed launcher did not execute the version selected by known-good.txt.'
    }

    $mismatchVersion = 'v99.0.0'
    $mismatchNode = Get-McpManagedNodeExecutablePath -Version $mismatchVersion -ProjectRoot $tempRoot
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $mismatchNode) | Out-Null
    Copy-Item -LiteralPath $globalNode -Destination $mismatchNode
    Write-McpAtomicTextFile `
        -Path (Get-McpNodeReleaseKnownGoodPointerPath -ReleaseId $launcherReleaseId -ProjectRoot $tempRoot) `
        -Content ($mismatchVersion + [Environment]::NewLine)
    $mismatchStdout = Join-Path $tempRoot 'mismatch.stdout.log'
    $mismatchStderr = Join-Path $tempRoot 'mismatch.stderr.log'
    $mismatchArguments = @(
        '--node-runtime-root', (Quote-TestArgument $runtimeRoot),
        '--node-release-id', $launcherReleaseId,
        '--stdout-log', (Quote-TestArgument $mismatchStdout),
        '--stderr-log', (Quote-TestArgument $mismatchStderr),
        '--runner-restart-count', '1',
        '--runner-restart-interval-seconds', '1',
        '--', (Quote-TestArgument $fixturePath)
    ) -join ' '
    $mismatchProcess = Start-Process -FilePath $launcherPath -ArgumentList $mismatchArguments -WorkingDirectory $tempRoot -Wait -PassThru -WindowStyle Hidden
    if ([int]$mismatchProcess.ExitCode -eq 0) {
        throw 'Managed launcher accepted a node.exe whose actual version mismatched the promoted pointer.'
    }
    if ((Get-Content -Raw -LiteralPath $mismatchStderr) -notmatch 'runtime version mismatch') {
        throw 'Managed launcher mismatch failure was not diagnostic.'
    }

    $integrityState = Read-McpNodeReleaseState -ReleaseId 'runtime-fail' -ProjectRoot $tempRoot
    $integrityState.knownGood.sha256 = '0' * 64
    Write-McpNodeReleaseState -State $integrityState -ProjectRoot $tempRoot
    $integrityRejected = $false
    try {
        [void](Read-McpNodeReleaseState -ReleaseId 'runtime-fail' -ProjectRoot $tempRoot)
    }
    catch {
        $integrityRejected = $_.Exception.Message -match 'integrity mismatch'
    }
    if (-not $integrityRejected) {
        throw 'Managed runtime state accepted a Node executable whose SHA-256 did not match the qualified record.'
    }
    $updaterContent = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Update-McpNodeRuntime.ps1')
    if ($updaterContent -match '(?i)Start-ScheduledTask|Stop-ScheduledTask|Restart-Service|Stop-Process') {
        throw 'Node runtime updater must not restart or stop live MCP hosts.'
    }
    if (-not $updaterContent.Contains('[switch]$Rollback') -or -not $updaterContent.Contains('Rollback-McpReleaseManagedNodeRuntime')) {
        throw 'Node runtime updater does not expose qualified rollback recovery.'
    }
    $installerContent = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Install-McpHostTasks.ps1')
    foreach ($required in @('--node-runtime-root', '--node-release-id', 'node-runtime-update', "-Daily -At '03:30'")) {
        if (-not $installerContent.Contains($required)) {
            throw "Managed Node host-task integration is missing: $required"
        }
    }
    $releaseContent = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'New-McpRelease.ps1')
    foreach ($required in @('Get-McpLatestNodeReleaseMetadata -Channel Current', 'Install-McpManagedNodeVersion', 'nodeVersion = $releaseNodeVersion')) {
        if (-not $releaseContent.Contains($required)) {
            throw "Release builder does not track managed current Node.js: $required"
        }
    }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output 'Managed Node runtime test passed: candidate qualification, promotion, rollback, launcher resolution and mismatch gates are enforced.'
