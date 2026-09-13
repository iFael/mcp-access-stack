[CmdletBinding()]
param(
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
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
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
        [string[]]$References = @(),
        [string[]]$AdditionalSourcePaths = @()
    )

    foreach ($source in @($SourcePath) + @($AdditionalSourcePaths)) {
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Native source file was not found: $source"
        }
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
    foreach ($source in $AdditionalSourcePaths) {
        $arguments += $source
    }

    $global:LASTEXITCODE = 0
    & $compiler @arguments
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) {
        throw "Native artifact compilation failed: $TargetPath"
    }
}

$edgeHostSource = Join-Path $root 'tooling\windows-edge-host\McpEdgeHost.cs'
$launcherSource = Join-Path $root 'tooling\windows-host-launcher\McpNodeHostLauncher.cs'
$brokerSource = Join-Path $root 'tooling\windows-credential-broker\McpCredentialBroker.cs'

$edgeHostPath = Join-Path $output 'McpEdgeHost.exe'
$launcherPath = Join-Path $output 'McpNodeHostLauncher.exe'
$brokerPath = Join-Path $output 'McpCredentialBroker.exe'

Invoke-CSharpBuild -SourcePath $edgeHostSource -TargetPath $edgeHostPath -TargetType winexe -References @('System.Web.Extensions.dll')
Invoke-CSharpBuild -SourcePath $launcherSource -TargetPath $launcherPath -TargetType winexe
Invoke-CSharpBuild `
    -SourcePath $brokerSource `
    -TargetPath $brokerPath `
    -TargetType winexe `
    -References @('System.Windows.Forms.dll', 'System.Drawing.dll')

$artifacts = foreach ($file in @($edgeHostPath, $launcherPath, $brokerPath)) {
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
