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
$validationLauncherPath = Join-Path $releaseRoot 'deploy\windows\Start-McpEdgeConnector.ps1'
$nativeLauncherPath = Join-Path $releaseRoot 'compat\McpNodeHostLauncher.exe'
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
    launcherPath = $nativeLauncherPath
    runtimeRoot = $runtime
    execute = $nativeLauncherPath
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

$release = Assert-McpWindowsExecutionNodeRelease `
    -ReleaseRoot $releaseRoot `
    -ExpectedReleaseId $ReleaseId `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment `
    -RuntimeSmoke
$manifestSha256 = [string]$release.executionManifestSha256

if (-not (Test-Path -LiteralPath $validationLauncherPath -PathType Leaf)) {
    throw "Edge Connector validation launcher is missing from release: $validationLauncherPath"
}
if (-not (Test-Path -LiteralPath $nativeLauncherPath -PathType Leaf)) {
    throw "Edge Connector native launcher is missing from release: $nativeLauncherPath"
}
$validationLauncherRecord = @($release.executionManifest.artifacts | Where-Object { [string]$_.role -eq 'edge-connector-launcher' })
if ($validationLauncherRecord.Count -ne 1 -or $validationLauncherRecord[0].authenticodeRequired -ne $true) {
    throw 'Edge Connector validation launcher must be a signed critical release artifact.'
}
$nativeLauncherRecord = @($release.executionManifest.artifacts | Where-Object { [string]$_.role -eq 'edge-native-launcher' })
if ($nativeLauncherRecord.Count -ne 1 -or $nativeLauncherRecord[0].authenticodeRequired -ne $true) {
    throw 'Edge Connector native launcher must be a signed critical release artifact.'
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
$validationJson = @(& $pwsh @validationArguments)
if ($LASTEXITCODE -ne 0 -or $validationJson.Count -ne 1) {
    throw 'Edge Connector launcher validation failed before task installation.'
}
$validation = $validationJson[0] | ConvertFrom-Json
if ([string]$validation.status -ne 'validated' -or
    [string]$validation.executionManifestSha256 -ne $manifestSha256) {
    throw 'Edge Connector launcher validation returned unexpected evidence.'
}
$nodePath = [IO.Path]::GetFullPath([string]$validation.nodePath)
$edgeCliPath = [IO.Path]::GetFullPath([string]$validation.edgeConnectorPath)
$edgeOrigin = [string]$validation.edgeOrigin
$stdoutLog = Join-Path $runtime 'logs\edge-connector.stdout.log'
$stderrLog = Join-Path $runtime 'logs\edge-connector.stderr.log'
$ownerOAuthStatePath = Join-Path $runtime 'owner-oauth-state.json'

$arguments = [System.Collections.Generic.List[string]]::new()
foreach ($value in @(
    '--node', (Quote-McpEdgeTaskArgument $nodePath),
    '--stdout-log', (Quote-McpEdgeTaskArgument $stdoutLog),
    '--stderr-log', (Quote-McpEdgeTaskArgument $stderrLog),
    '--env', (Quote-McpEdgeTaskArgument ("MCP_EDGE_BASE_URL=$edgeOrigin")),
    '--env', (Quote-McpEdgeTaskArgument ("MCP_CONNECTOR_TOKEN_FILE=$connectorToken")),
    '--env', (Quote-McpEdgeTaskArgument ("VS_CODE_GPT_POLICY_PATH=$policy")),
    '--env', (Quote-McpEdgeTaskArgument ("MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS=$MaxConcurrentRequests")),
    '--env', (Quote-McpEdgeTaskArgument 'AUTH_MODE=owner'),
    '--env-file', (Quote-McpEdgeTaskArgument ("OWNER_TOKEN=$ownerToken")),
    '--env', (Quote-McpEdgeTaskArgument ("OWNER_OAUTH_SCOPES=$OwnerOAuthScopes")),
    '--env', (Quote-McpEdgeTaskArgument ("OWNER_OAUTH_STATE_PATH=$ownerOAuthStatePath")),
    '--env', (Quote-McpEdgeTaskArgument ("ALLOWED_ORIGINS=$AllowedOrigins")),
    '--env', (Quote-McpEdgeTaskArgument 'BROWSER_WORKER_ENABLED=false'),
    '--', (Quote-McpEdgeTaskArgument $edgeCliPath)
)) {
    $arguments.Add([string]$value)
}
$argumentText = $arguments -join ' '

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$alreadyInstalled = $false
if ($existing) {
    $actions = @($existing.Actions)
    $matches = $actions.Count -eq 1 -and
        [IO.Path]::GetFullPath([string]$actions[0].Execute) -eq [IO.Path]::GetFullPath($nativeLauncherPath) -and
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
        -Execute $nativeLauncherPath `
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
        -Description 'Owns the persistent outbound Cloudflare MCP Edge Connector through the signed native GUI-subsystem launcher.'
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
    nativeLauncherValidated = $true
} | ConvertTo-Json -Compress
