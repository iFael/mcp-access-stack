[CmdletBinding()]
param(
    [string]$ReleaseId = ([DateTimeOffset]::UtcNow.ToString('yyyy-MM-dd.HHmmss')),
    [switch]$AllowDirty,
    [switch]$SkipCheck,
    [ValidateRange(0, 9223372036854775807)]
    [long]$GitHubCiRunId = 0,
    [switch]$SkipDockerImages,
    [switch]$NoCache
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if ($ReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw 'ReleaseId contains unsupported characters or is too long.'
}

if ($SkipCheck -and $GitHubCiRunId -gt 0) {
    throw 'SkipCheck and GitHubCiRunId are mutually exclusive validation modes.'
}

Assert-McpCommand -Name 'git'
if (-not $SkipDockerImages) {
    Assert-McpCommand -Name 'docker'
}

$root = Get-McpProjectRoot
$releasesDirectory = Join-Path $root 'releases'
$releaseDirectory = Join-Path $releasesDirectory $ReleaseId
$stagingDirectory = Join-Path $releasesDirectory ('.staging-' + $ReleaseId)
$snapshotDirectory = Join-Path ([System.IO.Path]::GetTempPath()) (
    'mcp-release-source-{0}-{1}' -f $ReleaseId, [guid]::NewGuid().ToString('N')
)
if (Test-Path -LiteralPath $releaseDirectory) {
    throw "Release already exists: $releaseDirectory"
}
if (Test-Path -LiteralPath $stagingDirectory) {
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
}
$createdImageTags = [System.Collections.Generic.List[string]]::new()
$candidateUpdated = $false
$validationEvidence = $null
$latestNodeRelease = Get-McpLatestNodeReleaseMetadata -Channel Current
$releaseNodeVersion = [string]$latestNodeRelease.version
$releaseNode = Install-McpManagedNodeVersion -Version $releaseNodeVersion -ProjectRoot $root
$releaseNpm = Get-McpManagedNodeNpmPath -Version $releaseNodeVersion -ProjectRoot $root
if (-not (Test-Path -LiteralPath $releaseNpm -PathType Leaf)) {
    throw "Managed npm.cmd was not found for Node.js $releaseNodeVersion."
}
$previousPath = [string]$env:PATH
$previousNodeExecutable = [string]$env:MCP_NODE_EXECUTABLE
$env:PATH = (Split-Path -Parent $releaseNode) + [System.IO.Path]::PathSeparator + $previousPath
$env:MCP_NODE_EXECUTABLE = $releaseNode


Push-Location $root
try {
    $gitStatus = @(& git status --porcelain -- .)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read Git status.' }
    if (-not $AllowDirty -and $gitStatus.Count -gt 0) {
        throw 'The workspace is dirty. Commit or stash changes, or use -AllowDirty only for a non-production validation release.'
    }

    $commit = (& git rev-parse --verify 'HEAD^{commit}').Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve the Git commit.' }


    if ($GitHubCiRunId -gt 0) {
        $validationEvidence = Get-McpGitHubCiAttestation -RunId $GitHubCiRunId -ExpectedCommit $commit
    }
    $sourceRoot = Export-McpGitSnapshot -Root $root -Commit $commit -Destination $snapshotDirectory

    Push-Location $sourceRoot
    try {
        & $releaseNpm ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed in the clean release snapshot.' }

        if ($GitHubCiRunId -gt 0) {
            & $releaseNpm run build
            if ($LASTEXITCODE -ne 0) { throw 'npm run build failed in the clean release snapshot.' }
        }
        elseif (-not $SkipCheck) {
            & $releaseNpm run check
            if ($LASTEXITCODE -ne 0) { throw 'npm run check failed in the clean release snapshot.' }
        }
        else {
            & $releaseNpm run build
            if ($LASTEXITCODE -ne 0) { throw 'npm run build failed in the clean release snapshot.' }
        }
    }
    finally {
        Pop-Location
    }

    if ($GitHubCiRunId -eq 0 -and -not $SkipCheck) {
        $validationEvidence = [ordered]@{
            mode = 'local-check'
            command = 'npm run check'
            verifiedAt = [DateTimeOffset]::UtcNow.ToString('O')
        }
    }
    elseif ($SkipCheck) {
        $validationEvidence = [ordered]@{
            mode = 'build-only'
            command = 'npm run build'
            verifiedAt = [DateTimeOffset]::UtcNow.ToString('O')
        }
    }

    New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'package.json'), (Join-Path $sourceRoot 'package-lock.json') -Destination $stagingDirectory

    $workspacePaths = @(Get-McpReleaseRuntimeWorkspacePaths)
    $workspaceClosure = Assert-McpReleaseRuntimeWorkspaceClosure `
        -SourceRoot $sourceRoot `
        -WorkspacePaths $workspacePaths
    if ([int]$workspaceClosure.workspaceCount -ne $workspacePaths.Count) {
        throw 'Release runtime workspace closure returned an unexpected workspace count.'
    }
    foreach ($workspacePath in $workspacePaths) {
        $sourceWorkspace = Join-Path $sourceRoot $workspacePath
        $target = Join-Path $stagingDirectory $workspacePath
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        Copy-Item -LiteralPath (Join-Path $sourceWorkspace 'package.json') -Destination $target
        $distPath = Join-Path $sourceWorkspace 'dist'
        if (Test-Path -LiteralPath $distPath -PathType Container) {
            Copy-Item -LiteralPath $distPath -Destination $target -Recurse
        }
    }

    Copy-McpReleaseHostScripts -SourceRoot $sourceRoot -DestinationRoot $stagingDirectory

    Push-Location $stagingDirectory
    try {
        & $releaseNpm ci --omit=dev --ignore-scripts --workspaces --include-workspace-root
        if ($LASTEXITCODE -ne 0) {
            throw 'Production dependency installation failed in the staged release.'
        }
    }
    finally {
        Pop-Location
    }

    Convert-McpReleaseWorkspaceModulesToDirectories `
        -ReleaseRoot $stagingDirectory `
        -WorkspacePaths $workspacePaths

    $workspaceCleanup = Remove-McpReleaseUnselectedWorkspaceLinks `
        -ReleaseRoot $stagingDirectory `
        -WorkspacePaths $workspacePaths
    if ($null -eq $workspaceCleanup.removedWorkspaceLinks) {
        throw 'Release workspace portability cleanup returned invalid evidence.'
    }

    $hashedFiles = Get-ChildItem -LiteralPath $stagingDirectory -File -Recurse |
        Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } |
        Sort-Object FullName
    $hashes = foreach ($file in $hashedFiles) {
        $relativePath = $file.FullName.Substring($stagingDirectory.Length).TrimStart('\', '/').Replace('\', '/')
        [ordered]@{
            path = $relativePath
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }

    $rootPackage = Read-McpJsonFile -Path (Join-Path $sourceRoot 'package.json')
    $browserPackage = Read-McpJsonFile -Path (Join-Path $sourceRoot 'services\browser-worker\package.json')
    $browserRegistry = Read-McpJsonFile -Path (Join-Path $sourceRoot 'node_modules\playwright-core\browsers.json')
    $chromiumDescriptor = @($browserRegistry.browsers | Where-Object { [string]$_.name -eq 'chromium' })[0]
    if (-not $chromiumDescriptor) {
        throw 'Unable to resolve the managed Chromium revision from playwright-core.'
    }
    $imageRecords = [System.Collections.Generic.List[object]]::new()

    if (-not $SkipDockerImages) {
        $imageTags = @(
            "mcp-access-stack/gateway:$ReleaseId",
            "mcp-access-stack/proxy:$ReleaseId"
        )
        foreach ($imageTag in $imageTags) {
            & docker image inspect $imageTag *> $null
            if ($LASTEXITCODE -eq 0) {
                throw "Docker image tag already exists: $imageTag"
            }
        }

        $cacheArguments = if ($NoCache) { @('--no-cache') } else { @() }
        Push-Location $sourceRoot
        try {
            & docker build @cacheArguments -f deploy/docker/gateway.Dockerfile -t $imageTags[0] .
            if ($LASTEXITCODE -ne 0) { throw 'Gateway image build failed.' }
            $createdImageTags.Add($imageTags[0])

            & docker build @cacheArguments -f deploy/docker/proxy.Dockerfile -t $imageTags[1] .
            if ($LASTEXITCODE -ne 0) { throw 'Proxy image build failed.' }
            $createdImageTags.Add($imageTags[1])

            & docker image inspect @imageTags | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Built image inspection failed.' }
            foreach ($imageTag in $imageTags) {
                $imageId = (& docker image inspect --format '{{.Id}}' $imageTag).Trim()
                if ($LASTEXITCODE -ne 0 -or $imageId -notmatch '^sha256:[a-f0-9]{64}$') {
                    throw "Unable to resolve immutable image ID for $imageTag."
                }
                $imageRecords.Add([ordered]@{
                    tag = $imageTag
                    digest = $imageId
                })
            }
        }
        finally {
            Pop-Location
        }
    }

    $manifest = [ordered]@{
        releaseId = $ReleaseId
        version = [string]$rootPackage.version
        commit = $commit
        builtAt = [DateTimeOffset]::UtcNow.ToString('O')
        nodeVersion = $releaseNodeVersion
        protocolVersion = 2
        persistedStateVersion = 4
        engine = 'playwright-direct'
        engineVersion = [string]$browserPackage.version
        playwrightVersion = [string]$browserPackage.dependencies.playwright
        chromium = [ordered]@{
            name = [string]$chromiumDescriptor.name
            revision = [string]$chromiumDescriptor.revision
            browserVersion = [string]$chromiumDescriptor.browserVersion
        }
        dockerImages = @($imageRecords)
        testsPassed = (-not $SkipCheck)
        validation = $validationEvidence
        dirty = ($gitStatus.Count -gt 0)
        source = 'clean-git-snapshot'
        fileHashes = @($hashes)
    }
    Write-McpJsonFile -Path (Join-Path $stagingDirectory 'manifest.json') -Value $manifest

    Move-Item -LiteralPath $stagingDirectory -Destination $releaseDirectory
    if ($manifest.testsPassed -eq $true -and $manifest.dirty -ne $true) {
        $candidate = [ordered]@{
            version = 1
            releaseId = $ReleaseId
            path = $releaseDirectory
            commit = $commit
            builtAt = [string]$manifest.builtAt
        }
        Assert-McpReleasePointerEligible -Pointer $candidate -Root $root | Out-Null
        Write-McpReleasePointer -Name 'candidate' -Root $root -Value $candidate
        $candidateUpdated = $true
    }
}
catch {
    if (Test-Path -LiteralPath $stagingDirectory) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    foreach ($imageTag in $createdImageTags) {
        & docker image rm $imageTag *> $null
    }
    throw
}
finally {
    Pop-Location
    if (Test-Path -LiteralPath $snapshotDirectory) {
        Remove-Item -LiteralPath $snapshotDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    $env:PATH = $previousPath
    if ([string]::IsNullOrEmpty($previousNodeExecutable)) {
        Remove-Item Env:MCP_NODE_EXECUTABLE -ErrorAction SilentlyContinue
    }
    else {
        $env:MCP_NODE_EXECUTABLE = $previousNodeExecutable
    }
}

Write-Output "Immutable release created: $releaseDirectory"
Write-Output "Release ID: $ReleaseId"
Write-Output "Source commit: $commit"
if ($candidateUpdated) {
    Write-Output 'Candidate release pointer updated. The active release was not changed.'
}
else {
    Write-Output 'Candidate release pointer was not changed because the release lacks production-eligible validation evidence.'
}
Write-Output 'The active checkout and its node_modules were not modified.'
