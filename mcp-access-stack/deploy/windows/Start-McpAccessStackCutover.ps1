[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallationRoot,
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')][string]$ExpectedReleaseId,
    [Parameter(Mandatory = $true)][string]$EdgeRuntimeRoot,
    [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$EdgeBaseUrl,
    [Parameter(Mandatory = $true)][string]$ConnectorTokenFile,
    [Parameter(Mandatory = $true)][string]$OwnerTokenFile,
    [Parameter(Mandatory = $true)][string]$PolicyPath,
    [string]$AllowedOrigins = 'https://chatgpt.com,https://chat.openai.com',
    [string]$OwnerOAuthScopes = 'workspaces:read',
    [switch]$EnableBrowserWorker,
    [string]$BrowserWorkerTokenFile,
    [string]$BrowserPrivateDirectory,
    [string]$BrowserUserDataDirectory,
    [string]$BrowserSitePoliciesPath,
    [string]$BrowserRuntimeRoot,
    [ValidateRange(1, 65535)][int]$BrowserPort = 3350,
    [string]$EdgeTaskName = 'MCP Access Stack production edge-connector',
    [string]$BrowserTaskName = 'MCP Access Stack production browser-worker',
    [string]$BrokerTaskName = 'MCP Access Stack production cutover-broker',
    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Quote-McpCutoverBrokerArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) { throw 'Cutover broker arguments cannot contain quotes.' }
    return '"' + $Value + '"'
}

if (-not $Execute) {
    throw 'Access Stack cutover handover is intentionally gated. Re-run with -Execute.'
}
if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath)) {
    throw 'Access Stack cutover handover must run as a script file.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required cutover handover dependency is missing: $bootstrapPath"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $bootstrapPath
    if ($signature.Status -ne 'Valid' -and
        -not ($AllowUnsignedDevelopment -and $signature.Status -eq 'NotSigned')) {
        throw "Invalid Authenticode signature for $bootstrapPath. Status=$($signature.Status)"
    }
}
. $publicCommonPath
Assert-McpPublicSignature -Path $publicCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature -Path $executionCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
. $executionCommonPath
Assert-McpPublicWindowsX64

$installation = [IO.Path]::GetFullPath($InstallationRoot)
$project = [IO.Path]::GetFullPath($ProjectRoot)
$edgeRuntime = [IO.Path]::GetFullPath($EdgeRuntimeRoot)
foreach ($directory in @($installation, $project, $edgeRuntime)) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "Cutover handover directory was not found: $directory"
    }
}
foreach ($required in @($ConnectorTokenFile, $OwnerTokenFile, $PolicyPath)) {
    if (-not (Test-Path -LiteralPath ([IO.Path]::GetFullPath($required)) -PathType Leaf)) {
        throw "Cutover handover file was not found: $required"
    }
}
if ($EnableBrowserWorker) {
    foreach ($required in @($BrowserWorkerTokenFile, $BrowserSitePoliciesPath)) {
        if ([string]::IsNullOrWhiteSpace($required) -or
            -not (Test-Path -LiteralPath ([IO.Path]::GetFullPath($required)) -PathType Leaf)) {
            throw "Browser cutover handover file was not found: $required"
        }
    }
    foreach ($required in @($BrowserPrivateDirectory, $BrowserUserDataDirectory, $BrowserRuntimeRoot)) {
        if ([string]::IsNullOrWhiteSpace($required) -or
            -not (Test-Path -LiteralPath ([IO.Path]::GetFullPath($required)) -PathType Container)) {
            throw "Browser cutover handover directory was not found: $required"
        }
    }
}

$stateRoot = Join-Path $installation 'state'
$statePath = Join-Path $stateRoot 'lifecycle-state.v1.json'
$pendingRequestPath = Join-Path $stateRoot 'access-stack-cutover-request.v1.json'
$runsRoot = Join-Path $stateRoot 'access-stack-cutover-runs'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw 'Access Stack cutover requires initialized lifecycle state.'
}
if (Test-Path -LiteralPath $pendingRequestPath -PathType Leaf) {
    throw 'An Access Stack cutover request is already pending.'
}
$state = Read-McpWindowsExecutionNodeState -Path $statePath
if ($null -eq $state -or $null -eq $state.candidate) {
    throw 'Access Stack cutover requires one staged candidate release.'
}
Assert-McpWindowsExecutionNodePointer -Pointer $state.candidate -Name 'candidate'
if ([string]$state.candidate.releaseId -ne $ExpectedReleaseId) {
    throw "Access Stack cutover candidate mismatch. Expected $ExpectedReleaseId, got $($state.candidate.releaseId)."
}
$expectedManifestSha256 = [string]$state.candidate.manifestSha256
$candidateRoot = Join-Path $installation ("releases\$ExpectedReleaseId")
$brokerPath = Join-Path $candidateRoot 'deploy\windows\Invoke-McpAccessStackCutoverBroker.ps1'
if (-not (Test-Path -LiteralPath $brokerPath -PathType Leaf)) {
    throw "Signed cutover broker is missing from candidate release: $brokerPath"
}
Assert-McpPublicSignature -Path $brokerPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

