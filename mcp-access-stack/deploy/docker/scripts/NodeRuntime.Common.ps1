Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-McpNodeVersion {
    param([Parameter(Mandatory = $true)][string]$Version)

    $normalized = $Version.Trim()
    if ($normalized -notmatch '^v(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)$') {
        throw "Invalid stable Node.js version: $Version"
    }
    return 'v{0}.{1}.{2}' -f $Matches.major, $Matches.minor, $Matches.patch
}

function Compare-McpNodeVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    $leftVersion = [version](ConvertTo-McpNodeVersion -Version $Left).Substring(1)
    $rightVersion = [version](ConvertTo-McpNodeVersion -Version $Right).Substring(1)
    return $leftVersion.CompareTo($rightVersion)
}

function Get-McpManagedNodeRuntimeRoot {
    param([string]$ProjectRoot = (Get-McpProjectRoot))

    return Join-Path ([System.IO.Path]::GetFullPath($ProjectRoot)) '.runtime-tools\mcp-node-runtime'
}

function Get-McpManagedNodeExecutablePath {
    param(
        [Parameter(Mandatory = $true)][string]$Version,
        [string]$ProjectRoot = (Get-McpProjectRoot)
    )

    $normalized = ConvertTo-McpNodeVersion -Version $Version
    return Join-Path (Get-McpManagedNodeRuntimeRoot -ProjectRoot $ProjectRoot) "$normalized\node.exe"
}

function Get-McpManagedNodeNpmPath {
    param(
        [Parameter(Mandatory = $true)][string]$Version,
        [string]$ProjectRoot = (Get-McpProjectRoot)
    )

    $normalized = ConvertTo-McpNodeVersion -Version $Version
    return Join-Path (Get-McpManagedNodeRuntimeRoot -ProjectRoot $ProjectRoot) "$normalized\npm.cmd"
}

function Test-McpNodeExecutableVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion
    )

    $expected = ConvertTo-McpNodeVersion -Version $ExpectedVersion
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }

    $global:LASTEXITCODE = 0
    $actual = (& $Path --version 2>$null | Select-Object -First 1)
    if ([int]$global:LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$actual)) {
        return $false
    }
    return ([string]$actual).Trim() -eq $expected
}

function Assert-McpManagedNodeVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Version,
        [string]$ProjectRoot = (Get-McpProjectRoot)
    )

    $normalized = ConvertTo-McpNodeVersion -Version $Version
    $nodePath = Get-McpManagedNodeExecutablePath -Version $normalized -ProjectRoot $ProjectRoot
    if (-not (Test-McpNodeExecutableVersion -Path $nodePath -ExpectedVersion $normalized)) {
        throw "Managed Node.js runtime is missing or has the wrong version: $normalized"
    }
    return $nodePath
}

function Get-McpManagedNodeExecutableSha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Version,
        [string]$ProjectRoot = (Get-McpProjectRoot)
    )

    $nodePath = Assert-McpManagedNodeVersion -Version $Version -ProjectRoot $ProjectRoot
    return (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-McpManagedNodeRecord {
    param(
        [Parameter(Mandatory = $true)][object]$Record,
        [string]$ProjectRoot = (Get-McpProjectRoot)
    )

    $version = ConvertTo-McpNodeVersion -Version ([string]$Record.version)
    $expectedHash = ([string]$Record.sha256).Trim().ToLowerInvariant()
    if ($expectedHash -notmatch '^[a-f0-9]{64}$') {
        throw "Managed Node.js runtime record has an invalid SHA-256: $version"
    }
    $nodePath = Assert-McpManagedNodeVersion -Version $version -ProjectRoot $ProjectRoot
    $actualHash = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "Managed Node.js runtime integrity mismatch: $version"
    }
    return $nodePath
}

function Get-McpNodeReleaseStateDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [string]$ProjectRoot = (Get-McpProjectRoot)
    )

    if ($ReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw 'Invalid release ID for Node runtime state.'
    }
    return Join-Path (Get-McpManagedNodeRuntimeRoot -ProjectRoot $ProjectRoot) "release-state\$ReleaseId"
}

