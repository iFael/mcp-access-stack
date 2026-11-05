[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$ReleaseId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{40}$')]
    [string]$SourceCommit,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [ValidateRange(0, 9223372036854775807)]
    [long]$BuildRunId = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'Immutable Windows release can only be built on Windows.'
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$output = [IO.Path]::GetFullPath($OutputDirectory)
$outputParent = Split-Path -Parent $output
$staging = Join-Path $outputParent ('.staging-' + $ReleaseId + '-' + [guid]::NewGuid().ToString('N'))

if (Test-Path -LiteralPath $output) {
    throw "Immutable release already exists: $output"
}
New-Item -ItemType Directory -Force -Path $outputParent | Out-Null

$head = @(& git -C $root rev-parse --verify 'HEAD^{commit}')
if ($LASTEXITCODE -ne 0 -or $head.Count -ne 1 -or [string]$head[0] -ne $SourceCommit) {
    throw 'Current Git HEAD does not match SourceCommit.'
}
$status = @(& git -C $root status --porcelain -- .)
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to inspect Git status for immutable release input.'
}
if ($status.Count -gt 0) {
    throw 'Immutable release requires a clean source checkout.'
}

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$npmCommand = Get-Command npm.cmd -ErrorAction Stop
$nodeExecutable = [IO.Path]::GetFullPath([string]$nodeCommand.Source)
$npmExecutable = [IO.Path]::GetFullPath([string]$npmCommand.Source)
$nodeVersionOutput = @(& $nodeExecutable --version)
if ($LASTEXITCODE -ne 0 -or $nodeVersionOutput.Count -ne 1) {
    throw 'Unable to resolve the active Node.js version.'
}
$nodeVersion = ([string]$nodeVersionOutput[0]).Trim()
if ($nodeVersion -notmatch '^v26\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
    throw "Immutable release requires Node.js 26.x. Observed: $nodeVersion"
}

$workspacePaths = @(
    'services/browser-worker',
    'services/workspace-agent',
    'services/mcp-gateway',
    'packages/mcp-core',
    'packages/edge-protocol',
    'packages/update-control-contract'
)
foreach ($workspacePath in $workspacePaths) {
    $workspaceRoot = Join-Path $root $workspacePath
    if (-not (Test-Path -LiteralPath (Join-Path $workspaceRoot 'package.json') -PathType Leaf)) {
        throw "Runtime workspace package.json is missing: $workspacePath"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $workspaceRoot 'dist') -PathType Container)) {
        throw "Runtime workspace build output is missing: $workspacePath/dist"
    }
}

function Copy-WorkspaceRuntime {
    param([Parameter(Mandatory = $true)][string]$WorkspacePath)

    $source = Join-Path $root $WorkspacePath
    $target = Join-Path $staging $WorkspacePath
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination $target
    Copy-Item -LiteralPath (Join-Path $source 'dist') -Destination $target -Recurse
}

function Get-WorkspaceModulePath {
    param([Parameter(Mandatory = $true)][string]$PackageName)

    if ($PackageName -notmatch '^(@[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+$') {
        throw "Runtime workspace package name is unsafe: $PackageName"
    }
    $segments = @($PackageName -split '/')
    if ($segments.Count -eq 2) {
        return Join-Path (Join-Path (Join-Path $staging 'node_modules') $segments[0]) $segments[1]
    }
    return Join-Path (Join-Path $staging 'node_modules') $segments[0]
}

