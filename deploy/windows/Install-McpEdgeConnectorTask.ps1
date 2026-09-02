[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$ReleaseId,

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
    [string]$BrowserWorkerUrl = 'http://127.0.0.1:3350',
    [string]$BrowserWorkerTokenFile,
    [switch]$EnableBrowserWorker,
    [string]$TaskName = 'MCP Access Stack production edge-connector',

    [ValidateRange(1, 64)]
    [int]$MaxConcurrentRequests = 8,

    [ValidateRange(0, 300)]
    [int]$DelaySeconds = 15,

    [switch]$Execute,
    [switch]$Force,
    [switch]$Activate,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Quote-McpEdgeTaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"')) {
        throw 'Edge Connector Scheduled Task arguments cannot contain quotes.'
    }
    return '"' + $Value + '"'
}

function Assert-McpEdgeTaskFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "$Name file was not found: $resolved"
    }
    return $resolved
}

$installation = [IO.Path]::GetFullPath($InstallationRoot)
$releaseRoot = Join-Path $installation ("releases\$ReleaseId")
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$connectorToken = Assert-McpEdgeTaskFile -Path $ConnectorTokenFile -Name 'Connector token'
$ownerToken = Assert-McpEdgeTaskFile -Path $OwnerTokenFile -Name 'Owner token'
$policy = Assert-McpEdgeTaskFile -Path $PolicyPath -Name 'Workspace policy'
$browserTokenFile = $null
$browserOrigin = $null
if ($EnableBrowserWorker) {
    if ([string]::IsNullOrWhiteSpace($BrowserWorkerTokenFile)) {
        throw 'EnableBrowserWorker requires BrowserWorkerTokenFile.'
    }
    $browserTokenFile = Assert-McpEdgeTaskFile -Path $BrowserWorkerTokenFile -Name 'Browser Worker token'
    try {
        $browserUri = [Uri]$BrowserWorkerUrl
    }
    catch {
        throw 'BrowserWorkerUrl must be a valid loopback HTTP origin.'
    }
    if (-not $browserUri.IsAbsoluteUri -or
        $browserUri.Scheme -ne 'http' -or
        $browserUri.Host -notin @('127.0.0.1', 'localhost', '::1') -or
        -not [string]::IsNullOrWhiteSpace($browserUri.UserInfo) -or
        $browserUri.AbsolutePath -ne '/' -or
        -not [string]::IsNullOrWhiteSpace($browserUri.Query) -or
        -not [string]::IsNullOrWhiteSpace($browserUri.Fragment)) {
        throw 'BrowserWorkerUrl must be a credential-free loopback HTTP origin with no path, query or fragment.'
    }
    $browserOrigin = $browserUri.GetLeftPart([UriPartial]::Authority)
}
$validationLauncherPath = Join-Path $releaseRoot 'deploy\windows\Start-McpEdgeConnector.ps1'
$edgeHostPath = Join-Path $releaseRoot 'native\McpEdgeHost.exe'
$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
$pwshCommand = Get-Command pwsh.exe -ErrorAction Stop
$pwsh = [IO.Path]::GetFullPath($pwshCommand.Source)
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$executionPolicy = if ($AllowUnsignedDevelopment) { 'Bypass' } else { 'AllSigned' }
$plan = [ordered]@{
    taskName = $TaskName
    releaseId = $ReleaseId
    releaseRoot = $releaseRoot
    validationLauncherPath = $validationLauncherPath
    edgeHostPath = $edgeHostPath
    runtimeRoot = $runtime
    browserEnabled = [bool]$EnableBrowserWorker
    browserWorkerUrl = if ($EnableBrowserWorker) { $browserOrigin } else { $null }
    execute = $edgeHostPath
    processSubsystem = 'windows-gui'
    consoleAttached = $false
    validationExecutionPolicy = $executionPolicy
    trigger = 'AtLogOn'
    triggerUser = $userId
    triggerDelaySeconds = $DelaySeconds
    logonType = 'Interactive'
    runLevel = 'Limited'
    multipleInstances = 'IgnoreNew'
    restartCount = 5
    restartIntervalSeconds = 60
    executionTimeLimitSeconds = 0
    hidden = $true
    activated = [bool]$Activate
}
if (-not $Execute) {
    [pscustomobject]@{
        status = 'planned'
        changed = $false
        plan = $plan
    } | ConvertTo-Json -Depth 8 -Compress
    return
}