function Get-McpNodeReleaseStatePath {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [string]$ProjectRoot = (Get-McpProjectRoot)
    )

    return Join-Path (Get-McpNodeReleaseStateDirectory -ReleaseId $ReleaseId -ProjectRoot $ProjectRoot) 'state.json'
}

function Get-McpNodeReleaseKnownGoodPointerPath {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [string]$ProjectRoot = (Get-McpProjectRoot)
    )

    return Join-Path (Get-McpNodeReleaseStateDirectory -ReleaseId $ReleaseId -ProjectRoot $ProjectRoot) 'known-good.txt'
}

function Write-McpAtomicTextFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )

    $resolved = [System.IO.Path]::GetFullPath($Path)
    $directory = Split-Path -Parent $resolved
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = Join-Path $directory ('.tmp-' + [guid]::NewGuid().ToString('N'))
    try {
        [System.IO.File]::WriteAllText($temporary, $Content, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $resolved -Force
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Write-McpNodeReleaseState {
    param(
        [Parameter(Mandatory = $true)][object]$State,
        [string]$ProjectRoot = (Get-McpProjectRoot)
    )

    $releaseId = [string]$State.releaseId
    $knownGoodVersion = ConvertTo-McpNodeVersion -Version ([string]$State.knownGood.version)
    $knownGoodHash = ([string]$State.knownGood.sha256).Trim().ToLowerInvariant()
    if ($knownGoodHash -notmatch '^[a-f0-9]{64}$') {
        throw "Known-good Node.js runtime has an invalid SHA-256: $knownGoodVersion"
    }
    $statePath = Get-McpNodeReleaseStatePath -ReleaseId $releaseId -ProjectRoot $ProjectRoot
    $pointerPath = Get-McpNodeReleaseKnownGoodPointerPath -ReleaseId $releaseId -ProjectRoot $ProjectRoot
    $json = ($State | ConvertTo-Json -Depth 16) + [Environment]::NewLine
    Write-McpAtomicTextFile -Path $statePath -Content $json
    Write-McpAtomicTextFile -Path $pointerPath -Content ($knownGoodVersion + [Environment]::NewLine)
}

function Read-McpNodeReleaseState {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [string]$ProjectRoot = (Get-McpProjectRoot),
        [switch]$AllowMissing
    )

    $statePath = Get-McpNodeReleaseStatePath -ReleaseId $ReleaseId -ProjectRoot $ProjectRoot
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        if ($AllowMissing) { return $null }
        throw "Node runtime release state is missing: $ReleaseId"
    }
    $state = Read-McpJsonFile -Path $statePath
    if ([int]$state.version -ne 1 -or [string]$state.releaseId -ne $ReleaseId) {
        throw "Node runtime release state is invalid: $ReleaseId"
    }
    [void](Assert-McpManagedNodeRecord -Record $state.knownGood -ProjectRoot $ProjectRoot)
    if ($state.rollback) {
        [void](Assert-McpManagedNodeRecord -Record $state.rollback -ProjectRoot $ProjectRoot)
    }
    return $state
}

