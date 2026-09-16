[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$EdgeBaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$ConnectorTokenFile,

    [Parameter(Mandatory = $true)]
    [string]$OwnerTokenFile,

    [Parameter(Mandatory = $true)]
    [string]$PolicyPath,

    [string]$EdgeRuntimeRoot,
    [string]$AllowedOrigins = 'https://chatgpt.com,https://chat.openai.com',
    [string]$OwnerOAuthScopes = 'workspaces:read',

    [switch]$EnableBrowserWorker,
    [string]$BrowserWorkerTokenFile,
    [string]$BrowserPrivateDirectory,
    [string]$BrowserUserDataDirectory,
    [string]$BrowserSitePoliciesPath,
    [string]$BrowserRuntimeRoot,
    [ValidateRange(1, 65535)]
    [int]$BrowserPort = 3350,

    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
if (-not (Test-Path -LiteralPath $publicCommonPath -PathType Leaf)) {
    throw "Public distribution helper was not found: $publicCommonPath"
}
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

$distributionRoot = Get-McpPublicProjectRoot
$installation = [IO.Path]::GetFullPath($InstallationRoot)
$project = [IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $project -PathType Container)) {
    throw "Project root was not found: $project"
}
foreach ($requiredFile in @(
    [pscustomobject]@{ Name = 'Connector token'; Path = $ConnectorTokenFile },
    [pscustomobject]@{ Name = 'Owner token'; Path = $OwnerTokenFile },
    [pscustomobject]@{ Name = 'Workspace policy'; Path = $PolicyPath }
)) {
    $resolved = [IO.Path]::GetFullPath([string]$requiredFile.Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "$($requiredFile.Name) file was not found: $resolved"
    }
}
if ($EnableBrowserWorker) {
    foreach ($entry in @(
        [pscustomobject]@{ Name = 'Browser Worker token'; Path = $BrowserWorkerTokenFile; Kind = 'Leaf' },
        [pscustomobject]@{ Name = 'Browser private directory'; Path = $BrowserPrivateDirectory; Kind = 'Container' },
        [pscustomobject]@{ Name = 'Browser user-data directory'; Path = $BrowserUserDataDirectory; Kind = 'Container' },
        [pscustomobject]@{ Name = 'Browser site policies'; Path = $BrowserSitePoliciesPath; Kind = 'Leaf' }
    )) {
        if ([string]::IsNullOrWhiteSpace([string]$entry.Path)) {
            throw "EnableBrowserWorker requires $($entry.Name)."
        }
        $resolved = [IO.Path]::GetFullPath([string]$entry.Path)
        if (-not (Test-Path -LiteralPath $resolved -PathType ([string]$entry.Kind))) {
            throw "$($entry.Name) was not found: $resolved"
        }
    }
}

Assert-McpPublicSignature -Path $PSCommandPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature `
    -Path (Join-Path $PSScriptRoot 'Update-McpAccessStack.ps1') `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
$distribution = Assert-McpPublicDistribution `
    -Root $distributionRoot `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
if ([int]$distribution.schemaVersion -ne 2) {
    throw 'Current installation requires distribution manifest v2.'
}
$releaseId = [string]$distribution.releaseId
$sourceRelease = Resolve-McpPublicChildPath `
    -Root $distributionRoot `
    -RelativePath ("releases/{0}" -f $releaseId)
$releaseManifest = Assert-McpPublicReleaseFiles -ReleaseRoot $sourceRelease
$releaseAttestation = Assert-McpPublicReleaseAttestation `
    -ReleaseRoot $sourceRelease `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
if (
    [int]$releaseAttestation.schemaVersion -ne 2 -or
    [string]$releaseManifest.releaseId -ne $releaseId -or
    [string]$releaseAttestation.releaseId -ne $releaseId
) {
    throw 'Current installation requires matching release and attestation v2 identities.'
}

$stageScript = Join-Path $PSScriptRoot 'Stage-McpWindowsExecutionNodeCandidate.ps1'
$handoverScript = Join-Path $PSScriptRoot 'Start-McpAccessStackCutover.ps1'
foreach ($scriptPath in @($stageScript, $handoverScript)) {
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "Required Windows runtime script was not found: $scriptPath"
    }
    Assert-McpPublicSignature -Path $scriptPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
}

$stageResult = & $stageScript `
    -DistributionRoot $distributionRoot `
    -InstallationRoot $installation `
    -ExpectedReleaseId $releaseId `
    -Execute `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
if ([string]$stageResult.status -ne 'ready') {
    throw 'Execution-node candidate staging did not reach ready.'
}

$edgeRuntime = if ([string]::IsNullOrWhiteSpace($EdgeRuntimeRoot)) {
    Join-Path $installation 'runtime\edge-connector'
}
else {
    [IO.Path]::GetFullPath($EdgeRuntimeRoot)
}
New-Item -ItemType Directory -Force -Path $edgeRuntime | Out-Null

$browserRuntime = $null
if ($EnableBrowserWorker) {
    $browserRuntime = if ([string]::IsNullOrWhiteSpace($BrowserRuntimeRoot)) {
        Join-Path $installation 'runtime\browser-worker'
    }
    else {
        [IO.Path]::GetFullPath($BrowserRuntimeRoot)
    }
    New-Item -ItemType Directory -Force -Path $browserRuntime | Out-Null
}

$handoverParameters = @{
    InstallationRoot = $installation
    ProjectRoot = $project
    ExpectedReleaseId = $releaseId
    EdgeRuntimeRoot = $edgeRuntime
    EdgeBaseUrl = $EdgeBaseUrl
    ConnectorTokenFile = [IO.Path]::GetFullPath($ConnectorTokenFile)
    OwnerTokenFile = [IO.Path]::GetFullPath($OwnerTokenFile)
    PolicyPath = [IO.Path]::GetFullPath($PolicyPath)
    AllowedOrigins = $AllowedOrigins
    OwnerOAuthScopes = $OwnerOAuthScopes
    EnableBrowserWorker = [bool]$EnableBrowserWorker
    BrowserPort = $BrowserPort
    Execute = $true
    AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
}
if ($EnableBrowserWorker) {
    $handoverParameters.BrowserWorkerTokenFile = [IO.Path]::GetFullPath($BrowserWorkerTokenFile)
    $handoverParameters.BrowserPrivateDirectory = [IO.Path]::GetFullPath($BrowserPrivateDirectory)
    $handoverParameters.BrowserUserDataDirectory = [IO.Path]::GetFullPath($BrowserUserDataDirectory)
    $handoverParameters.BrowserSitePoliciesPath = [IO.Path]::GetFullPath($BrowserSitePoliciesPath)
    $handoverParameters.BrowserRuntimeRoot = $browserRuntime
}
$handover = & $handoverScript @handoverParameters | ConvertFrom-Json
if ([string]$handover.status -ne 'started' -or $handover.detached -ne $true -or
    [string]$handover.releaseId -ne $releaseId) {
    throw 'Access Stack cutover handover returned unexpected evidence.'
}

[pscustomobject]@{
    status = 'handover-started'
    installed = $false
    handoverStarted = $true
    releaseId = $releaseId
    ownershipMode = 'edge-only'
    candidatePrepared = $true
    requestId = [string]$handover.requestId
    brokerTask = [string]$handover.brokerTaskName
    resultPath = [string]$handover.resultPath
    installationRoot = $installation
    projectRoot = $project
} | ConvertTo-Json -Compress