$requestId = [guid]::NewGuid().ToString('D')
$createdAt = [DateTimeOffset]::UtcNow
$resultPath = Join-Path $runsRoot ("$requestId\result.json")
$request = [ordered]@{
    schemaVersion = 1
    requestId = $requestId
    expectedReleaseId = $ExpectedReleaseId
    expectedManifestSha256 = $expectedManifestSha256
    createdAt = $createdAt.ToString('O')
    createdAtUnixTimeMilliseconds = $createdAt.ToUnixTimeMilliseconds()
    handoverDelaySeconds = 3
    projectRoot = $project
    edge = [ordered]@{
        taskName = $EdgeTaskName
        runtimeRoot = $edgeRuntime
        edgeBaseUrl = $EdgeBaseUrl
        connectorTokenFile = [IO.Path]::GetFullPath($ConnectorTokenFile)
        ownerTokenFile = [IO.Path]::GetFullPath($OwnerTokenFile)
        policyPath = [IO.Path]::GetFullPath($PolicyPath)
        allowedOrigins = $AllowedOrigins
        ownerOAuthScopes = $OwnerOAuthScopes
        maxConcurrentRequests = 8
        delaySeconds = 15
    }
    browser = [ordered]@{
        enabled = [bool]$EnableBrowserWorker
        taskName = $BrowserTaskName
        runtimeRoot = if ($EnableBrowserWorker) { [IO.Path]::GetFullPath($BrowserRuntimeRoot) } else { $null }
        tokenFile = if ($EnableBrowserWorker) { [IO.Path]::GetFullPath($BrowserWorkerTokenFile) } else { $null }
        privateDirectory = if ($EnableBrowserWorker) { [IO.Path]::GetFullPath($BrowserPrivateDirectory) } else { $null }
        userDataDirectory = if ($EnableBrowserWorker) { [IO.Path]::GetFullPath($BrowserUserDataDirectory) } else { $null }
        sitePoliciesPath = if ($EnableBrowserWorker) { [IO.Path]::GetFullPath($BrowserSitePoliciesPath) } else { $null }
        port = $BrowserPort
    }
}

$requestJson = ($request | ConvertTo-Json -Depth 12) + [Environment]::NewLine
$requestBytes = [Text.UTF8Encoding]::new($false).GetBytes($requestJson)
$requestSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($requestBytes)).ToLowerInvariant()

$pwsh = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$executionPolicy = if ($AllowUnsignedDevelopment) { 'Bypass' } else { 'AllSigned' }
$brokerArguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', $executionPolicy,
    '-File', (Quote-McpCutoverBrokerArgument $brokerPath),
    '-InstallationRoot', (Quote-McpCutoverBrokerArgument $installation),
    '-RequestPath', (Quote-McpCutoverBrokerArgument $pendingRequestPath),
    '-ExpectedRequestSha256', $requestSha256,
    '-BrokerTaskName', (Quote-McpCutoverBrokerArgument $BrokerTaskName)
)
if ($AllowUnsignedDevelopment) { $brokerArguments += '-AllowUnsignedDevelopment' }
$argumentText = $brokerArguments -join ' '
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$existing = Get-ScheduledTask -TaskName $BrokerTaskName -ErrorAction SilentlyContinue
if ($existing) {
    if ([string]$existing.State -eq 'Running') {
        throw "Access Stack cutover broker is already running: $BrokerTaskName"
    }
    Unregister-ScheduledTask -TaskName $BrokerTaskName -Confirm:$false
}
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -Hidden
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $argumentText -WorkingDirectory $candidateRoot
$task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings `
    -Description 'Completes MCP Access Stack Edge cutover independently from the Edge Connector being replaced.'
Register-ScheduledTask -TaskName $BrokerTaskName -InputObject $task | Out-Null
$null = Set-McpWindowsScheduledTaskOwnerAccess -TaskName $BrokerTaskName -UserId $userId

New-Item -ItemType Directory -Force -Path $runsRoot | Out-Null
$temporary = $pendingRequestPath + '.' + $requestId + '.tmp'
try {
    [IO.File]::WriteAllBytes($temporary, $requestBytes)
    [IO.File]::Move($temporary, $pendingRequestPath)
    Start-ScheduledTask -TaskName $BrokerTaskName
}
catch {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pendingRequestPath -Force -ErrorAction SilentlyContinue
    throw
}

[pscustomobject]@{
    status = 'started'
    detached = $true
    requestId = $requestId
    releaseId = $ExpectedReleaseId
    brokerTaskName = $BrokerTaskName
    requestPath = $pendingRequestPath
    resultPath = $resultPath
} | ConvertTo-Json -Compress