function Materialize-WorkspaceModules {
    $selected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($workspacePath in $workspacePaths) {
        [void]$selected.Add($workspacePath.Replace('\', '/'))
        $workspaceRoot = Join-Path $staging $workspacePath
        $package = Get-Content -LiteralPath (Join-Path $workspaceRoot 'package.json') -Raw | ConvertFrom-Json
        $modulePath = Get-WorkspaceModulePath -PackageName ([string]$package.name)
        if (Test-Path -LiteralPath $modulePath) {
            Remove-Item -LiteralPath $modulePath -Recurse -Force
        }
        New-Item -ItemType Directory -Force -Path $modulePath | Out-Null
        Copy-Item -LiteralPath (Join-Path $workspaceRoot 'package.json') -Destination (Join-Path $modulePath 'package.json')
        Copy-Item -LiteralPath (Join-Path $workspaceRoot 'dist') -Destination $modulePath -Recurse
    }

    $lockPath = Join-Path $staging 'package-lock.json'
    $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json -AsHashtable
    if (-not $lock.ContainsKey('packages')) {
        throw 'Immutable release package-lock.json does not contain a packages map.'
    }
    foreach ($record in $lock.packages.GetEnumerator()) {
        $entry = $record.Value
        if ($null -eq $entry -or -not $entry.ContainsKey('link') -or $entry['link'] -ne $true) {
            continue
        }
        $moduleRelative = ([string]$record.Key).Replace('/', '\')
        if (-not $moduleRelative.StartsWith('node_modules\', [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $workspaceRelative = ([string]$entry.resolved).Replace('\', '/').Trim('/')
        if ($selected.Contains($workspaceRelative)) {
            continue
        }
        $modulePath = [IO.Path]::GetFullPath((Join-Path $staging $moduleRelative))
        if (Test-Path -LiteralPath $modulePath) {
            $item = Get-Item -LiteralPath $modulePath -Force
            if ([string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
                throw "Unexpected physical unselected workspace module: $($record.Key)"
            }
            Remove-Item -LiteralPath $modulePath -Force
        }
    }

    $residualLinks = @(
        Get-ChildItem -LiteralPath (Join-Path $staging 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue |
            Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.LinkType) }
    )
    if ($residualLinks.Count -gt 0) {
        throw "Immutable release node_modules contains a residual filesystem link: $($residualLinks[0].FullName)"
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($Path), $Content, [Text.UTF8Encoding]::new($false))
}

function Install-VerifiedZipArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$Sha256,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $archive = Join-Path $staging (".download-" + [guid]::NewGuid().ToString('N') + ".zip")
    try {
        Invoke-WebRequest -Uri $Uri -OutFile $archive -UseBasicParsing
        $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $Sha256) {
            throw "$Label failed SHA-256 verification."
        }
        New-Item -ItemType Directory -Force -Path $Destination | Out-Null
        Expand-Archive -LiteralPath $archive -DestinationPath $Destination -Force
    }
    finally {
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    }
}
try {
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination $staging
    Copy-Item -LiteralPath (Join-Path $root 'package-lock.json') -Destination $staging
    foreach ($workspacePath in $workspacePaths) {
        Copy-WorkspaceRuntime -WorkspacePath $workspacePath
    }

    Push-Location $staging
    try {
        $null = & $npmExecutable ci --omit=dev --ignore-scripts --workspaces --include-workspace-root
        if ($LASTEXITCODE -ne 0) {
            throw 'Production dependency installation failed for immutable release.'
        }
    }
    finally {
        Pop-Location
    }

    Materialize-WorkspaceModules

    $nodeRuntimeRoot = Join-Path $staging 'runtime\node'
    New-Item -ItemType Directory -Force -Path $nodeRuntimeRoot | Out-Null
    $bundledNode = Join-Path $nodeRuntimeRoot 'node.exe'
    Copy-Item -LiteralPath $nodeExecutable -Destination $bundledNode
    $bundledVersion = @(& $bundledNode --version)
    if ($LASTEXITCODE -ne 0 -or $bundledVersion.Count -ne 1 -or [string]$bundledVersion[0] -ne $nodeVersion) {
        throw 'Bundled Node.js runtime failed version verification.'
    }

    # Import the real Companion release path, not just its manifest: this catches
    # workspace packages omitted by npm workspace-link removal before publication.
    Push-Location $staging
    try {
        & $bundledNode --input-type=module -e 'await import("./node_modules/@vs-code-gpt/local-agent/dist/release/oracle-control-caller.js");'
        if ($LASTEXITCODE -ne 0) {
            throw 'Immutable Windows release cannot load its Oracle runtime dependencies.'
        }
    }
    finally {
        Pop-Location
    }

    $validationConfigSource = Join-Path $root 'config\validation'
    $validationConfigTarget = Join-Path $staging 'config\validation'
    if (-not (Test-Path -LiteralPath (Join-Path $validationConfigSource 'ast-grep\sgconfig.yml') -PathType Leaf)) {
        throw 'Validation configuration is missing from the release source.'
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $validationConfigTarget) | Out-Null
    Copy-Item -LiteralPath $validationConfigSource -Destination $validationConfigTarget -Recurse

    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'MCP V3 Windows local runtime requires a 64-bit operating system.'
    }

    $gitleaksRoot = Join-Path $staging '.runtime-tools\gitleaks\8.30.1'
    Install-VerifiedZipArchive `
        -Uri 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_windows_x64.zip' `
        -Sha256 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e' `
        -Destination $gitleaksRoot `
        -Label 'Gitleaks 8.30.1'
    $gitleaksExecutable = Join-Path $gitleaksRoot 'gitleaks.exe'
    if (-not (Test-Path -LiteralPath $gitleaksExecutable -PathType Leaf)) {
        throw 'Verified Gitleaks archive did not contain gitleaks.exe.'
    }
    $gitleaksVersion = @(& $gitleaksExecutable version)
    if ($LASTEXITCODE -ne 0 -or (($gitleaksVersion | Out-String) -notmatch '8\.30\.1')) {
        throw 'Bundled Gitleaks failed version verification.'
    }

    $gitRoot = Join-Path $staging 'runtime\git'
    Install-VerifiedZipArchive `
        -Uri 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/MinGit-2.55.0.3-64-bit.zip' `
        -Sha256 'f48e2d2dc74a24454adc6d8fd0ac25bf9c2386f19cfb06202b9465aaad4f9f05' `
        -Destination $gitRoot `
        -Label 'MinGit 2.55.0.3'
    $gitExecutable = Join-Path $gitRoot 'cmd\git.exe'
    if (-not (Test-Path -LiteralPath $gitExecutable -PathType Leaf)) {
        throw 'Verified MinGit archive did not contain cmd\git.exe.'
    }
    $gitVersion = @(& $gitExecutable --version)
    if ($LASTEXITCODE -ne 0 -or (($gitVersion | Out-String) -notmatch 'git version 2\.55\.0\.windows\.3')) {
        throw 'Bundled MinGit failed version verification.'
    }
    # Bundle an immutable full FFmpeg for GIF/H.264 browser previews.
    $ffmpegRelease = 'autobuild-2026-11-03-12-50'
    $ffmpegAsset = 'ffmpeg-N-128352-gec887b13a8-win64-gpl.zip'
    $ffmpegBaseUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$ffmpegRelease"
    $ffmpegChecksumPath = Join-Path $staging '.ffmpeg-checksums.sha256'
    $ffmpegUnpacked = Join-Path $staging '.ffmpeg-unpacked'
    try {
        Invoke-WebRequest -Uri "$ffmpegBaseUrl/checksums.sha256" -OutFile $ffmpegChecksumPath -UseBasicParsing
        $expectedChecksumManifestSha = 'a48ca149c424241395907ce66d0ec7337cf62ef6dc0ca58706a4249897bfebcb'
        $manifestSha = (Get-FileHash -LiteralPath $ffmpegChecksumPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($manifestSha -ne $expectedChecksumManifestSha) {
            throw 'FFmpeg upstream checksum manifest failed SHA-256 verification.'
        }
        $ffmpegEntry = @(Get-Content -LiteralPath $ffmpegChecksumPath | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+\*?' + [Regex]::Escape($ffmpegAsset) + '$') })
        if ($ffmpegEntry.Count -ne 1) { throw 'FFmpeg release checksum entry is missing or ambiguous.' }
        $ffmpegSha = ($ffmpegEntry[0] -split '\s+')[0].ToLowerInvariant()
        Install-VerifiedZipArchive -Uri "$ffmpegBaseUrl/$ffmpegAsset" -Sha256 $ffmpegSha -Destination $ffmpegUnpacked -Label 'FFmpeg GPL static Windows build'
        $ffmpegCandidates = @(Get-ChildItem -LiteralPath $ffmpegUnpacked -Recurse -File -Filter 'ffmpeg.exe')
        if ($ffmpegCandidates.Count -ne 1) { throw 'Verified FFmpeg archive lacks exactly one ffmpeg.exe.' }
        $mediaRoot = Join-Path $staging 'runtime\media'
        New-Item -ItemType Directory -Path $mediaRoot -Force | Out-Null
        $bundledFfmpeg = Join-Path $mediaRoot 'ffmpeg.exe'
        Copy-Item -LiteralPath $ffmpegCandidates[0].FullName -Destination $bundledFfmpeg
        $ffmpegLicenses = @(Get-ChildItem -LiteralPath $ffmpegUnpacked -Recurse -File -Filter 'LICENSE.txt')
        if ($ffmpegLicenses.Count -ne 1) { throw 'Verified FFmpeg archive lacks a single license file.' }
        Copy-Item -LiteralPath $ffmpegLicenses[0].FullName -Destination (Join-Path $mediaRoot 'LICENSE.ffmpeg.txt')
        $ffmpegEncoders = @(& $bundledFfmpeg -hide_banner -encoders)
        if ($LASTEXITCODE -ne 0 -or
            (($ffmpegEncoders | Out-String) -notmatch '(?m)^\s*V\S*\s+libx264\s') -or
            (($ffmpegEncoders | Out-String) -notmatch '(?m)^\s*V\S*\s+gif\s')) {
            throw 'Bundled FFmpeg lacks required GIF or libx264 encoders.'
        }
        $probe = Join-Path $staging '.ffmpeg-probe.mp4'
        try {
            & $bundledFfmpeg -nostdin -hide_banner -loglevel error -f lavfi -i 'testsrc2=s=160x90:r=10:d=0.5' -an -c:v libx264 -pix_fmt yuv420p -y $probe
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $probe -PathType Leaf)) {
                throw 'Bundled FFmpeg failed a real H.264 encoding smoke test.'
            }
            $gifProbe = Join-Path $staging '.ffmpeg-probe.gif'
            & $bundledFfmpeg -nostdin -hide_banner -loglevel error -f lavfi -i 'testsrc2=s=160x90:r=10:d=0.5' -an -c:v gif -y $gifProbe
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $gifProbe -PathType Leaf)) {
                throw 'Bundled FFmpeg failed a real GIF encoding smoke test.'
            }
        }
        finally {
            Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $gifProbe -Force -ErrorAction SilentlyContinue
        }
    }
    finally {
        Remove-Item -LiteralPath $ffmpegChecksumPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $ffmpegUnpacked -Recurse -Force -ErrorAction SilentlyContinue
    }

    $fileHashes = @(
        Get-ChildItem -LiteralPath $staging -Recurse -File |
            Where-Object {
                $_.FullName -notmatch '[\\/]node_modules[\\/]' -and
                $_.Name -ne 'manifest.json'
            } |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    path = $_.FullName.Substring($staging.Length).TrimStart('\', '/').Replace('\', '/')
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
    )

    $now = [DateTimeOffset]::UtcNow.ToString('O')
    $manifest = [ordered]@{
        schemaVersion = 2
        releaseId = $ReleaseId
        version = $ReleaseId
        commit = $SourceCommit
        builtAt = $now
        nodeVersion = $nodeVersion
        testsPassed = ($BuildRunId -gt 0)
        dirty = $false
        validation = if ($BuildRunId -gt 0) {
            [ordered]@{
                mode = 'github-actions'
                runId = $BuildRunId
                verifiedAt = $now
            }
        }
        else {
            [ordered]@{
                mode = 'local-build-only'
                verifiedAt = $now
            }
        }
        source = 'clean-git-checkout'
        fileHashes = $fileHashes
    }
    Write-Utf8NoBom -Path (Join-Path $staging 'manifest.json') -Content (($manifest | ConvertTo-Json -Depth 32) + [Environment]::NewLine)

    [IO.Directory]::Move($staging, $output)
    $staging = $null

    [pscustomobject]@{
        status = 'created'
        releaseId = $ReleaseId
        commit = $SourceCommit
        nodeVersion = $nodeVersion
        testsPassed = [bool]$manifest.testsPassed
        output = $output
    } | ConvertTo-Json -Compress
}
finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
