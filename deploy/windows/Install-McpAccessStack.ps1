[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$PublicBaseUrl,

    [Parameter(Mandatory = $true)]
    [Security.SecureString]$NgrokAuthtoken,

    [Parameter(Mandatory = $true)]
    [string]$PolicyPath,

    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$publicCommonSignature = Get-AuthenticodeSignature -LiteralPath $publicCommonPath
if (
    $publicCommonSignature.Status -ne 'Valid' -and
    -not ($AllowUnsignedDevelopment -and $publicCommonSignature.Status -eq 'NotSigned')
) {
    throw "Invalid Authenticode signature for $publicCommonPath. Status=$($publicCommonSignature.Status)"
}
. $publicCommonPath

if (-not $Execute) {
    throw 'Installation is intentionally gated. Re-run with -Execute.'
}

Assert-McpPublicWindowsX64
Assert-McpPublicAdministrator
foreach ($command in @('docker', 'wsl.exe')) {
    Assert-McpPublicCommand -Name $command
}

$root = Get-McpPublicProjectRoot
$policy = [System.IO.Path]::GetFullPath($PolicyPath)
if (-not (Test-Path -LiteralPath $policy -PathType Leaf)) {
    throw "Workspace policy was not found: $policy"
}

Assert-McpPublicSignature `
    -Path $PSCommandPath `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature `
    -Path (Join-Path $PSScriptRoot 'Update-McpAccessStack.ps1') `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
$distribution = Assert-McpPublicDistribution `
    -Root $root `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
$releaseId = [string]$distribution.releaseId
$releaseRoot = Join-Path $root "releases\$releaseId"
$releaseManifest = Assert-McpPublicReleaseFiles -ReleaseRoot $releaseRoot
if ([string]$releaseManifest.releaseId -ne $releaseId) {
    throw 'Distribution and immutable release IDs do not match.'
}
$releaseAttestation = Assert-McpPublicReleaseAttestation `
    -ReleaseRoot $releaseRoot `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
if ([string]$releaseAttestation.releaseId -ne $releaseId) {
    throw 'Signed release attestation does not match the distribution release ID.'
}
. (Join-Path $root 'deploy\docker\scripts\Common.ps1')
$nodeState = Initialize-McpReleaseNodeRuntimeState `
    -ReleaseRoot $releaseRoot `
    -ProjectRoot $root `
    -InstallMissing
$managedNode = Assert-McpManagedNodeRecord `
    -Record $nodeState.knownGood `
    -ProjectRoot $root
Write-McpReleasePointer -Name 'candidate' -Root $root -Value ([ordered]@{
    version = 1
    releaseId = $releaseId
    path = $releaseRoot
    commit = [string]$releaseManifest.commit
    builtAt = [string]$releaseManifest.builtAt
})

& wsl.exe --status *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'WSL2 is unavailable. Install or repair WSL2 before continuing.'
}
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Desktop is not running or its Linux engine is unavailable.'
}

Import-McpPublicDockerImages -Manifest $distribution -ReleaseId $releaseId

$playwrightCli = Join-Path $releaseRoot 'node_modules\playwright\cli.js'
if (-not (Test-Path -LiteralPath $playwrightCli -PathType Leaf)) {
    throw "The fixed Playwright runtime is missing from the release: $playwrightCli"
}
& $managedNode $playwrightCli install chromium
if ($LASTEXITCODE -ne 0) {
    throw 'Managed Chromium installation failed.'
}

$validationInitializer = Join-Path $root 'operations\validation\Initialize-ValidationTools.ps1'
& $validationInitializer
if ($LASTEXITCODE -ne 0) {
    throw 'Validation tool installation failed.'
}

$plainNgrokToken = ConvertFrom-McpPublicSecureString -Value $NgrokAuthtoken
try {
    $productionInitializer = Join-Path $root 'operations\runtime\Initialize-GptOnlyProduction.ps1'
    & $productionInitializer `
        -PublicBaseUrl $PublicBaseUrl `
        -PolicyPath $policy `
        -AuthMode owner `
        -DockerTunnel
    if ($LASTEXITCODE -ne 0) {
        throw 'Private production configuration failed.'
    }

    $dockerInitializer = Join-Path $root 'deploy\docker\scripts\Initialize-DockerProduction.ps1'
    & $dockerInitializer `
        -ImageTag $releaseId `
        -NgrokAuthtoken $plainNgrokToken
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker production configuration failed.'
    }
}
finally {
    $plainNgrokToken = $null
}

$taskInstaller = Join-Path $root 'deploy\docker\scripts\Install-McpHostTasks.ps1'
& $taskInstaller `
    -Environment production `
    -ReleaseRoot $releaseRoot `
    -Activate
if ($LASTEXITCODE -ne 0) {
    throw 'Windows host task installation failed.'
}

$promotionTaskInstaller = Join-Path $root 'deploy\docker\scripts\Install-McpProductionPromotionTask.ps1'
& $promotionTaskInstaller -Execute -Force
if ($LASTEXITCODE -ne 0) {
    throw 'Production promotion task installation failed.'
}

$composeEnv = Join-Path $root '.runtime-private\docker\production\compose.env'
$composeFile = Join-Path $root 'deploy\docker\compose.production.yml'
& docker compose `
    --env-file $composeEnv `
    -f $composeFile `
    up -d --no-build
if ($LASTEXITCODE -ne 0) {
    throw 'Docker production startup failed.'
}

$agentTask = 'MCP Access Stack Docker production agent'
$browserTask = 'MCP Access Stack Docker production browser-worker'
Start-ScheduledTask -TaskName $agentTask
Start-ScheduledTask -TaskName $browserTask

Wait-McpHttpEndpoint -Uri 'http://127.0.0.1:3310/health/ready' -TimeoutSeconds 180 | Out-Null
Wait-McpHttpEndpoint -Uri 'http://127.0.0.1:3300/health/live' -TimeoutSeconds 180 | Out-Null
Wait-McpHttpEndpoint -Uri 'http://127.0.0.1:3350/health/live' -TimeoutSeconds 180 | Out-Null

$activation = Join-Path $root 'deploy\docker\scripts\Activate-McpCandidateRelease.ps1'
& $activation -Execute -ExpectedReleaseId $releaseId
if ($LASTEXITCODE -ne 0) {
    throw 'Candidate activation failed after health checks.'
}

$privateConfig = Read-McpPublicJson -Path (Join-Path $root '.runtime-private\gpt-only-production.json')
[pscustomobject]@{
    installed = $true
    releaseId = $releaseId
    connectorUrl = ([string]$privateConfig.publicBaseUrl + [string]$privateConfig.mcpPath)
    ownerTokenPath = (Join-Path $root '.runtime-private\owner-token.txt')
    browserEngine = 'playwright-direct'
    chromiumRevision = [string]$releaseManifest.chromium.revision
} | ConvertTo-Json -Compress