function Get-McpLatestNodeReleaseMetadata {
    param(
        [ValidateSet('Current', 'Lts')][string]$Channel = 'Current',
        [string]$IndexUri = 'https://nodejs.org/dist/index.json'
    )

    $releases = Invoke-RestMethod -Uri $IndexUri -Method Get -TimeoutSec 30
    foreach ($release in $releases) {
        $version = [string]$release.version
        if ($version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { continue }
        if ($Channel -eq 'Lts' -and -not $release.lts) { continue }
        $files = @($release.files | ForEach-Object { [string]$_ })
        if ($files -notcontains 'win-x64-zip') { continue }
        return [pscustomobject]@{
            version = ConvertTo-McpNodeVersion -Version $version
            lts = if ($release.lts) { [string]$release.lts } else { $null }
            date = [string]$release.date
        }
    }
    throw "Unable to resolve the latest Node.js release for channel $Channel."
}

function Install-McpManagedNodeVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Version,
        [string]$ProjectRoot = (Get-McpProjectRoot),
        [string]$DistributionBaseUri = 'https://nodejs.org/dist'
    )

    $normalized = ConvertTo-McpNodeVersion -Version $Version
    $existing = Get-McpManagedNodeExecutablePath -Version $normalized -ProjectRoot $ProjectRoot
    if (Test-McpNodeExecutableVersion -Path $existing -ExpectedVersion $normalized) {
        return $existing
    }

    $runtimeRoot = Get-McpManagedNodeRuntimeRoot -ProjectRoot $ProjectRoot
    $targetDirectory = Join-Path $runtimeRoot $normalized
    if (Test-Path -LiteralPath $targetDirectory) {
        throw "Managed Node.js directory exists but is invalid: $targetDirectory"
    }

    $archiveName = "node-$normalized-win-x64.zip"
    $versionBaseUri = $DistributionBaseUri.TrimEnd('/') + '/' + $normalized
    $stagingRoot = Join-Path $runtimeRoot ('.staging-' + $normalized + '-' + [guid]::NewGuid().ToString('N'))
    $archivePath = Join-Path $stagingRoot $archiveName
    $checksumsPath = Join-Path $stagingRoot 'SHASUMS256.txt'
    $extractRoot = Join-Path $stagingRoot 'extract'

    New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
    try {
        Invoke-WebRequest -Uri ($versionBaseUri + '/SHASUMS256.txt') -OutFile $checksumsPath -UseBasicParsing -TimeoutSec 60
        Invoke-WebRequest -Uri ($versionBaseUri + '/' + $archiveName) -OutFile $archivePath -UseBasicParsing -TimeoutSec 180

        $checksumLine = @(
            Get-Content -LiteralPath $checksumsPath |
                Where-Object { $_ -match ('^(?<hash>[0-9a-fA-F]{64})\s+' + [regex]::Escape($archiveName) + '$') }
        )
        if ($checksumLine.Count -ne 1) {
            throw "Official SHA-256 entry was not found for $archiveName."
        }
        $checksumLine[0] -match '^(?<hash>[0-9a-fA-F]{64})\s+' | Out-Null
        $expectedHash = $Matches.hash.ToLowerInvariant()
        $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "Node.js archive SHA-256 mismatch for $normalized."
        }

        New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
        $extractedDirectory = Join-Path $extractRoot "node-$normalized-win-x64"
        $extractedNode = Join-Path $extractedDirectory 'node.exe'
        if (-not (Test-McpNodeExecutableVersion -Path $extractedNode -ExpectedVersion $normalized)) {
            throw "Downloaded Node.js runtime failed version validation: $normalized"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $extractedDirectory 'npm.cmd') -PathType Leaf)) {
            throw "Downloaded Node.js runtime does not contain npm.cmd: $normalized"
        }

        New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
        Move-Item -LiteralPath $extractedDirectory -Destination $targetDirectory
        return Assert-McpManagedNodeVersion -Version $normalized -ProjectRoot $ProjectRoot
    }
    finally {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Initialize-McpReleaseNodeRuntimeState {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [string]$ProjectRoot = (Get-McpProjectRoot),
        [switch]$InstallMissing
    )

    $resolvedReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
    $manifest = Read-McpJsonFile -Path (Join-Path $resolvedReleaseRoot 'manifest.json')
    $releaseId = [string]$manifest.releaseId
    $releaseCommit = [string]$manifest.commit
    $buildNodeVersion = ConvertTo-McpNodeVersion -Version ([string]$manifest.nodeVersion)
    $existing = Read-McpNodeReleaseState -ReleaseId $releaseId -ProjectRoot $ProjectRoot -AllowMissing
    if ($existing) {
        if ([string]$existing.releaseCommit -ne $releaseCommit) {
            throw "Node runtime state commit mismatch for release $releaseId."
        }
        [void](Assert-McpManagedNodeRecord -Record $existing.knownGood -ProjectRoot $ProjectRoot)
        return $existing
    }

    if ($InstallMissing) {
        [void](Install-McpManagedNodeVersion -Version $buildNodeVersion -ProjectRoot $ProjectRoot)
    }
    else {
        [void](Assert-McpManagedNodeVersion -Version $buildNodeVersion -ProjectRoot $ProjectRoot)
    }
    $buildNodeSha256 = Get-McpManagedNodeExecutableSha256 -Version $buildNodeVersion -ProjectRoot $ProjectRoot

    $state = [pscustomobject][ordered]@{
        version = 1
        releaseId = $releaseId
        releaseCommit = $releaseCommit
        buildNodeVersion = $buildNodeVersion
        channel = 'Current'
        candidate = $null
        knownGood = [pscustomobject][ordered]@{
            version = $buildNodeVersion
            sha256 = $buildNodeSha256
            qualifiedAt = [DateTimeOffset]::UtcNow.ToString('O')
            qualification = 'release-build'
        }
        rollback = $null
        lastCheckedAt = $null
        lastFailure = $null
    }
    Write-McpNodeReleaseState -State $state -ProjectRoot $ProjectRoot
    return $state
}

function Get-McpReleaseManagedNodeExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [string]$ProjectRoot = (Get-McpProjectRoot),
        [switch]$InstallMissing
    )

    $state = Initialize-McpReleaseNodeRuntimeState -ReleaseRoot $ReleaseRoot -ProjectRoot $ProjectRoot -InstallMissing:$InstallMissing
    return Assert-McpManagedNodeRecord -Record $state.knownGood -ProjectRoot $ProjectRoot
}

function Invoke-McpNodeRuntimeQualification {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [Parameter(Mandatory = $true)][string]$CandidateVersion,
        [string]$ProjectRoot = (Get-McpProjectRoot),
        [scriptblock]$QualificationScriptBlock
    )

    $normalized = ConvertTo-McpNodeVersion -Version $CandidateVersion
    $candidateNode = Assert-McpManagedNodeVersion -Version $normalized -ProjectRoot $ProjectRoot
    if ($QualificationScriptBlock) {
        & $QualificationScriptBlock $candidateNode $normalized
        return
    }

    $manifest = Read-McpJsonFile -Path (Join-Path ([System.IO.Path]::GetFullPath($ReleaseRoot)) 'manifest.json')
    $commit = [string]$manifest.commit
    $snapshotDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('mcp-node-qualification-' + [guid]::NewGuid().ToString('N'))
    $oldPath = [string]$env:PATH
    $oldNodeExecutable = [string]$env:MCP_NODE_EXECUTABLE
    try {
        $sourceRoot = Export-McpGitSnapshot -Root $ProjectRoot -Commit $commit -Destination $snapshotDirectory
        $candidateDirectory = Split-Path -Parent $candidateNode
        $candidateNpm = Join-Path $candidateDirectory 'npm.cmd'
        if (-not (Test-Path -LiteralPath $candidateNpm -PathType Leaf)) {
            throw "Managed Node.js runtime is missing npm.cmd: $normalized"
        }
        $env:PATH = $candidateDirectory + [System.IO.Path]::PathSeparator + $oldPath
        $env:MCP_NODE_EXECUTABLE = $candidateNode
        Push-Location $sourceRoot
        try {
            & $candidateNpm ci
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed under Node.js $normalized." }
            & $candidateNpm run check
            if ($LASTEXITCODE -ne 0) { throw "npm run check failed under Node.js $normalized." }
        }
        finally {
            Pop-Location
        }
    }
    finally {
        $env:PATH = $oldPath
        if ([string]::IsNullOrEmpty($oldNodeExecutable)) {
            Remove-Item Env:MCP_NODE_EXECUTABLE -ErrorAction SilentlyContinue
        }
        else {
            $env:MCP_NODE_EXECUTABLE = $oldNodeExecutable
        }
        Remove-Item -LiteralPath $snapshotDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Update-McpReleaseManagedNodeRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [string]$ProjectRoot = (Get-McpProjectRoot),
        [ValidateSet('Current', 'Lts')][string]$Channel = 'Current',
        [string]$TargetVersion,
        [scriptblock]$QualificationScriptBlock
    )

    $state = Initialize-McpReleaseNodeRuntimeState -ReleaseRoot $ReleaseRoot -ProjectRoot $ProjectRoot -InstallMissing
    $currentVersion = ConvertTo-McpNodeVersion -Version ([string]$state.knownGood.version)
    $target = if ([string]::IsNullOrWhiteSpace($TargetVersion)) {
        [string](Get-McpLatestNodeReleaseMetadata -Channel $Channel).version
    }
    else {
        ConvertTo-McpNodeVersion -Version $TargetVersion
    }
    $state.channel = $Channel
    $state.lastCheckedAt = [DateTimeOffset]::UtcNow.ToString('O')

    if ((Compare-McpNodeVersion -Left $target -Right $currentVersion) -le 0) {
        Write-McpNodeReleaseState -State $state -ProjectRoot $ProjectRoot
        return [pscustomobject]@{
            status = 'current'
            releaseId = [string]$state.releaseId
            knownGood = $currentVersion
            candidate = $null
        }
    }

    [void](Install-McpManagedNodeVersion -Version $target -ProjectRoot $ProjectRoot)
    $candidateSha256 = Get-McpManagedNodeExecutableSha256 -Version $target -ProjectRoot $ProjectRoot
    $state.candidate = [pscustomobject][ordered]@{
        version = $target
        sha256 = $candidateSha256
        discoveredAt = [DateTimeOffset]::UtcNow.ToString('O')
    }
    $state.lastFailure = $null
    Write-McpNodeReleaseState -State $state -ProjectRoot $ProjectRoot

    try {
        Invoke-McpNodeRuntimeQualification `
            -ReleaseRoot $ReleaseRoot `
            -CandidateVersion $target `
            -ProjectRoot $ProjectRoot `
            -QualificationScriptBlock $QualificationScriptBlock

        $postQualificationSha256 = Get-McpManagedNodeExecutableSha256 -Version $target -ProjectRoot $ProjectRoot
        if ($postQualificationSha256 -ne $candidateSha256) {
            throw "Candidate Node.js runtime changed during qualification: $target"
        }
        $previous = $state.knownGood
        $state.rollback = $previous
        $state.knownGood = [pscustomobject][ordered]@{
            version = $target
            sha256 = $candidateSha256
            qualifiedAt = [DateTimeOffset]::UtcNow.ToString('O')
            qualification = 'exact-release-commit-check'
        }
        $state.candidate = $null
        $state.lastFailure = $null
        Write-McpNodeReleaseState -State $state -ProjectRoot $ProjectRoot
        return [pscustomobject]@{
            status = 'promoted'
            releaseId = [string]$state.releaseId
            knownGood = $target
            rollback = [string]$previous.version
        }
    }
    catch {
        $state.candidate = $null
        $state.lastFailure = [pscustomobject][ordered]@{
            version = $target
            failedAt = [DateTimeOffset]::UtcNow.ToString('O')
            reason = ([string]$_.Exception.Message).Replace("`r", ' ').Replace("`n", ' ').Substring(0, [Math]::Min(500, ([string]$_.Exception.Message).Length))
        }
        Write-McpNodeReleaseState -State $state -ProjectRoot $ProjectRoot
        throw
    }
}
function Rollback-McpReleaseManagedNodeRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [string]$ProjectRoot = (Get-McpProjectRoot)
    )

    $state = Initialize-McpReleaseNodeRuntimeState -ReleaseRoot $ReleaseRoot -ProjectRoot $ProjectRoot -InstallMissing
    if (-not $state.rollback) {
        throw "No qualified Node.js rollback runtime is available for release $($state.releaseId)."
    }

    [void](Assert-McpManagedNodeRecord -Record $state.rollback -ProjectRoot $ProjectRoot)
    $previousKnownGood = $state.knownGood
    $rollbackRecord = $state.rollback
    $state.knownGood = [pscustomobject][ordered]@{
        version = [string]$rollbackRecord.version
        sha256 = [string]$rollbackRecord.sha256
        qualifiedAt = [DateTimeOffset]::UtcNow.ToString('O')
        qualification = 'qualified-runtime-rollback'
    }
    $state.rollback = $previousKnownGood
    $state.candidate = $null
    Write-McpNodeReleaseState -State $state -ProjectRoot $ProjectRoot

    return [pscustomobject]@{
        status = 'rolled-back'
        releaseId = [string]$state.releaseId
        knownGood = [string]$state.knownGood.version
        rollback = [string]$state.rollback.version
    }
}

