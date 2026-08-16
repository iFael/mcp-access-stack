[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$release = [System.IO.Path]::GetFullPath($ReleaseRoot)
. (Join-Path $root 'deploy\windows\PublicDistribution.Common.ps1')

$releaseManifestPath = Join-Path $release 'manifest.json'
$executionManifestPath = Join-Path $release 'execution-node-manifest.json'
if (-not (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $executionManifestPath -PathType Leaf)) {
    throw 'Execution-node package is missing its release or execution manifest.'
}

$releaseManifest = Read-McpPublicJson -Path $releaseManifestPath
$executionManifest = Read-McpPublicJson -Path $executionManifestPath
if ([int]$executionManifest.version -ne 1 -or
    [string]$executionManifest.releaseId -ne [string]$releaseManifest.releaseId -or
    [string]$executionManifest.commit -ne [string]$releaseManifest.commit -or
    [string]$executionManifest.platform -ne 'win32-x64' -or
    [string]$executionManifest.runtimeMode -ne 'bundled-node' -or
    [string]$executionManifest.integrityRoot -ne 'signed-distribution-manifest') {
    throw 'Execution-node manifest identity or platform is invalid.'
}

$executionIdentity = $releaseManifest.executionNode
if ($null -eq $executionIdentity -or [int]$executionIdentity.schemaVersion -ne 1 -or
    [string]$executionIdentity.manifestPath -ne 'execution-node-manifest.json') {
    throw 'Release manifest is missing execution-node identity.'
}
$expectedManifestHash = ([string]$executionIdentity.manifestSha256).ToLowerInvariant()
$actualManifestHash = (Get-FileHash -LiteralPath $executionManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expectedManifestHash -notmatch '^[a-f0-9]{64}$' -or $actualManifestHash -ne $expectedManifestHash) {
    throw 'Execution-node manifest hash is not bound to the release manifest.'
}

$artifacts = @($executionManifest.artifacts)
if ($artifacts.Count -ne 4) {
    throw 'Bundled-node execution manifest must contain exactly four critical artifacts.'
}
$expectedRoles = @('mcp-host', 'workspace-agent', 'browser-worker', 'node-runtime')
foreach ($role in $expectedRoles) {
    $records = @($artifacts | Where-Object { [string]$_.role -eq $role })
    if ($records.Count -ne 1) {
        throw "Execution-node manifest role is missing or duplicated: $role"
    }
    $record = $records[0]
    $artifactPath = Resolve-McpPublicChildPath -Root $release -RelativePath ([string]$record.path)
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
        throw "Execution-node artifact is missing: $($record.path)"
    }
    $item = Get-Item -LiteralPath $artifactPath
    if ([long]$record.sizeBytes -ne [long]$item.Length) {
        throw "Execution-node artifact size mismatch: $($record.path)"
    }
    $actualHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$record.sha256 -notmatch '^[a-f0-9]{64}$' -or $actualHash -ne ([string]$record.sha256).ToLowerInvariant()) {
        throw "Execution-node artifact hash mismatch: $($record.path)"
    }
    if ($record.authenticodeRequired -eq $true) {
        Assert-McpPublicSignature -Path $artifactPath | Out-Null
    }
}

foreach ($compatibilityExecutable in @(
    'compat\McpNodeHostLauncher.exe',
    'compat\McpCredentialBroker.exe'
)) {
    $path = Join-Path $release $compatibilityExecutable
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Signed compatibility artifact is missing: $compatibilityExecutable"
    }
    Assert-McpPublicSignature -Path $path | Out-Null
}

$hostPath = Join-Path $release 'native\McpHost.exe'
$hostVersion = @(& $hostPath --version)
if ($LASTEXITCODE -ne 0 -or $hostVersion.Count -ne 1 -or [string]$hostVersion[0] -ne 'mcp-host-contract-v1') {
    throw 'Signed McpHost failed its version smoke check.'
}
$hostValidation = @(& $hostPath --validate-release-root $release)
if ($LASTEXITCODE -ne 0 -or $hostValidation.Count -ne 1 -or [string]$hostValidation[0] -ne 'release-root-valid') {
    throw 'Signed McpHost failed its release-root validation smoke check.'
}

$nodePath = Join-Path $release 'runtime\node\node.exe'
$nodeVersion = @(& $nodePath --version)
if ($LASTEXITCODE -ne 0 -or $nodeVersion.Count -ne 1 -or [string]$nodeVersion[0] -ne [string]$releaseManifest.nodeVersion) {
    throw 'Bundled Node.js runtime does not match the immutable release manifest.'
}

Write-Output 'Signed Windows execution-node package passed manifest, hash, signature and runtime smoke validation.'
