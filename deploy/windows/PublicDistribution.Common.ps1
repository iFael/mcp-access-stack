[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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
    $isWindowsPlatform = [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [Runtime.InteropServices.OSPlatform]::Windows
    )
    if (-not $isWindowsPlatform -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
        throw 'This distribution supports Windows x64 only.'
    }
}

function Assert-McpPublicFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$AllowUnsignedDevelopment
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required public distribution file is missing: $Path"
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
    $rootPrefix = $resolvedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
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
        throw "Distribution manifest was not found: $manifestPath"
    }
    Assert-McpPublicFile `
        -Path $manifestPath `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    $manifest = & $manifestPath
    if ($null -eq $manifest) {
        throw 'Distribution manifest returned no data.'
    }
    $schemaVersion = [int]$manifest.schemaVersion
    if ($schemaVersion -ne 2) {
        throw "Unsupported distribution manifest version: $($manifest.schemaVersion)"
    }
    if ($manifest.PSObject.Properties['dockerImages']) {
        throw 'Distribution manifest v2 must not contain dockerImages.'
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
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        # Release-relative path -> SHA-256 of files the caller already hashed
        # under this root; those files are not read again.
        [hashtable]$VerifiedFileHashes
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
    $manifest = Read-McpPublicJson -Path (Join-Path $resolvedRoot 'manifest.json')
    foreach ($entry in @($manifest.fileHashes)) {
        $path = Resolve-McpPublicChildPath -Root $resolvedRoot -RelativePath ([string]$entry.path)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Immutable release file is missing: $($entry.path)"
        }
        $relativePath = ([string]$entry.path).Replace('\', '/')
        $actual = if ($null -ne $VerifiedFileHashes -and $VerifiedFileHashes.ContainsKey($relativePath)) {
            [string]$VerifiedFileHashes[$relativePath]
        }
        else {
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
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
        throw "Release integrity record was not found: $attestationPath"
    }
    Assert-McpPublicFile `
        -Path $attestationPath `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    $attestation = & $attestationPath
    $schemaVersion = if ($null -eq $attestation) { 0 } else { [int]$attestation.schemaVersion }
    if ($schemaVersion -ne 2) {
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
    if ($attestation.PSObject.Properties['dockerImages']) {
        throw 'Release attestation v2 must not contain dockerImages.'
    }
    return $attestation
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
