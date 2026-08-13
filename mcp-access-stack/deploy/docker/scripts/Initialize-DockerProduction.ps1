[CmdletBinding()]
param(
    [string]$ImageTag = 'production',
    [string]$NgrokAuthtoken,
    [switch]$Force
)

. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Get-McpProjectRoot
$gitleaksRelativePath = '.runtime-tools/gitleaks/8.30.1/gitleaks.exe'
$gitleaksPath = Join-Path $root $gitleaksRelativePath
if (-not (Test-Path -LiteralPath $gitleaksPath -PathType Leaf)) {
    throw 'Gitleaks 8.30.1 is unavailable. Run npm run validation:tools:init before initializing Docker host tasks.'
}
$sourceConfigPath = Join-Path $root '.runtime-private\gpt-only-production.json'
$privateDirectory = Join-Path $root '.runtime-private\docker\production'
$gatewayEnvPath = Join-Path $privateDirectory 'gateway.env'
$agentConfigPath = Join-Path $privateDirectory 'agent.json'
$browserConfigPath = Join-Path $privateDirectory 'browser.json'
$composeEnvPath = Join-Path $privateDirectory 'compose.env'
$ngrokEnvPath = Join-Path $privateDirectory 'ngrok.env'

$config = Read-McpJsonFile -Path $sourceConfigPath

if (-not $Force -and ((Test-Path -LiteralPath $gatewayEnvPath) -or (Test-Path -LiteralPath $agentConfigPath))) {
    throw "Docker production configuration already exists in $privateDirectory. Use -Force only after creating a backup and intentionally rotating/rebuilding it."
}

$requiredValues = @{
    'publicBaseUrl' = $config.publicBaseUrl
    'mcpPath' = $config.mcpPath
    'ports.proxy' = $config.ports.proxy
    'ports.gateway' = $config.ports.gateway
    'ports.browser' = $config.ports.browser
    'gpt.root' = $config.gpt.root
    'gpt.policy' = $config.gpt.policy
    'gpt.data' = $config.gpt.data
    'gpt.token' = $config.gpt.token
    'gpt.tokenSha' = $config.gpt.tokenSha
    'browser.token' = $config.browser.token
    'tunnel.url' = $config.tunnel.url
}
foreach ($entry in $requiredValues.GetEnumerator()) {
    if ($null -eq $entry.Value -or [string]::IsNullOrWhiteSpace([string]$entry.Value)) {
        throw "Production configuration is missing $($entry.Key)."
    }
}

$policySnapshot = Install-McpEnvironmentPolicySnapshot `
    -Environment 'production' `
    -SourcePolicyPath ([string]$config.gpt.policy)

$authMode = if ($config.authMode) { [string]$config.authMode } else { 'none' }
if ($authMode -notin @('none', 'owner')) {
    throw "Automatic initialization supports AUTH_MODE=owner or none. Configure external OAuth secrets manually before using AUTH_MODE=$authMode."
}
$ownerAuth = if ($authMode -eq 'owner') { $config.ownerAuth } else { $null }
if ($authMode -eq 'owner') {
    if (
        $null -eq $ownerAuth -or
        [string]::IsNullOrWhiteSpace([string]$ownerAuth.token) -or
        ([string]$ownerAuth.token).Length -lt 16
    ) {
        throw 'Production owner authentication requires ownerAuth.token with at least 16 characters.'
    }
}

