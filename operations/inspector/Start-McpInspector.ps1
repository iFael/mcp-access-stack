[CmdletBinding()]
param(
    [switch]$ListTools,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$configPath = Join-Path $projectRoot '.runtime-private\gpt-only-production.json'
$inspectorCli = Join-Path $projectRoot 'node_modules\@modelcontextprotocol\inspector\cli\build\cli.js'
$inspectorCommand = Join-Path $projectRoot 'node_modules\@modelcontextprotocol\inspector\cli\build\index.js'

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'Private production configuration was not found.'
}
if (-not (Test-Path -LiteralPath $inspectorCli -PathType Leaf)) {
    throw 'MCP Inspector is not installed. Run npm install before using this script.'
}

$config = ([System.IO.File]::ReadAllText($configPath).TrimStart([char]0xFEFF)) | ConvertFrom-Json
if ($null -eq $config.gpt -or [string]::IsNullOrWhiteSpace([string]$config.gpt.token)) {
    throw 'Private production configuration does not contain the MCP bearer token.'
}
if ($null -eq $config.ports -or $null -eq $config.ports.gateway) {
    throw 'Private production configuration does not contain the gateway port.'
}
if ([string]::IsNullOrWhiteSpace([string]$config.mcpPath)) {
    throw 'Private production configuration does not contain mcpPath.'
}

$gatewayPort = [int]$config.ports.gateway
$mcpPath = '/' + ([string]$config.mcpPath).Trim('/')
$serverUrl = "http://127.0.0.1:$gatewayPort$mcpPath"
$authorizationHeader = "Authorization: Bearer $([string]$config.gpt.token)"

if ($ListTools) {
    & node $inspectorCommand `
        $serverUrl `
        --transport http `
        --header $authorizationHeader `
        --method tools/list
    exit $LASTEXITCODE
}

if (Get-Command Set-Clipboard -ErrorAction SilentlyContinue) {
    [string]$config.gpt.token | Set-Clipboard
    Write-Output 'The MCP bearer token was copied to the clipboard for the Inspector connection form.'
}
else {
    Write-Warning 'Set-Clipboard is unavailable. Retrieve the token only from the private production configuration.'
}

$previousAutoOpen = $env:MCP_AUTO_OPEN_ENABLED
try {
    $env:MCP_AUTO_OPEN_ENABLED = if ($NoBrowser) { 'false' } else { 'true' }
    Write-Output "Starting MCP Inspector for the local endpoint: $serverUrl"
    Write-Output 'Use Streamable HTTP and paste the bearer token when requested. The token was not printed.'
    & node $inspectorCli --transport http --server-url $serverUrl
    exit $LASTEXITCODE
}
finally {
    $env:MCP_AUTO_OPEN_ENABLED = $previousAutoOpen
}
