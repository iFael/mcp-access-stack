[CmdletBinding()]
param(
    [ValidatePattern('^https://')]
    [string]$EdgeBaseUrl,

    [string]$InstallationRoot,
    [string]$StateRoot,
    [string]$DeviceName,
    [string]$TaskName = 'MCP V3 local companion',
    [string]$UpdateTaskName = 'MCP V3 local updater',
    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'iFael/mcp-access-stack',
    [ValidateRange(0, 23)]
    [int]$UpdateHour = 3,

    [switch]$DisableAutoUpdate,
    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'MCP V3 local installation is intentionally gated. Re-run with -Execute.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required MCP V3 local installer dependency is missing: $bootstrapPath"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $bootstrapPath
    if ($signature.Status -ne 'Valid' -and -not ($AllowUnsignedDevelopment -and $signature.Status -eq 'NotSigned')) {
        throw "Invalid Authenticode signature for $bootstrapPath. Status=$($signature.Status)"
    }
}

. $publicCommonPath
Assert-McpPublicSignature -Path $publicCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature -Path $executionCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
. $executionCommonPath
Assert-McpPublicWindowsX64

if ([string]::IsNullOrWhiteSpace([string]$env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is required for the per-user MCP V3 local installation.'
}

$defaultStateRoot = Join-Path $env:LOCALAPPDATA 'MCP V3'
$state = [IO.Path]::GetFullPath($(if ([string]::IsNullOrWhiteSpace($StateRoot)) { $defaultStateRoot } else { $StateRoot }))
$installation = [IO.Path]::GetFullPath($(if ([string]::IsNullOrWhiteSpace($InstallationRoot)) { Join-Path $state 'App' } else { $InstallationRoot }))

$distributionRoot = Get-McpPublicProjectRoot
$distribution = Assert-McpPublicDistribution -Root $distributionRoot -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
if ([int]$distribution.schemaVersion -ne 2) {
    throw 'MCP V3 local installer requires distribution manifest v2.'
}
$releaseId = [string]$distribution.releaseId
$edgeCandidate = if ([string]::IsNullOrWhiteSpace($EdgeBaseUrl)) {
    [string]$distribution.edgeBaseUrl
}
else {
    [string]$EdgeBaseUrl
}
if ([string]::IsNullOrWhiteSpace($edgeCandidate)) {
    throw 'MCP V3 distribution does not contain an Edge base URL.'
}
try {
    $edgeUri = [Uri]$edgeCandidate
}
catch {
    throw 'EdgeBaseUrl must be a valid HTTPS origin.'
}
if (-not $edgeUri.IsAbsoluteUri -or
    $edgeUri.Scheme -ne 'https' -or
    -not [string]::IsNullOrWhiteSpace($edgeUri.UserInfo) -or
    -not [string]::IsNullOrWhiteSpace($edgeUri.Query) -or
    -not [string]::IsNullOrWhiteSpace($edgeUri.Fragment) -or
    $edgeUri.AbsolutePath -ne '/') {
    throw 'EdgeBaseUrl must be a credential-free HTTPS origin with no path, query or fragment.'
}
$edgeOrigin = $edgeUri.GetLeftPart([UriPartial]::Authority) + '/'

$stager = Join-Path $PSScriptRoot 'Stage-McpWindowsExecutionNodeCandidate.ps1'
$switchScript = Join-Path $PSScriptRoot 'Invoke-McpV3LocalReleaseSwitch.ps1'
$updateTaskInstaller = Join-Path $PSScriptRoot 'Install-McpV3LocalUpdateTask.ps1'
foreach ($scriptPath in @($stager, $switchScript, $updateTaskInstaller)) {
    Assert-McpPublicSignature -Path $scriptPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
}

New-Item -ItemType Directory -Force -Path $state, $installation | Out-Null
$configPath = Join-Path $state 'config.json'
$configExisted = Test-Path -LiteralPath $configPath -PathType Leaf
$configBefore = if ($configExisted) { Get-Content -LiteralPath $configPath -Raw } else { $null }
$config = [ordered]@{
    version = 1
    edgeBaseUrl = $edgeOrigin
}
if (-not [string]::IsNullOrWhiteSpace($DeviceName)) {
    $trimmedDeviceName = $DeviceName.Trim()
    if ($trimmedDeviceName.Length -gt 200) {
        throw 'DeviceName must be at most 200 characters.'
    }
    $config.displayName = $trimmedDeviceName
}
$configTemporary = "$configPath.tmp.$([guid]::NewGuid().ToString('N'))"
try {
    [IO.File]::WriteAllText(
        $configTemporary,
        (($config | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $configTemporary -Destination $configPath -Force
}
finally {
    Remove-Item -LiteralPath $configTemporary -Force -ErrorAction SilentlyContinue
}

try {
$statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $installation
$currentState = Read-McpWindowsExecutionNodeState -Path $statePath
$activeReleaseId = if ($null -eq $currentState -or $null -eq $currentState.active) { $null } else { [string]$currentState.active.releaseId }
$candidateReleaseId = if ($null -eq $currentState -or $null -eq $currentState.candidate) { $null } else { [string]$currentState.candidate.releaseId }

$staged = $false
if ($activeReleaseId -ne $releaseId -and $candidateReleaseId -ne $releaseId) {
    $stageResult = & $stager -DistributionRoot $distributionRoot -InstallationRoot $installation -ExpectedReleaseId $releaseId -Execute -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
    if ([string]$stageResult.status -ne 'ready' -or [string]$stageResult.releaseId -ne $releaseId) {
        throw 'MCP V3 local release staging did not reach ready.'
    }
    $staged = $true
}

$switchResult = & $switchScript -InstallationRoot $installation -StateRoot $state -TargetReleaseId $releaseId -TaskName $TaskName -Execute -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
if ([string]$switchResult.status -ne 'active' -or [string]$switchResult.releaseId -ne $releaseId) {
    throw 'MCP V3 local release switch returned unexpected evidence.'
}
}
catch {
    if ($configExisted) {
        [IO.File]::WriteAllText($configPath, [string]$configBefore, [Text.UTF8Encoding]::new($false))
    }
    else {
        Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
    }
    throw
}

$autoUpdateActivated = $false
$autoUpdateError = $null
if (-not $DisableAutoUpdate) {
    try {
        $updateTask = & $updateTaskInstaller -InstallationRoot $installation -StateRoot $state -Repository $Repository -CompanionTaskName $TaskName -TaskName $UpdateTaskName -Hour $UpdateHour -Execute -Force -Activate -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | ConvertFrom-Json
        if ($updateTask.activated -ne $true -or [string]$updateTask.taskName -ne $UpdateTaskName) {
            throw 'MCP V3 local updater task installation returned unexpected evidence.'
        }
        $autoUpdateActivated = $true
    }
    catch {
        $autoUpdateError = $_.Exception.Message
    }
}
else {
    $existingUpdateTask = Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue
    if ($existingUpdateTask) {
        $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        if (-not (Test-McpWindowsAccountIdentityEquivalent -Left ([string]$existingUpdateTask.Principal.UserId) -Right $currentUser)) {
            throw "Refusing to disable MCP V3 updater task owned by another user: $UpdateTaskName"
        }
        Disable-ScheduledTask -TaskName $UpdateTaskName | Out-Null
    }
}

[pscustomobject]@{
    status = 'installed'
    releaseId = $releaseId
    staged = $staged
    promoted = [bool]$switchResult.promoted
    taskName = [string]$switchResult.taskName
    taskRunning = [bool]$switchResult.taskRunning
    edgeBaseUrl = $edgeOrigin
    installationRoot = $installation
    stateRoot = $state
    configPath = $configPath
    autoUpdateActivated = $autoUpdateActivated
    autoUpdateError = $autoUpdateError
    updateTaskName = $UpdateTaskName
    updateRepository = $Repository
    nextAction = 'Complete the MCP V3 OAuth approval in the browser when prompted. No connector token or manual workspace policy is required.'
} | ConvertTo-Json -Compress