function Get-McpNodeExecutable {
    param(
        [string]$ReleaseRoot,
        [string]$ExpectedVersion
    )

    $projectRoot = Get-McpProjectRoot
    $hasExplicitExpected = -not [string]::IsNullOrWhiteSpace($ExpectedVersion)
    if ($hasExplicitExpected) {
        $expected = ConvertTo-McpNodeVersion -Version $ExpectedVersion
        $managed = Get-McpManagedNodeExecutablePath -Version $expected -ProjectRoot $projectRoot
        if (Test-McpNodeExecutableVersion -Path $managed -ExpectedVersion $expected) {
            return $managed
        }
    }

    if (-not $hasExplicitExpected -and -not [string]::IsNullOrWhiteSpace($ReleaseRoot)) {
        $resolvedReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
        $manifestPath = Join-Path $resolvedReleaseRoot 'manifest.json'
        if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
            $manifest = Read-McpJsonFile -Path $manifestPath
            $releaseId = [string]$manifest.releaseId
            $state = Read-McpNodeReleaseState -ReleaseId $releaseId -ProjectRoot $projectRoot -AllowMissing
            if ($state) {
                return Assert-McpManagedNodeRecord -Record $state.knownGood -ProjectRoot $projectRoot
            }
            $buildVersion = ConvertTo-McpNodeVersion -Version ([string]$manifest.nodeVersion)
            $managedBuild = Get-McpManagedNodeExecutablePath -Version $buildVersion -ProjectRoot $projectRoot
            if (Test-McpNodeExecutableVersion -Path $managedBuild -ExpectedVersion $buildVersion) {
                return $managedBuild
            }
            if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) {
                $ExpectedVersion = $buildVersion
            }
        }
    }

    $explicitPath = [string]$env:MCP_NODE_EXECUTABLE
    $candidatePaths = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($explicitPath)) {
        $candidatePaths.Add([System.IO.Path]::GetFullPath($explicitPath))
    }
    foreach ($candidate in @(
        Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue |
            Where-Object { Test-Path -LiteralPath $_.Source -PathType Leaf } |
            Select-Object -ExpandProperty Source -Unique |
            Sort-Object
    )) {
        $resolved = [System.IO.Path]::GetFullPath([string]$candidate)
        if (-not $candidatePaths.Contains($resolved)) {
            $candidatePaths.Add($resolved)
        }
    }

    foreach ($candidatePath in $candidatePaths) {
        if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) { continue }
        $global:LASTEXITCODE = 0
        $version = (& $candidatePath --version 2>$null | Select-Object -First 1)
        if ([int]$global:LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$version)) { continue }
        if (
            -not [string]::IsNullOrWhiteSpace($ExpectedVersion) -and
            ([string]$version).Trim() -ne (ConvertTo-McpNodeVersion -Version $ExpectedVersion)
        ) {
            continue
        }
        return $candidatePath
    }

    $requirement = if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) { 'a valid Node.js runtime' } else { "Node.js $ExpectedVersion" }
    throw "Unable to resolve $requirement. Install or qualify the MCP-managed Node runtime."
}

function Get-McpReleaseHostScriptNames {
    return @(
        'Common.ps1',
        'NodeRuntime.Common.ps1',
        'Update-McpNodeRuntime.ps1',
        'Run-DockerHostComponent.mjs'
    )
}
