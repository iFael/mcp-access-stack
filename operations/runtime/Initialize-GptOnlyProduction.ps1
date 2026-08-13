[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$PublicBaseUrl,

    [string]$TunnelExecutable,

    [switch]$DockerTunnel,

    [string]$PolicyPath,

    [ValidateSet('owner', 'none')]
    [string]$AuthMode = 'owner',

    [string]$McpPath,

    [ValidateRange(1, 65535)]
    [int]$ProxyPort = 3300,

    [ValidateRange(1, 65535)]
    [int]$GatewayPort = 3310,

    [ValidateRange(1, 65535)]
    [int]$BrowserPort = 3350,

    [switch]$EnableActions,
    [string[]]$ActionWorkspaceIds = @(),
    [switch]$AllowActionWrites,
    [switch]$AllowActionShell,
    [switch]$Force,

    [string]$OutputPath,

    [string]$PrivateRoot,

    [string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ([string]::IsNullOrWhiteSpace($PrivateRoot)) {
    $PrivateRoot = Join-Path $projectRoot '.runtime-private'
}
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    $RuntimeRoot = Join-Path $projectRoot 'runtime'
}
$privateRoot = [System.IO.Path]::GetFullPath($PrivateRoot)
$runtimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)

if (($AllowActionWrites -or $AllowActionShell) -and -not $EnableActions) {
    throw 'AllowActionWrites and AllowActionShell require EnableActions.'
}
if (-not $EnableActions -and $ActionWorkspaceIds.Count -gt 0) {
    throw 'ActionWorkspaceIds requires EnableActions.'
}
if ($EnableActions -and $ActionWorkspaceIds.Count -eq 0) {
    throw 'EnableActions requires at least one explicit ActionWorkspaceIds value.'
}
$ActionWorkspaceIds = @(
    $ActionWorkspaceIds |
        ForEach-Object { ([string]$_).Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -Unique
)
if ($ActionWorkspaceIds | Where-Object { $_ -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }) {
    throw 'ActionWorkspaceIds contains an unsupported workspace ID.'
}
if ((@($ProxyPort, $GatewayPort, $BrowserPort) | Select-Object -Unique).Count -ne 3) {
    throw 'ProxyPort, GatewayPort and BrowserPort must be distinct.'
}

function New-SecureToken {
    param([int]$ByteLength = 32)

    $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes($ByteLength)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Value)

    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $hash = [System.Security.Cryptography.SHA256]::HashData($bytes)
    return [Convert]::ToHexString($hash).ToLowerInvariant()
}

function Set-Utf8NoBomAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporaryPath = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllText(
            $temporaryPath,
            $Value,
            [System.Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    }
    finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

function Test-PathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Candidate
    )

    $relative = [System.IO.Path]::GetRelativePath($Parent, $Candidate)
    if ([System.IO.Path]::IsPathRooted($relative)) {
        return $false
    }
    return $relative -ne '.' -and
        $relative -ne '..' -and
        -not $relative.StartsWith('..' + [System.IO.Path]::DirectorySeparatorChar) -and
        -not $relative.StartsWith('..' + [System.IO.Path]::AltDirectorySeparatorChar)
}

function Resolve-ExistingFile {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $resolved = [System.IO.Path]::GetFullPath($Value)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "$Name was not found: $resolved"
    }
    return $resolved
}

if ([string]::IsNullOrWhiteSpace($PolicyPath)) {
    $PolicyPath = Join-Path $projectRoot 'config\workspace-policy.local.json'
}
$resolvedPolicyPath = Resolve-ExistingFile -Value $PolicyPath -Name 'Workspace policy'

if ($DockerTunnel) {
    if (-not [string]::IsNullOrWhiteSpace($TunnelExecutable)) {
        throw 'TunnelExecutable cannot be combined with DockerTunnel.'
    }
    $resolvedTunnelExecutable = $null
}
else {
    if ([string]::IsNullOrWhiteSpace($TunnelExecutable)) {
        $command = Get-Command 'ngrok.exe' -ErrorAction SilentlyContinue
        if ($null -eq $command) {
            $command = Get-Command 'ngrok' -ErrorAction SilentlyContinue
        }
        if ($null -eq $command) {
            throw 'ngrok was not found. Pass -TunnelExecutable or use -DockerTunnel.'
        }
        $TunnelExecutable = $command.Source
    }
    $resolvedTunnelExecutable = Resolve-ExistingFile -Value $TunnelExecutable -Name 'Tunnel executable'
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $privateRoot 'gpt-only-production.json'
}
$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if (-not (Test-PathInside -Parent $privateRoot -Candidate $resolvedOutputPath)) {
    throw 'OutputPath must stay inside PrivateRoot because the configuration contains secrets.'
}
if ((Test-Path -LiteralPath $resolvedOutputPath) -and -not $Force) {
    throw "Production configuration already exists. Use -Force to replace it: $resolvedOutputPath"
}

