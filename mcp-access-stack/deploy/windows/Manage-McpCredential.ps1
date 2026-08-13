[CmdletBinding()]
param(
    [ValidateSet('development', 'production')]
    [string]$Environment = 'production',

    [ValidatePattern('^[a-z0-9._-]{1,128}$')]
    [string]$SiteId = 'private-site',

    [ValidatePattern('^[a-z0-9._-]{1,128}$')]
    [string]$AccountId = 'default',

    [string]$PrivateDirectory,
    [string]$ReleaseRoot,
    [switch]$Wait
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'Credential management is supported only on Windows.'
}

$common = Join-Path $PSScriptRoot '..\docker\scripts\Common.ps1'
. ([System.IO.Path]::GetFullPath($common))

$root = Get-McpProjectRoot
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $active = Read-McpReleasePointer -Name active -Root $root -AllowMissing
    $ReleaseRoot = if ($active) {
        [string]$active.path
    }
    else {
        $root
    }
}
$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)

if ([string]::IsNullOrWhiteSpace($PrivateDirectory)) {
    $configurationPath = Join-Path $root ".runtime-private\docker\$Environment\browser.json"
    if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
        throw "Browser Worker private configuration is missing: $configurationPath"
    }
    $configuration = Read-McpJsonFile -Path $configurationPath
    $PrivateDirectory = [string]$configuration.privateDirectory
}
$PrivateDirectory = [System.IO.Path]::GetFullPath($PrivateDirectory)

$normalizedPath = $PrivateDirectory.ToLowerInvariant()
$pathBytes = [Text.Encoding]::UTF8.GetBytes($normalizedPath)
try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash($pathBytes)
    }
    finally {
        $sha256.Dispose()
    }
    $installationHash = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
    $installationHash = $installationHash.Substring(0, 24)
    [Array]::Clear($hashBytes, 0, $hashBytes.Length)
}
finally {
    [Array]::Clear($pathBytes, 0, $pathBytes.Length)
}

$target = "McpAccessStack/$installationHash/$SiteId/$AccountId"
$broker = Get-McpCredentialBrokerExecutable -ProjectRoot $root -ReleaseRoot $ReleaseRoot
$arguments = @(
    '--mode', 'manage',
    '--target', $target,
    '--site', $SiteId
)

$process = Start-Process `
    -FilePath $broker `
    -ArgumentList $arguments `
    -PassThru `
    -Wait:$Wait

if ($Wait -and $process.ExitCode -ne 0) {
    throw "Credential broker management UI failed with exit code $($process.ExitCode)."
}

Write-Output "Opened Windows Credential Manager UI for site '$SiteId' and account '$AccountId'."
