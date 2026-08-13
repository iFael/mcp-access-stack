[CmdletBinding()]
param(
    [string]$PolicyPath,
    [string]$McpPath = '/mcp-development',
    [int]$ProxyPort = 4300,
    [int]$GatewayPort = 4310,
    [switch]$EnableBrowserWorker,
    [switch]$Force
)

. (Join-Path $PSScriptRoot 'Common.ps1')

Assert-McpCommand -Name 'node'
Assert-McpCommand -Name 'docker'

$root = Get-McpProjectRoot
$gitleaksRelativePath = '.runtime-tools/gitleaks/8.30.1/gitleaks.exe'
$gitleaksPath = Join-Path $root $gitleaksRelativePath
if (-not (Test-Path -LiteralPath $gitleaksPath -PathType Leaf)) {
    throw 'Gitleaks 8.30.1 is unavailable. Run npm run validation:tools:init before initializing Docker host tasks.'
}
$privateDirectory = Join-Path $root '.runtime-private\docker\development'
$gatewayEnvPath = Join-Path $privateDirectory 'gateway.env'
$agentConfigPath = Join-Path $privateDirectory 'agent.json'
$composeEnvPath = Join-Path $privateDirectory 'compose.env'
$ngrokEnvPath = Join-Path $privateDirectory 'ngrok.env'
$localApplicationData = [Environment]::GetFolderPath('LocalApplicationData')
if ([string]::IsNullOrWhiteSpace($localApplicationData)) {
    throw 'Unable to resolve the local application data directory for development environment audit storage.'
}
$agentDataDirectory = Join-Path (Get-McpEnvironmentPolicyDirectory -Environment 'development' -LocalApplicationDataRoot $localApplicationData) 'data'
$productionConfigPath = Join-Path $root '.runtime-private\gpt-only-production.json'
$productionConfig = $null

if (Test-Path -LiteralPath $productionConfigPath -PathType Leaf) {
    $productionConfig = Read-McpJsonFile -Path $productionConfigPath
}

if (-not $PolicyPath) {
    if ($null -eq $productionConfig -or -not $productionConfig.gpt.policy) {
        throw 'PolicyPath was not provided and the production configuration does not expose gpt.policy.'
    }
    $PolicyPath = [string]$productionConfig.gpt.policy
}

$PolicyPath = [System.IO.Path]::GetFullPath($PolicyPath)
if (-not (Test-Path -LiteralPath $PolicyPath -PathType Leaf)) {
    throw "Workspace policy not found: $PolicyPath"
}

if (-not $McpPath.StartsWith('/') -or $McpPath.Length -lt 2) {
    throw 'McpPath must be an absolute non-root path.'
}

foreach ($port in @($ProxyPort, $GatewayPort)) {
    if ($port -lt 1 -or $port -gt 65535) {
        throw "Invalid TCP port: $port"
    }
}

if (-not $Force -and ((Test-Path -LiteralPath $gatewayEnvPath) -or (Test-Path -LiteralPath $agentConfigPath))) {
    throw "Development environment private configuration already exists in $privateDirectory. Use -Force only when rotating the development environment credentials intentionally."
}

