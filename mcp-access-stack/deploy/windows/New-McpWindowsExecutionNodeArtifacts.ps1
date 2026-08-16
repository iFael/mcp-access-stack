[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$ReleaseId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{40}$')]
    [string]$SourceCommit,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'Windows execution-node native artifacts can only be built on Windows.'
}

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$release = [System.IO.Path]::GetFullPath($ReleaseRoot)
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$manifestPath = Join-Path $release 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Immutable release manifest was not found: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([string]$manifest.releaseId -ne $ReleaseId -or [string]$manifest.commit -ne $SourceCommit) {
    throw 'Execution-node native build identity does not match the immutable release.'
}

$compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = @($compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }) | Select-Object -First 1
if (-not $compiler) {
    throw 'Unable to find the Windows C# compiler.'
}

if (Test-Path -LiteralPath $output) {
    Remove-Item -LiteralPath $output -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $output | Out-Null

function Invoke-CSharpBuild {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [ValidateSet('exe', 'winexe')][string]$TargetType = 'winexe',
        [string[]]$References = @()
    )

    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        throw "Native source file was not found: $SourcePath"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TargetPath) | Out-Null
    $arguments = @(
        '/nologo',
        "/target:$TargetType",
        '/optimize+',
        '/platform:x64'
    )
    foreach ($reference in $References) {
        $arguments += "/reference:$reference"
    }
    $arguments += "/out:$TargetPath"
    $arguments += $SourcePath

    $global:LASTEXITCODE = 0
    & $compiler @arguments
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) {
        throw "Native artifact compilation failed: $TargetPath"
    }
}

$hostSource = Join-Path $root 'tooling\windows-execution-node\McpHost.cs'
$launcherSource = Join-Path $release 'tooling\windows-host-launcher\McpNodeHostLauncher.cs'
$brokerSource = Join-Path $release 'tooling\windows-credential-broker\McpCredentialBroker.cs'

$hostPath = Join-Path $output 'McpHost.exe'
$launcherPath = Join-Path $output 'McpNodeHostLauncher.exe'
$brokerPath = Join-Path $output 'McpCredentialBroker.exe'

Invoke-CSharpBuild -SourcePath $hostSource -TargetPath $hostPath -TargetType exe
Invoke-CSharpBuild -SourcePath $launcherSource -TargetPath $launcherPath -TargetType winexe
Invoke-CSharpBuild `
    -SourcePath $brokerSource `
    -TargetPath $brokerPath `
    -TargetType winexe `
    -References @('System.Windows.Forms.dll', 'System.Drawing.dll')

$hostVersion = @(& $hostPath --version)
if ($LASTEXITCODE -ne 0 -or $hostVersion.Count -ne 1 -or [string]$hostVersion[0] -ne 'mcp-host-contract-v1') {
    throw 'Compiled McpHost failed its contract-version smoke check.'
}

$artifacts = foreach ($file in @($hostPath, $launcherPath, $brokerPath)) {
    $item = Get-Item -LiteralPath $file
    [ordered]@{
        name = $item.Name
        sizeBytes = [long]$item.Length
        sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

[pscustomobject]@{
    status = 'built'
    releaseId = $ReleaseId
    commit = $SourceCommit
    compiler = [System.IO.Path]::GetFullPath([string]$compiler)
    artifacts = @($artifacts)
} | ConvertTo-Json -Depth 8 -Compress
