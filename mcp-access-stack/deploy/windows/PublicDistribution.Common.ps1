[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:McpPublicCodeSigningThumbprint = 'EC1DACA3C03E386BAB8E95B6E7929A4CA8342672'

function Normalize-McpPublicThumbprint {
    param([Parameter(Mandatory = $true)][string]$Value)
    return ($Value -replace '[^A-Fa-f0-9]', '').ToUpperInvariant()
}

function Assert-McpPublicCertificateThumbprint {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedThumbprint
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Certificate file was not found: $Path"
    }
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
        [System.IO.Path]::GetFullPath($Path)
    )
    $actual = Normalize-McpPublicThumbprint -Value $certificate.Thumbprint
    $expected = Normalize-McpPublicThumbprint -Value $ExpectedThumbprint
    if ($actual -ne $expected) {
        throw "Certificate thumbprint mismatch: $Path"
    }
    return $certificate
}

function Get-McpPublicProjectRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}

function Assert-McpPublicCommand {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command was not found: $Name"
    }
}

function Assert-McpPublicAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this installer from an elevated PowerShell session.'
    }
}

function Assert-McpPublicWindowsX64 {
    if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
        throw 'This distribution supports Windows x64 only.'
    }
}

function Assert-McpPublicSignature {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$AllowUnsignedDevelopment
    )

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($AllowUnsignedDevelopment -and $signature.Status -eq 'NotSigned') {
        return
    }
    if ($signature.Status -ne 'Valid') {
        throw "Invalid Authenticode signature for $Path. Status=$($signature.Status)"
    }
    if (-not $signature.SignerCertificate) {
        throw "Authenticode signature does not expose a signer certificate: $Path"
    }
    $actualThumbprint = Normalize-McpPublicThumbprint -Value $signature.SignerCertificate.Thumbprint
    $expectedThumbprint = Normalize-McpPublicThumbprint -Value $script:McpPublicCodeSigningThumbprint
    if ($actualThumbprint -ne $expectedThumbprint) {
        throw "Authenticode signer is not the MCP Access Stack project signer: $Path"
    }
}

function Read-McpPublicJson {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required JSON file was not found: $Path"
    }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Resolve-McpPublicChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    if (
        [string]::IsNullOrWhiteSpace($RelativePath) -or
        [System.IO.Path]::IsPathRooted($RelativePath)
    ) {
        throw "Distribution path must be relative: $RelativePath"
    }
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot $RelativePath))
    $relative = [System.IO.Path]::GetRelativePath($resolvedRoot, $resolved)
    if (
        $relative -eq '..' -or
        $relative.StartsWith('..' + [System.IO.Path]::DirectorySeparatorChar) -or
        $relative.StartsWith('..' + [System.IO.Path]::AltDirectorySeparatorChar)
    ) {
        throw "Distribution path escapes its root: $RelativePath"
    }
    return $resolved
}

function Assert-McpPublicDistribution {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$AllowUnsignedDevelopment
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    $manifestPath = Join-Path $resolvedRoot 'distribution-manifest.ps1'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Signed distribution manifest was not found: $manifestPath"
    }
    Assert-McpPublicSignature `
        -Path $manifestPath `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    $manifest = & $manifestPath
    if ($null -eq $manifest) {
        throw 'Signed distribution manifest returned no data.'
    }
    if ([int]$manifest.schemaVersion -ne 1) {
        throw "Unsupported distribution manifest version: $($manifest.schemaVersion)"
    }
    if ([string]$manifest.platform -ne 'windows-x64') {
        throw "Unsupported distribution platform: $($manifest.platform)"
    }
    if ([string]$manifest.releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw 'Distribution manifest contains an invalid releaseId.'
    }
    foreach ($entry in @($manifest.files)) {
        $path = Resolve-McpPublicChildPath -Root $resolvedRoot -RelativePath ([string]$entry.path)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Distribution file is missing: $($entry.path)"
        }
        $expected = ([string]$entry.sha256).ToLowerInvariant()
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expected -notmatch '^[a-f0-9]{64}$' -or $actual -ne $expected) {
            throw "Distribution file hash mismatch: $($entry.path)"
        }
    }
    return $manifest
}

