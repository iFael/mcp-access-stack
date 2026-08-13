[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository,

    [string]$Tag,
    [string]$InstallationRoot,
    [switch]$Promote,
    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

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
foreach ($command in @('docker')) {
    Assert-McpPublicCommand -Name $command
}

$root = if ([string]::IsNullOrWhiteSpace($InstallationRoot)) {
    Get-McpPublicProjectRoot
}
else {
    [System.IO.Path]::GetFullPath($InstallationRoot)
}
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "Installation root was not found: $root"
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

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
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
    Assert-McpPublicSignature `
        -Path (Join-Path $packageRoot 'deploy\windows\Install-McpAccessStack.ps1') `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    Assert-McpPublicSignature `
        -Path (Join-Path $packageRoot 'deploy\windows\Update-McpAccessStack.ps1') `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    $distribution = Assert-McpPublicDistribution `
        -Root $packageRoot `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    $releaseId = [string]$distribution.releaseId
    $sourceRelease = Join-Path $packageRoot "releases\$releaseId"
    $releaseManifest = Assert-McpPublicReleaseFiles -ReleaseRoot $sourceRelease
    $releaseAttestation = Assert-McpPublicReleaseAttestation `
        -ReleaseRoot $sourceRelease `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    if ([string]$releaseAttestation.releaseId -ne $releaseId) {
        throw 'Signed release attestation does not match the downloaded distribution.'
    }

    $targetRelease = Join-Path $root "releases\$releaseId"
    if (Test-Path -LiteralPath $targetRelease) {
        throw "Release is already installed: $releaseId"
    }
    $resolvedReleasesRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'releases'))
    $resolvedTarget = [System.IO.Path]::GetFullPath($targetRelease)
    if (-not $resolvedTarget.StartsWith(
        $resolvedReleasesRoot + [System.IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Resolved release target escapes the installation releases directory.'
    }

    Import-McpPublicDockerImages -Manifest $distribution -ReleaseId $releaseId
    Copy-Item -LiteralPath $sourceRelease -Destination $targetRelease -Recurse

    . (Join-Path $root 'deploy\docker\scripts\Common.ps1')
    Assert-McpReleasePointerEligible -Root $root -Pointer ([pscustomobject]@{
        releaseId = $releaseId
        path = $targetRelease
        commit = [string]$releaseManifest.commit
    }) | Out-Null
    Write-McpReleasePointer -Name 'candidate' -Root $root -Value ([ordered]@{
        version = 1
        releaseId = $releaseId
        path = $targetRelease
        commit = [string]$releaseManifest.commit
        builtAt = [string]$releaseManifest.builtAt
    })

    $promotionRequested = $false
    if ($Promote) {
        $promotionRequest = Join-Path $root 'deploy\docker\scripts\Request-McpProductionPromotion.ps1'
        & $promotionRequest -Execute -ExpectedReleaseId $releaseId
        if ($LASTEXITCODE -ne 0) {
            throw 'Candidate promotion request failed; the previous active release remains unchanged.'
        }
        $promotionRequested = $true
    }

    [pscustomobject]@{
        downloaded = $true
        releaseId = $releaseId
        candidatePrepared = $true
        promotionRequested = $promotionRequested
        promoted = $false
    } | ConvertTo-Json -Compress
}
finally {
    $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
    $systemTemporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedTemporaryRoot.StartsWith(
        $systemTemporaryRoot,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
