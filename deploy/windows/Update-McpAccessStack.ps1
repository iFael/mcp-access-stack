[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository,

    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [string]$Tag,
    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$publicCommonSignature = Get-AuthenticodeSignature -LiteralPath $publicCommonPath
if (
    $publicCommonSignature.Status -ne 'Valid' -and
    -not ($AllowUnsignedDevelopment -and $publicCommonSignature.Status -eq 'NotSigned')
) {
    throw "Invalid Authenticode signature for $publicCommonPath. Status=$($publicCommonSignature.Status)"
}
. $publicCommonPath

if (-not $Execute) {
    throw 'Update preparation is intentionally gated. Re-run with -Execute.'
}
Assert-McpPublicWindowsX64

$installation = [IO.Path]::GetFullPath($InstallationRoot)
if (-not (Test-Path -LiteralPath $installation -PathType Container)) {
    throw "Installation root was not found: $installation"
}

$headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'mcp-access-stack-updater'
    'X-GitHub-Api-Version' = '2022-11-28'
}
$releaseUri = if ($Tag) {
    "https://api.github.com/repos/$Repository/releases/tags/$Tag"
}
else {
    "https://api.github.com/repos/$Repository/releases/latest"
}
$release = Invoke-RestMethod -Uri $releaseUri -Headers $headers
$resolvedTag = [string]$release.tag_name
$assetName = "$resolvedTag-windows-x64.zip"
$hashAssetName = "$assetName.sha256"
$asset = @($release.assets | Where-Object { [string]$_.name -eq $assetName })[0]
$hashAsset = @($release.assets | Where-Object { [string]$_.name -eq $hashAssetName })[0]
if (-not $asset -or -not $hashAsset) {
    throw "Release assets are incomplete: $assetName and $hashAssetName are required."
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) (
    'mcp-public-update-' + [guid]::NewGuid().ToString('N')
)
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
try {
    $archivePath = Join-Path $temporaryRoot $assetName
    $hashPath = Join-Path $temporaryRoot $hashAssetName
    Invoke-WebRequest -Uri ([string]$asset.browser_download_url) -Headers $headers -OutFile $archivePath
    Invoke-WebRequest -Uri ([string]$hashAsset.browser_download_url) -Headers $headers -OutFile $hashPath
    $expectedHash = ([regex]::Match(
        (Get-Content -LiteralPath $hashPath -Raw),
        '(?i)\b[a-f0-9]{64}\b'
    )).Value.ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $expectedHash -or $actualHash -ne $expectedHash) {
        throw 'Downloaded release archive failed SHA-256 validation.'
    }

    $expandedRoot = Join-Path $temporaryRoot 'expanded'
    Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedRoot
    $manifestFiles = @(Get-ChildItem -LiteralPath $expandedRoot -Recurse -File -Filter 'distribution-manifest.ps1')
    if ($manifestFiles.Count -ne 1) {
        throw 'The release archive must contain exactly one distribution manifest.'
    }
    $packageRoot = Split-Path -Parent $manifestFiles[0].FullName
    $packageCommonPath = Join-Path $packageRoot 'deploy\windows\PublicDistribution.Common.ps1'
    Assert-McpPublicSignature `
        -Path $packageCommonPath `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    . $packageCommonPath

    $distribution = Assert-McpPublicDistribution `
        -Root $packageRoot `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    if ([int]$distribution.schemaVersion -ne 2) {
        throw 'Current updater accepts only Docker-free distribution manifest v2.'
    }
    $releaseId = [string]$distribution.releaseId
    $sourceRelease = Resolve-McpPublicChildPath `
        -Root $packageRoot `
        -RelativePath ("releases/{0}" -f $releaseId)
    $releaseManifest = Assert-McpPublicReleaseFiles -ReleaseRoot $sourceRelease
    $releaseAttestation = Assert-McpPublicReleaseAttestation `
        -ReleaseRoot $sourceRelease `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    if (
        [int]$releaseAttestation.schemaVersion -ne 2 -or
        [string]$releaseManifest.releaseId -ne $releaseId -or
        [string]$releaseAttestation.releaseId -ne $releaseId
    ) {
        throw 'Downloaded release does not satisfy the current release contract v2.'
    }

    $stager = Join-Path $packageRoot 'deploy\windows\Stage-McpWindowsExecutionNodeCandidate.ps1'
    Assert-McpPublicSignature -Path $stager -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    $stageResult = & $stager `
        -DistributionRoot $packageRoot `
        -InstallationRoot $installation `
        -ExpectedReleaseId $releaseId `
        -Execute `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
    if ([string]$stageResult.status -ne 'ready') {
        throw 'Downloaded release did not reach candidate-ready state.'
    }

    [pscustomobject]@{
        downloaded = $true
        releaseId = $releaseId
        candidatePrepared = $true
        alreadyPrepared = [bool]$stageResult.alreadyPrepared
        promoted = $false
        nextAction = 'Run Install-McpAccessStack.ps1 with the environment token/configuration files. It starts the detached Edge cutover broker and returns the resultPath used to observe completion.'
    } | ConvertTo-Json -Compress
}
finally {
    $resolvedTemporaryRoot = [IO.Path]::GetFullPath($temporaryRoot)
    $systemTemporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTemporaryRoot.StartsWith(
        $systemTemporaryRoot,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