if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath)) {
    throw 'Edge Connector task installer must run as a script file.'
}
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required Edge Connector task dependency is missing: $bootstrapPath"
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

$releaseManifestPath = Join-Path $releaseRoot 'manifest.json'
$executionManifestPath = Join-Path $releaseRoot 'execution-node-manifest.json'
$releaseManifest = Read-McpPublicJson -Path $releaseManifestPath
$releaseAttestation = Assert-McpPublicReleaseAttestation -ReleaseRoot $releaseRoot -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
$executionManifest = Read-McpPublicJson -Path $executionManifestPath
$releaseCommit = [string]$releaseManifest.commit
if ([string]$releaseManifest.releaseId -ne $ReleaseId -or
    $releaseCommit -notmatch '^[a-f0-9]{40}$' -or
    [int]$executionManifest.version -ne 1 -or
    [string]$executionManifest.releaseId -ne $ReleaseId -or
    [string]$executionManifest.commit -ne $releaseCommit -or
    [string]$executionManifest.platform -ne 'win32-x64' -or
    [string]$executionManifest.runtimeMode -ne 'bundled-node' -or
    [string]$executionManifest.integrityRoot -ne 'signed-distribution-manifest') {
    throw 'Edge Connector release identity or execution manifest contract is invalid.'
}
$executionIdentity = $releaseManifest.executionNode
if ($null -eq $executionIdentity -or
    [int]$executionIdentity.schemaVersion -ne 1 -or
    [string]$executionIdentity.manifestPath -ne 'execution-node-manifest.json') {
    throw 'Edge Connector release manifest is missing execution-node identity.'
}
$expectedManifestSha256 = ([string]$releaseManifest.executionNode.manifestSha256).ToLowerInvariant()
$manifestSha256 = (Get-FileHash -LiteralPath $executionManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expectedManifestSha256 -notmatch '^[a-f0-9]{64}$' -or
    $manifestSha256 -ne $expectedManifestSha256 -or
    [string]$releaseAttestation.releaseId -ne $ReleaseId -or
    [string]$releaseAttestation.commit -ne $releaseCommit) {
    throw 'Edge Connector execution manifest is not bound to the signed release attestation.'
}
if (-not (Test-Path -LiteralPath $validationLauncherPath -PathType Leaf)) {
    throw "Edge Connector validation launcher is missing from release: $validationLauncherPath"
}
if (-not (Test-Path -LiteralPath $edgeHostPath -PathType Leaf)) {
    throw "Edge Connector native host is missing from release: $edgeHostPath"
}
Assert-McpPublicSignature -Path $validationLauncherPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature -Path $edgeHostPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
$validationLauncherRecord = @($executionManifest.artifacts | Where-Object { [string]$_.role -eq 'edge-connector-launcher' })
if ($validationLauncherRecord.Count -ne 1 -or $validationLauncherRecord[0].authenticodeRequired -ne $true) {
    throw 'Edge Connector validation launcher must be a signed critical release artifact.'
}
$edgeHostRecord = @($executionManifest.artifacts | Where-Object { [string]$_.role -eq 'edge-host' })
if ($edgeHostRecord.Count -ne 1 -or
    [string]$edgeHostRecord[0].path -ne 'native/McpEdgeHost.exe' -or
    $edgeHostRecord[0].authenticodeRequired -ne $true) {
    throw 'Edge Connector native host must be the signed native/McpEdgeHost.exe critical artifact.'
}

