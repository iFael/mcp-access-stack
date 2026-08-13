[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$version = '8.30.1'
$assetName = "gitleaks_${version}_windows_x64.zip"
$assetUrl = "https://github.com/gitleaks/gitleaks/releases/download/v$version/$assetName"
$expectedSha256 = 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e'
$installRoot = Join-Path $projectRoot ".runtime-tools\gitleaks\$version"
$binaryPath = Join-Path $installRoot 'gitleaks.exe'

function Test-GitleaksBinary {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    $output = & $Path version 2>&1
    if ($LASTEXITCODE -ne 0) {
        return $false
    }
    return (($output | Out-String) -match [regex]::Escape($version))
}

if ($CheckOnly) {
    if (-not (Test-GitleaksBinary -Path $binaryPath)) {
        throw "Gitleaks $version is not installed in the private validation tools directory."
    }
    Write-Output "Gitleaks $version is installed and executable."
    exit 0
}

if ((Test-GitleaksBinary -Path $binaryPath) -and -not $Force) {
    Write-Output "Gitleaks $version is already installed."
    exit 0
}

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'The pinned Gitleaks validation tool requires 64-bit Windows.'
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("mcp-gitleaks-" + [guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $temporaryRoot $assetName
$extractPath = Join-Path $temporaryRoot 'extract'

try {
    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
    Invoke-WebRequest -Uri $assetUrl -OutFile $archivePath -UseBasicParsing

    $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $expectedSha256) {
        throw 'The downloaded Gitleaks archive failed SHA-256 verification.'
    }

    New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
    $extractedBinary = Get-ChildItem -LiteralPath $extractPath -Recurse -File -Filter 'gitleaks.exe' |
        Select-Object -First 1
    if ($null -eq $extractedBinary) {
        throw 'The verified Gitleaks archive did not contain gitleaks.exe.'
    }

    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    Copy-Item -LiteralPath $extractedBinary.FullName -Destination $binaryPath -Force

    if (-not (Test-GitleaksBinary -Path $binaryPath)) {
        throw 'The installed Gitleaks binary did not pass its version check.'
    }

    Write-Output "Gitleaks $version was installed in the private validation tools directory."
}
finally {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
