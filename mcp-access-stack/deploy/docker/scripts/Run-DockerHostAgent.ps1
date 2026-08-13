[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('development', 'production')]
    [string]$Environment,

    [string]$ReleaseRoot,
    [string]$ProjectRoot,
    [string]$ConfigurationPath
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not $ProjectRoot) {
    $ProjectRoot = Get-McpProjectRoot
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not $ReleaseRoot) {
    $ReleaseRoot = $ProjectRoot
}
$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)

if (-not $ConfigurationPath) {
    $ConfigurationPath = Join-Path $ProjectRoot ".runtime-private\docker\$Environment\agent.json"
}
$configuration = Read-McpJsonFile -Path $ConfigurationPath
$agentCliPath = Join-Path $ReleaseRoot 'services\workspace-agent\dist\cli.js'

if (-not (Test-Path -LiteralPath $agentCliPath -PathType Leaf)) {
    throw "Built local-agent CLI not found: $agentCliPath"
}

$previous = @{
    VS_CODE_GPT_GATEWAY_URL = $env:VS_CODE_GPT_GATEWAY_URL
    VS_CODE_GPT_AGENT_ID = $env:VS_CODE_GPT_AGENT_ID
    VS_CODE_GPT_AGENT_TOKEN = $env:VS_CODE_GPT_AGENT_TOKEN
    VS_CODE_GPT_POLICY_PATH = $env:VS_CODE_GPT_POLICY_PATH
    VS_CODE_GPT_DATA_DIR = $env:VS_CODE_GPT_DATA_DIR
    VS_CODE_GPT_MAX_PAYLOAD_BYTES = $env:VS_CODE_GPT_MAX_PAYLOAD_BYTES
    VS_CODE_GPT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS = $env:VS_CODE_GPT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS
    VS_CODE_GPT_QUALIFIED_EXECUTION_ENABLED = $env:VS_CODE_GPT_QUALIFIED_EXECUTION_ENABLED
    VS_CODE_GPT_SAFE_AUTOCORRECTION_ENABLED = $env:VS_CODE_GPT_SAFE_AUTOCORRECTION_ENABLED
    VS_CODE_GPT_QUALIFIED_SHADOW_MODE_ENABLED = $env:VS_CODE_GPT_QUALIFIED_SHADOW_MODE_ENABLED
    VS_CODE_GPT_COMMAND_PROVIDER_ENABLED = $env:VS_CODE_GPT_COMMAND_PROVIDER_ENABLED
    VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST = $env:VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST
    VS_CODE_GPT_COMMAND_PROVIDER_MODEL = $env:VS_CODE_GPT_COMMAND_PROVIDER_MODEL
    VS_CODE_GPT_COMMAND_PROVIDER_BROKER_PATH = $env:VS_CODE_GPT_COMMAND_PROVIDER_BROKER_PATH
    VS_CODE_GPT_COMMAND_PROVIDER_TIMEOUT_MS = $env:VS_CODE_GPT_COMMAND_PROVIDER_TIMEOUT_MS
}

try {
    $env:VS_CODE_GPT_GATEWAY_URL = [string]$configuration.gatewayUrl
    $env:VS_CODE_GPT_AGENT_ID = [string]$configuration.agentId
    $env:VS_CODE_GPT_AGENT_TOKEN = [string]$configuration.token
    $env:VS_CODE_GPT_POLICY_PATH = [string]$configuration.policyPath
    $env:VS_CODE_GPT_DATA_DIR = [string]$configuration.dataDirectory
    $env:VS_CODE_GPT_MAX_PAYLOAD_BYTES = [string]$configuration.maxPayloadBytes
    $maxConcurrentSynchronousShells = if ($configuration.PSObject.Properties['maxConcurrentSynchronousShells']) { [int]$configuration.maxConcurrentSynchronousShells } else { 4 }
    $env:VS_CODE_GPT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS = [string]$maxConcurrentSynchronousShells
    $qualifiedCommand = $configuration.qualifiedCommand
    $providerTimeoutMs = if ($qualifiedCommand.providerTimeoutMs) { [int]$qualifiedCommand.providerTimeoutMs } else { 20000 }
    $env:VS_CODE_GPT_QUALIFIED_EXECUTION_ENABLED = [string]($qualifiedCommand.qualifiedExecution -eq $true)
    $env:VS_CODE_GPT_SAFE_AUTOCORRECTION_ENABLED = [string]($qualifiedCommand.safeAutoCorrection -eq $true)
    $env:VS_CODE_GPT_QUALIFIED_SHADOW_MODE_ENABLED = [string]($qualifiedCommand.shadowMode -eq $true)
    $env:VS_CODE_GPT_COMMAND_PROVIDER_ENABLED = [string]($qualifiedCommand.providerEnabled -eq $true)
    $env:VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST = [string](($qualifiedCommand.workspaceAllowlist | ForEach-Object { [string]$_ }) -join ',')
    $env:VS_CODE_GPT_COMMAND_PROVIDER_MODEL = [string]$qualifiedCommand.providerModel
    $env:VS_CODE_GPT_COMMAND_PROVIDER_BROKER_PATH = [string]$qualifiedCommand.providerBrokerPath
    $env:VS_CODE_GPT_COMMAND_PROVIDER_TIMEOUT_MS = [string]$providerTimeoutMs

    Push-Location $ReleaseRoot
    try {
        & node $agentCliPath connect --policy ([string]$configuration.policyPath)
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($entry in $previous.GetEnumerator()) {
        if ($null -eq $entry.Value) {
            Remove-Item -Path "Env:$($entry.Key)" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value
        }
    }
}