function Assert-McpPublicReleaseFiles {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot)

    $resolvedRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
    $manifest = Read-McpPublicJson -Path (Join-Path $resolvedRoot 'manifest.json')
    foreach ($entry in @($manifest.fileHashes)) {
        $path = Resolve-McpPublicChildPath -Root $resolvedRoot -RelativePath ([string]$entry.path)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Immutable release file is missing: $($entry.path)"
        }
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne ([string]$entry.sha256).ToLowerInvariant()) {
            throw "Immutable release file hash mismatch: $($entry.path)"
        }
    }
    return $manifest
}

function Assert-McpPublicReleaseAttestation {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [switch]$AllowUnsignedDevelopment
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
    $attestationPath = Join-Path $resolvedRoot 'release-attestation.ps1'
    if (-not (Test-Path -LiteralPath $attestationPath -PathType Leaf)) {
        throw "Signed release attestation was not found: $attestationPath"
    }
    Assert-McpPublicSignature `
        -Path $attestationPath `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    $attestation = & $attestationPath
    if ($null -eq $attestation -or [int]$attestation.schemaVersion -ne 1) {
        throw 'Unsupported or missing release attestation.'
    }
    if ([string]$attestation.releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw 'Release attestation contains an invalid releaseId.'
    }
    if ([string]$attestation.commit -notmatch '^[a-f0-9]{40}$') {
        throw 'Release attestation contains an invalid commit.'
    }
    $manifestPath = Join-Path $resolvedRoot 'manifest.json'
    $manifest = Read-McpPublicJson -Path $manifestPath
    if (
        [string]$manifest.releaseId -ne [string]$attestation.releaseId -or
        [string]$manifest.commit -ne [string]$attestation.commit
    ) {
        throw 'Release attestation identity does not match manifest.json.'
    }
    $expectedManifestHash = ([string]$attestation.manifestSha256).ToLowerInvariant()
    $actualManifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expectedManifestHash -notmatch '^[a-f0-9]{64}$' -or $actualManifestHash -ne $expectedManifestHash) {
        throw 'Release attestation manifest hash mismatch.'
    }
    $images = @($attestation.dockerImages)
    if ($images.Count -ne 2) {
        throw 'Release attestation must contain exactly gateway and proxy images.'
    }
    foreach ($component in @('gateway', 'proxy')) {
        $record = @($images | Where-Object { [string]$_.component -eq $component })
        if ($record.Count -ne 1) {
            throw "Release attestation image identity is incomplete: $component"
        }
        if (
            [string]$record[0].repository -notmatch '^ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.\/-]+$' -or
            [string]$record[0].digest -notmatch '^sha256:[a-f0-9]{64}$'
        ) {
            throw "Release attestation image reference is invalid: $component"
        }
    }
    return $attestation
}

function Import-McpPublicDockerImages {
    param(
        [Parameter(Mandatory = $true)][object]$Manifest,
        [Parameter(Mandatory = $true)][string]$ReleaseId
    )

    foreach ($image in @($Manifest.dockerImages)) {
        $repository = [string]$image.repository
        $digest = [string]$image.digest
        $component = [string]$image.component
        if ($component -notin @('gateway', 'proxy')) {
            throw "Unsupported Docker image component: $component"
        }
        if ($digest -notmatch '^sha256:[a-f0-9]{64}$') {
            throw "Invalid Docker digest for component: $component"
        }
        $immutableReference = "$repository@$digest"
        & docker pull $immutableReference
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to pull Docker image: $immutableReference"
        }
        & docker tag $immutableReference "mcp-access-stack/${component}:$ReleaseId"
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to tag Docker image for component: $component"
        }
    }
}

function ConvertFrom-McpPublicSecureString {
    param([Parameter(Mandatory = $true)][Security.SecureString]$Value)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}