if ([string]::IsNullOrWhiteSpace($McpPath)) {
    $McpPath = '/mcp-' + (New-SecureToken -ByteLength 9).ToLowerInvariant()
}
if ($McpPath -notmatch '^/[A-Za-z0-9_-]+$' -or $McpPath -in @('/agent', '/health')) {
    throw 'McpPath must be one non-reserved absolute path segment.'
}

$publicUri = [Uri]$PublicBaseUrl
if (-not [string]::IsNullOrWhiteSpace($publicUri.UserInfo) -or
    -not [string]::IsNullOrWhiteSpace($publicUri.Query) -or
    -not [string]::IsNullOrWhiteSpace($publicUri.Fragment)) {
    throw 'PublicBaseUrl must not contain credentials, query parameters or fragments.'
}
$normalizedPublicBaseUrl = $publicUri.GetLeftPart([UriPartial]::Authority)

$agentToken = New-SecureToken
$browserToken = New-SecureToken
$ownerToken = if ($AuthMode -eq 'owner') { New-SecureToken } else { $null }
$actionsToken = if ($EnableActions) { New-SecureToken } else { $null }
$ownerTokenPath = Join-Path $privateRoot 'owner-token.txt'
$actionsTokenPath = Join-Path $privateRoot 'gpt-actions-token.txt'

$browserPrivateDirectory = Join-Path $privateRoot 'browser'
$browserProfileDirectory = Join-Path $browserPrivateDirectory 'chrome-profile'
$browserRuntimeDirectory = Join-Path $runtimeRoot 'browser'
$workspaceDataDirectory = Join-Path $privateRoot 'workspace-agent-data'

$config = [ordered]@{
    schemaVersion = 1
    architecture = 'gpt-only'
    nodeEnv = 'production'
    ports = [ordered]@{
        proxy = $ProxyPort
        gateway = $GatewayPort
        browser = $BrowserPort
    }
    mcpPath = $McpPath
    publicBaseUrl = $normalizedPublicBaseUrl
    allowedOrigins = 'https://chatgpt.com,https://chat.openai.com,http://127.0.0.1'
    authMode = $AuthMode
    gpt = [ordered]@{
        root = $projectRoot
        policy = $resolvedPolicyPath
        data = $workspaceDataDirectory
        agentId = 'gpt-only-production-agent'
        token = $agentToken
        tokenSha = Get-Sha256Hex -Value $agentToken
    }
    browser = [ordered]@{
        token = $browserToken
        engine = 'playwright-direct'
        mode = 'diagnostic'
        profileMode = 'persistent'
        browserChannel = 'chromium'
        maxConcurrentTabs = 4
        runtimeDirectory = $browserRuntimeDirectory
        privateDirectory = $browserPrivateDirectory
        userDataDirectory = $browserProfileDirectory
    }
    actions = [ordered]@{
        enabled = [bool]$EnableActions
        workspaceIds = @($ActionWorkspaceIds)
        allowWrite = [bool]$AllowActionWrites
        allowShell = [bool]$AllowActionShell
    }
    tunnel = [ordered]@{
        enabled = $true
        provider = if ($DockerTunnel) { 'docker-ngrok' } else { 'native-ngrok' }
        executable = $resolvedTunnelExecutable
        url = $normalizedPublicBaseUrl
        args = @('http', [string]$ProxyPort, "--url=$normalizedPublicBaseUrl")
    }
}

if ($AuthMode -eq 'owner') {
    $config.ownerAuth = [ordered]@{
        token = $ownerToken
        scopes = @('workspaces:read')
        accessTokenTtlSeconds = 3600
        refreshTokenTtlSeconds = 2592000
    }
}
if ($EnableActions) {
    $config.actions.tokenSha = Get-Sha256Hex -Value $actionsToken
}

New-Item -ItemType Directory -Path (Split-Path -Parent $resolvedOutputPath) -Force | Out-Null
New-Item -ItemType Directory -Path $browserPrivateDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $browserProfileDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $browserRuntimeDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $workspaceDataDirectory -Force | Out-Null

if ($AuthMode -eq 'owner') {
    Set-Utf8NoBomAtomic -Path $ownerTokenPath -Value ($ownerToken + [Environment]::NewLine)
}
if ($EnableActions) {
    Set-Utf8NoBomAtomic -Path $actionsTokenPath -Value ($actionsToken + [Environment]::NewLine)
}
Set-Utf8NoBomAtomic -Path $resolvedOutputPath -Value (($config | ConvertTo-Json -Depth 8) + [Environment]::NewLine)

if ($AuthMode -ne 'owner') {
    Remove-Item -LiteralPath $ownerTokenPath -Force -ErrorAction SilentlyContinue
}
if (-not $EnableActions) {
    Remove-Item -LiteralPath $actionsTokenPath -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
    ConfigPath = $resolvedOutputPath
    OwnerTokenPath = if ($AuthMode -eq 'owner') { $ownerTokenPath } else { $null }
    ActionsTokenPath = if ($EnableActions) { $actionsTokenPath } else { $null }
    McpPath = $McpPath
    PublicBaseUrl = $normalizedPublicBaseUrl
} | ConvertTo-Json -Compress