$actionsEnabled = $null -ne $config.actions -and $config.actions.enabled -eq $true
$workspaceIds = if ($null -ne $config.actions) {
    @($config.actions.workspaceIds | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
} else { @() }
if ($actionsEnabled) {
    if ($workspaceIds.Count -eq 0) {
        throw 'Production GPT Actions require at least one explicitly configured workspace ID.'
    }
    if ($workspaceIds | Where-Object { $_ -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }) {
        throw 'Production GPT Actions contains an invalid workspace ID.'
    }
    if ([string]$config.actions.tokenSha -notmatch '^[a-fA-F0-9]{64}$') {
        throw 'Production GPT Actions require actions.tokenSha as a SHA-256 hex digest.'
    }
}
$workspaceIdsCsv = $workspaceIds -join ','

New-Item -ItemType Directory -Force -Path $privateDirectory | Out-Null

$gatewayLines = @(
    'NODE_ENV=production',
    "PORT=$([int]$config.ports.gateway)",
    "PUBLIC_BASE_URL=$([string]$config.publicBaseUrl)",
    "AUTH_MODE=$authMode",
    "MCP_PATH=$([string]$config.mcpPath)",
    'TRUST_PROXY=1',
    "ALLOWED_ORIGINS=$([string]$config.allowedOrigins)",
    "AGENT_ID=$([string]$config.gpt.agentId)",
    "AGENT_TOKEN_SHA256=$([string]$config.gpt.tokenSha)",
    'AGENT_REQUEST_TIMEOUT_MS=60000',
    'AGENT_HEARTBEAT_MS=30000',
    'AGENT_MAX_CONCURRENCY=4',
    'AGENT_MAX_PAYLOAD_BYTES=536870912',
    'BROWSER_WORKER_ENABLED=true',
    'BROWSER_WORKER_ALLOW_DOCKER_HOST=true',
    "BROWSER_WORKER_URL=http://host.docker.internal:$([int]$config.ports.browser)",
    "BROWSER_WORKER_TOKEN=$([string]$config.browser.token)",
    "BROWSER_WORKER_TIMEOUT_MS=$([int]$config.browser.timeoutMs)",
    "BROWSER_WORKER_MAX_PAYLOAD_BYTES=$([int]$config.browser.maxPayloadBytes)",
    "GPT_ACTIONS_ENABLED=$($actionsEnabled.ToString().ToLowerInvariant())",
    "GPT_ACTIONS_WORKSPACE_IDS=$workspaceIdsCsv",
    "GPT_ACTIONS_ALLOW_WRITE=$((($actionsEnabled -and $config.actions.allowWrite -eq $true)).ToString().ToLowerInvariant())",
    "GPT_ACTIONS_ALLOW_SHELL=$((($actionsEnabled -and $config.actions.allowShell -eq $true)).ToString().ToLowerInvariant())",
    'LOG_LEVEL=info'
)
if ($actionsEnabled) {
    $gatewayLines += "GPT_ACTIONS_TOKEN_SHA256=$([string]$config.actions.tokenSha)"
}
if ($authMode -eq 'owner') {
    $ownerScopes = @($ownerAuth.scopes | ForEach-Object { [string]$_ }) -join ','
    if ([string]::IsNullOrWhiteSpace($ownerScopes)) {
        throw 'Production owner authentication requires at least one ownerAuth scope.'
    }
    $gatewayLines += @(
        "OWNER_TOKEN=$([string]$ownerAuth.token)",
        "OWNER_OAUTH_SCOPES=$ownerScopes",
        "OWNER_ACCESS_TOKEN_TTL_SECONDS=$([int]$ownerAuth.accessTokenTtlSeconds)",
        "OWNER_REFRESH_TOKEN_TTL_SECONDS=$([int]$ownerAuth.refreshTokenTtlSeconds)"
    )
}
Write-McpUtf8NoBom -Path $gatewayEnvPath -Content (($gatewayLines -join [Environment]::NewLine) + [Environment]::NewLine)

$agentConfig = [ordered]@{
    version = 1
    agentId = [string]$config.gpt.agentId
    gatewayUrl = "ws://127.0.0.1:$([int]$config.ports.gateway)/agent"
    policyPath = [string]$policySnapshot.policyPath
    policyEnvironment = [string]$policySnapshot.environment
    policySha256 = [string]$policySnapshot.policySha256
    policyManifestPath = [string]$policySnapshot.manifestPath
    dataDirectory = [string]$config.gpt.data
    token = [string]$config.gpt.token
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

$maxOwnedTabsProperty = $config.browser.PSObject.Properties['maxOwnedTabs']
$maxConcurrentTabsProperty = $config.browser.PSObject.Properties['maxConcurrentTabs']
$idempotencyTtlMsProperty = $config.browser.PSObject.Properties['idempotencyTtlMs']
$idempotencyMaxEntriesProperty = $config.browser.PSObject.Properties['idempotencyMaxEntries']
$browserChannelProperty = $config.browser.PSObject.Properties['browserChannel']
$browserConfig = [ordered]@{
    version = 2
    engine = 'playwright-direct'
    port = [int]$config.ports.browser
    token = [string]$config.browser.token
    mode = if ($config.browser.mode) { [string]$config.browser.mode } else { 'diagnostic' }
    profileMode = 'persistent'
    browserChannel = if ($null -ne $browserChannelProperty -and $browserChannelProperty.Value) { [string]$browserChannelProperty.Value } else { 'chromium' }
    userDataDirectory = if ($config.browser.userDataDirectory) { [string]$config.browser.userDataDirectory } else { (Join-Path ([string]$config.browser.privateDirectory) 'chrome-profile') }
    runtimeDirectory = [string]$config.browser.runtimeDirectory
    privateDirectory = [string]$config.browser.privateDirectory
    maxPayloadBytes = if ($config.browser.maxPayloadBytes) { [int]$config.browser.maxPayloadBytes } else { 4194304 }
    maxOwnedTabs = if ($null -ne $maxOwnedTabsProperty -and $maxOwnedTabsProperty.Value) { [int]$maxOwnedTabsProperty.Value } else { 8 }
    maxConcurrentTabs = if ($null -ne $maxConcurrentTabsProperty -and $maxConcurrentTabsProperty.Value) { [int]$maxConcurrentTabsProperty.Value } else { 4 }
    idempotencyTtlMs = if ($null -ne $idempotencyTtlMsProperty -and $idempotencyTtlMsProperty.Value) { [int]$idempotencyTtlMsProperty.Value } else { 300000 }
    idempotencyMaxEntries = if ($null -ne $idempotencyMaxEntriesProperty -and $idempotencyMaxEntriesProperty.Value) { [int]$idempotencyMaxEntriesProperty.Value } else { 4096 }
    connectTimeoutMs = if ($config.browser.connectTimeoutMs) { [int]$config.browser.connectTimeoutMs } else { 90000 }
    operationTimeoutMs = if ($config.browser.operationTimeoutMs) { [int]$config.browser.operationTimeoutMs } else { 120000 }
    actionTimeoutMs = if ($config.browser.actionTimeoutMs) { [int]$config.browser.actionTimeoutMs } else { 10000 }
    navigationTimeoutMs = if ($config.browser.navigationTimeoutMs) { [int]$config.browser.navigationTimeoutMs } else { 90000 }
    outputMaxBytes = if ($config.browser.outputMaxBytes) { [int]$config.browser.outputMaxBytes } else { 268435456 }
    diagnosticTimeoutMs = if ($config.browser.diagnosticTimeoutMs) { [int]$config.browser.diagnosticTimeoutMs } else { 120000 }
}
Write-McpJsonFile -Path $browserConfigPath -Value $browserConfig

$mcpPathAliasesProperty = $config.PSObject.Properties['mcpPathAliases']
$mcpPathAliases = if ($null -ne $mcpPathAliasesProperty -and $mcpPathAliasesProperty.Value) {
    @($mcpPathAliasesProperty.Value | ForEach-Object { [string]$_ }) -join ','
} else { '' }

$composeLines = @(
    "MCP_IMAGE_TAG=$ImageTag",
    "MCP_PRODUCTION_PATH=$([string]$config.mcpPath)",
    "MCP_PRODUCTION_PATH_ALIASES=$mcpPathAliases",
    'NGROK_IMAGE=ngrok/ngrok:3.30.0-alpine',
    "NGROK_PRODUCTION_URL=$([string]$config.tunnel.url)"
)
Write-McpUtf8NoBom -Path $composeEnvPath -Content (($composeLines -join [Environment]::NewLine) + [Environment]::NewLine)

if (-not $NgrokAuthtoken) {
    $NgrokAuthtoken = $env:NGROK_AUTHTOKEN
}
if ($NgrokAuthtoken) {
    Write-McpUtf8NoBom -Path $ngrokEnvPath -Content ("NGROK_AUTHTOKEN=$NgrokAuthtoken" + [Environment]::NewLine)
}
elseif (-not (Test-Path -LiteralPath $ngrokEnvPath -PathType Leaf)) {
    Write-McpUtf8NoBom -Path $ngrokEnvPath -Content ('NGROK_AUTHTOKEN=' + [Environment]::NewLine)
    Write-Warning "ngrok token was not migrated. Populate $ngrokEnvPath before starting production."
}

Write-Output "Docker production configuration prepared: $privateDirectory"
Write-Output "Image tag: $ImageTag"
Write-Output 'Production credentials were copied privately and were not printed.'