$validationArguments = @(
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', $executionPolicy,
    '-File', $validationLauncherPath,
    '-ReleaseRoot', $releaseRoot,
    '-ExpectedManifestSha256', $manifestSha256,
    '-RuntimeRoot', $runtime,
    '-EdgeBaseUrl', $EdgeBaseUrl,
    '-ConnectorTokenFile', $connectorToken,
    '-OwnerTokenFile', $ownerToken,
    '-PolicyPath', $policy,
    '-AllowedOrigins', $AllowedOrigins,
    '-OwnerOAuthScopes', $OwnerOAuthScopes,
    '-MaxConcurrentRequests', [string]$MaxConcurrentRequests,
    '-ValidateOnly'
)
if ($EnableBrowserWorker) {
    $validationArguments += @(
        '-EnableBrowserWorker',
        '-BrowserWorkerUrl', $browserOrigin,
        '-BrowserWorkerTokenFile', $browserTokenFile
    )
}
$validationJson = @(& $pwsh @validationArguments)
if ($LASTEXITCODE -ne 0 -or $validationJson.Count -ne 1) {
    throw 'Edge Connector launcher validation failed before task installation.'
}
$validation = $validationJson[0] | ConvertFrom-Json
if ([string]$validation.status -ne 'validated' -or
    [string]$validation.executionManifestSha256 -ne $manifestSha256 -or
    [bool]$validation.browserEnabled -ne [bool]$EnableBrowserWorker) {
    throw 'Edge Connector launcher validation returned unexpected evidence.'
}
$edgeOrigin = [string]$validation.edgeOrigin
$browserEnabled = if ($EnableBrowserWorker) { 'true' } else { 'false' }
$hostArguments = @(
    '--release-root', $releaseRoot,
    '--expected-manifest-sha256', $manifestSha256,
    '--runtime-root', $runtime,
    '--edge-base-url', $edgeOrigin,
    '--connector-token-file', $connectorToken,
    '--owner-token-file', $ownerToken,
    '--policy-path', $policy,
    '--allowed-origins', $AllowedOrigins,
    '--owner-oauth-scopes', $OwnerOAuthScopes,
    '--max-concurrent-requests', [string]$MaxConcurrentRequests,
    '--restart-count', '0',
    '--restart-interval-seconds', '60',
    '--browser-enabled', $browserEnabled
)
if ($EnableBrowserWorker) {
    $hostArguments += @(
        '--browser-worker-url', $browserOrigin,
        '--browser-worker-token-file', $browserTokenFile
    )
}
$edgeHostValidation = @(& $edgeHostPath @hostArguments '--validate-only' 2>&1)
if ($LASTEXITCODE -ne 0 -or
    $edgeHostValidation.Count -ne 1 -or
    [string]$edgeHostValidation[0] -ne 'mcp-edge-host-contract-v1') {
    throw 'McpEdgeHost fixed-contract validation failed before task installation.'
}
$hostValues = [System.Collections.Generic.List[string]]::new()
for ($index = 0; $index -lt $hostArguments.Count; $index += 2) {
    $hostValues.Add([string]$hostArguments[$index])
    $hostValues.Add((Quote-McpEdgeTaskArgument ([string]$hostArguments[$index + 1])))
}
$argumentText = $hostValues -join ' '
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$alreadyInstalled = $false
if ($existing) {
    $actions = @($existing.Actions)
    $matches = $actions.Count -eq 1 -and
        [IO.Path]::GetFullPath([string]$actions[0].Execute) -eq [IO.Path]::GetFullPath($edgeHostPath) -and
        [string]$actions[0].Arguments -eq $argumentText -and
        [string]$actions[0].WorkingDirectory -eq $releaseRoot -and
        (Test-McpWindowsAccountIdentityEquivalent -Left ([string]$existing.Principal.UserId) -Right $userId) -and
        [string]$existing.Principal.LogonType -in @('Interactive', 'InteractiveToken') -and
        [string]$existing.Principal.RunLevel -eq 'Limited'
    if ($matches) {
        $alreadyInstalled = $true
    }
    elseif (-not $Force) {
        throw "Scheduled Task exists with a different Edge Connector contract: $TaskName"
    }
    else {
        if ([string]$existing.State -eq 'Running') {
            throw "Scheduled Task is running and must be stopped before replacement: $TaskName"
        }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        $existing = $null
    }
}

if (-not $alreadyInstalled) {
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -Hidden
    $action = New-ScheduledTaskAction `
        -Execute $edgeHostPath `
        -Argument $argumentText `
        -WorkingDirectory $releaseRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    if ($DelaySeconds -gt 0) {
        $trigger.Delay = 'PT{0}S' -f $DelaySeconds
    }
    $task = New-ScheduledTask `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description 'Owns the persistent outbound Cloudflare MCP Edge Connector through the signed fixed-contract McpEdgeHost.'
    Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null
}

if ($Activate) {
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
}
else {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
}

[pscustomobject]@{
    status = if ($alreadyInstalled) { 'already-installed' } else { 'installed' }
    changed = -not $alreadyInstalled
    activated = [bool]$Activate
    taskName = $TaskName
    releaseId = $ReleaseId
    executionManifestSha256 = $manifestSha256
    launcherValidated = $true
    edgeHostValidated = $true
    browserEnabled = [bool]$EnableBrowserWorker
    browserWorkerUrl = if ($EnableBrowserWorker) { $browserOrigin } else { $null }
} | ConvertTo-Json -Compress
