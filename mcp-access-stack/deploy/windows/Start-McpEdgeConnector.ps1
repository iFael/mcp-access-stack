[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$ExpectedManifestSha256,

    [Parameter(Mandatory = $true)]
    [string]$RuntimeRoot,

    [Parameter(Mandatory = $true)]
    [string]$EdgeBaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$ConnectorTokenFile,

    [Parameter(Mandatory = $true)]
    [string]$OwnerTokenFile,

    [Parameter(Mandatory = $true)]
    [string]$PolicyPath,

    [string]$AllowedOrigins = 'https://chatgpt.com,https://chat.openai.com',
    [string]$OwnerOAuthScopes = 'workspaces:read',

    [ValidateRange(1, 64)]
    [int]$MaxConcurrentRequests = 8,

    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-McpEdgeReleaseChild {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidate = [IO.Path]::GetFullPath((Join-Path $resolvedRoot ($RelativePath.Replace('/', '\'))))
    $prefix = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Edge Connector artifact escapes the release root: $RelativePath"
    }
    return $candidate
}

function Assert-McpEdgeArtifact {
    param(
        [Parameter(Mandatory = $true)][object]$Manifest,
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $records = @($Manifest.artifacts | Where-Object { [string]$_.role -eq $Role })
    if ($records.Count -ne 1) {
        throw "Edge Connector manifest role is missing or duplicated: $Role"
    }
    $record = $records[0]
    $artifactPath = Resolve-McpEdgeReleaseChild -Root $Root -RelativePath ([string]$record.path)
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
        throw "Edge Connector artifact is missing: $($record.path)"
    }
    $item = Get-Item -LiteralPath $artifactPath
    if ([long]$record.sizeBytes -ne [long]$item.Length) {
        throw "Edge Connector artifact size mismatch: $($record.path)"
    }
    $expectedHash = ([string]$record.sha256).ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expectedHash -notmatch '^[a-f0-9]{64}$' -or $actualHash -ne $expectedHash) {
        throw "Edge Connector artifact hash mismatch: $($record.path)"
    }
    return $artifactPath
}

function Assert-McpEdgeSecretFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [ValidateRange(1, 4096)][int]$MaxBytes = 4096
    )

    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "$Name file was not found."
    }
    $item = Get-Item -LiteralPath $resolved
    if ($item.Length -le 0 -or $item.Length -gt $MaxBytes) {
        throw "$Name file size is invalid."
    }
    return $resolved
}

function Read-McpEdgeOwnerToken {
    param([Parameter(Mandatory = $true)][string]$Path)

    $raw = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    $token = $raw.Trim()
    if ($token.Length -lt 16 -or $token.Length -gt 2048 -or $token -match '[\r\n\0]') {
        throw 'Owner token file contains an invalid token.'
    }
    return $token
}

$release = [IO.Path]::GetFullPath($ReleaseRoot)
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$manifestPath = Join-Path $release 'execution-node-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'Execution-node manifest was not found in the Edge Connector release.'
}
$actualManifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualManifestSha256 -ne $ExpectedManifestSha256.ToLowerInvariant()) {
    throw 'Edge Connector execution manifest changed after task installation.'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([int]$manifest.version -ne 1 -or
    [string]$manifest.platform -ne 'win32-x64' -or
    [string]$manifest.runtimeMode -ne 'bundled-node') {
    throw 'Edge Connector execution manifest identity is invalid.'
}

$nodePath = Assert-McpEdgeArtifact -Manifest $manifest -Role 'node-runtime' -Root $release
$edgeCliPath = Assert-McpEdgeArtifact -Manifest $manifest -Role 'edge-connector' -Root $release
$launcherPath = Assert-McpEdgeArtifact -Manifest $manifest -Role 'edge-connector-launcher' -Root $release
if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath) -or
    [IO.Path]::GetFullPath([string]$PSCommandPath) -ne [IO.Path]::GetFullPath($launcherPath)) {
    throw 'Edge Connector launcher must execute from the immutable release artifact.'
}

try {
    $edgeUri = [Uri]$EdgeBaseUrl
}
catch {
    throw 'EdgeBaseUrl must be a valid HTTPS origin.'
}
if (-not $edgeUri.IsAbsoluteUri -or
    $edgeUri.Scheme -ne 'https' -or
    -not [string]::IsNullOrWhiteSpace($edgeUri.UserInfo) -or
    $edgeUri.AbsolutePath -ne '/' -or
    -not [string]::IsNullOrWhiteSpace($edgeUri.Query) -or
    -not [string]::IsNullOrWhiteSpace($edgeUri.Fragment)) {
    throw 'EdgeBaseUrl must be a credential-free HTTPS origin with no path, query or fragment.'
}

$connectorTokenPath = Assert-McpEdgeSecretFile -Path $ConnectorTokenFile -Name 'Connector token'
$ownerTokenPath = Assert-McpEdgeSecretFile -Path $OwnerTokenFile -Name 'Owner token'
$policy = [IO.Path]::GetFullPath($PolicyPath)
if (-not (Test-Path -LiteralPath $policy -PathType Leaf)) {
    throw 'Workspace policy file was not found.'
}
$ownerToken = Read-McpEdgeOwnerToken -Path $ownerTokenPath

if ($ValidateOnly) {
    [pscustomobject]@{
        status = 'validated'
        releaseRoot = $release
        executionManifestSha256 = $actualManifestSha256
        edgeOrigin = $edgeUri.GetLeftPart([UriPartial]::Authority)
        nodePath = $nodePath
        edgeConnectorPath = $edgeCliPath
        browserEnabled = $false
    } | ConvertTo-Json -Compress
    return
}

$logs = Join-Path $runtime 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$stdoutLog = Join-Path $logs 'edge-connector.stdout.log'
$stderrLog = Join-Path $logs 'edge-connector.stderr.log'

$env:MCP_EDGE_BASE_URL = $edgeUri.GetLeftPart([UriPartial]::Authority)
$env:MCP_CONNECTOR_TOKEN_FILE = $connectorTokenPath
$env:VS_CODE_GPT_POLICY_PATH = $policy
$env:MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS = [string]$MaxConcurrentRequests
$env:AUTH_MODE = 'owner'
$env:OWNER_TOKEN = $ownerToken
$env:OWNER_OAUTH_SCOPES = $OwnerOAuthScopes
$env:OWNER_OAUTH_STATE_PATH = Join-Path $runtime 'owner-oauth-state.json'
$env:ALLOWED_ORIGINS = $AllowedOrigins
$env:BROWSER_WORKER_ENABLED = 'false'

try {
    & $nodePath $edgeCliPath 1>> $stdoutLog 2>> $stderrLog
    $exitCode = $LASTEXITCODE
}
finally {
    $env:OWNER_TOKEN = $null
    $ownerToken = $null
}
if ($exitCode -ne 0) {
    throw "Edge Connector exited with code $exitCode."
}