$policySnapshot = Install-McpEnvironmentPolicySnapshot `
    -Environment 'development' `
    -SourcePolicyPath $PolicyPath `
    -LocalApplicationDataRoot $localApplicationData
$PolicyPath = [string]$policySnapshot.policyPath

New-Item -ItemType Directory -Force -Path $privateDirectory, $agentDataDirectory | Out-Null

$tokenBytes = [byte[]]::new(48)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
$agentToken = [Convert]::ToBase64String($tokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$hashBytes = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($agentToken))
$agentTokenSha256 = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
$agentId = 'gpt-only-docker-development-agent'

$browserEnabled = $false
$browserHostAllowed = $false
$browserUrl = 'http://host.docker.internal:4350'
$browserToken = $null
if ($EnableBrowserWorker) {
    if ($null -eq $productionConfig -or -not $productionConfig.browser.token -or -not $productionConfig.ports.browser) {
        throw 'The production configuration does not contain the Browser Worker token and port required for development environment bridging.'
    }
    $browserEnabled = $true
    $browserHostAllowed = $true
    $browserUrl = "http://host.docker.internal:$([int]$productionConfig.ports.browser)"
    $browserToken = [string]$productionConfig.browser.token
}

$gatewayLines = @(
    'NODE_ENV=development',
    "PORT=$GatewayPort",
    "PUBLIC_BASE_URL=http://127.0.0.1:$ProxyPort",
    'AUTH_MODE=none',
    "MCP_PATH=$McpPath",
    'TRUST_PROXY=0',
    'ALLOWED_ORIGINS=http://127.0.0.1',
    "AGENT_ID=$agentId",
    "AGENT_TOKEN_SHA256=$agentTokenSha256",
    'AGENT_REQUEST_TIMEOUT_MS=60000',
    'AGENT_HEARTBEAT_MS=30000',
    'AGENT_MAX_CONCURRENCY=4',
    'AGENT_MAX_PAYLOAD_BYTES=536870912',
    "BROWSER_WORKER_ENABLED=$($browserEnabled.ToString().ToLowerInvariant())",
    "BROWSER_WORKER_ALLOW_DOCKER_HOST=$($browserHostAllowed.ToString().ToLowerInvariant())",
    "BROWSER_WORKER_URL=$browserUrl",
    'BROWSER_WORKER_TIMEOUT_MS=120000',
    'BROWSER_WORKER_MAX_PAYLOAD_BYTES=4194304',
    'GPT_ACTIONS_ENABLED=false',
    'GPT_ACTIONS_WORKSPACE_IDS=workspace-a',
    'GPT_ACTIONS_ALLOW_WRITE=false',
    'GPT_ACTIONS_ALLOW_SHELL=false',
    'LOG_LEVEL=info'
)
if ($browserToken) {
    $gatewayLines += "BROWSER_WORKER_TOKEN=$browserToken"
}
Write-McpUtf8NoBom -Path $gatewayEnvPath -Content (($gatewayLines -join [Environment]::NewLine) + [Environment]::NewLine)

$agentConfig = [ordered]@{
    version = 1
    agentId = $agentId
    gatewayUrl = "ws://127.0.0.1:$GatewayPort/agent"
    policyPath = $PolicyPath
    policyEnvironment = [string]$policySnapshot.environment
    policySha256 = [string]$policySnapshot.policySha256
    policyManifestPath = [string]$policySnapshot.manifestPath
    dataDirectory = $agentDataDirectory
    token = $agentToken
    maxPayloadBytes = 536870912
    maxConcurrentSynchronousShells = 4
    gitleaksPath = $gitleaksRelativePath
    qualifiedCommand = [ordered]@{
        qualifiedExecution = $false
        safeAutoCorrection = $false
        shadowMode = $false
        providerEnabled = $false
        workspaceAllowlist = @()
        providerModel = $null
        providerBrokerPath = $null
        providerTimeoutMs = 20000
    }
}
Write-McpJsonFile -Path $agentConfigPath -Value $agentConfig

if ($Force -or -not (Test-Path -LiteralPath $composeEnvPath)) {
    $composeLines = @(
        'MCP_IMAGE_TAG=development',
        'NGROK_IMAGE=ngrok/ngrok:3.30.0-alpine',
        'NGROK_DEVELOPMENT_URL='
    )
    Write-McpUtf8NoBom -Path $composeEnvPath -Content (($composeLines -join [Environment]::NewLine) + [Environment]::NewLine)
}

if (-not (Test-Path -LiteralPath $ngrokEnvPath)) {
    Write-McpUtf8NoBom -Path $ngrokEnvPath -Content ('NGROK_AUTHTOKEN=' + [Environment]::NewLine)
}

$agentCliPath = Join-Path $root 'services\workspace-agent\dist\cli.js'
if (Test-Path -LiteralPath $agentCliPath -PathType Leaf) {
    Push-Location $root
    try {
        & node $agentCliPath validate-policy --policy $PolicyPath | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'Development environment policy validation failed.'
        }
    }
    finally {
        Pop-Location
    }
}

Write-Output "Development environment configuration initialized: $privateDirectory"
Write-Output "Gateway: http://127.0.0.1:$GatewayPort"
Write-Output "Proxy: http://127.0.0.1:$ProxyPort$McpPath"
Write-Output "Browser Worker bridge enabled: $browserEnabled"
Write-Output 'Development environment credentials were generated and were not printed.'
