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
    [string]$BrowserTokenFile,

    [Parameter(Mandatory = $true)]
    [string]$PrivateDirectory,

    [Parameter(Mandatory = $true)]
    [string]$UserDataDirectory,

    [Parameter(Mandatory = $true)]
    [string]$SitePoliciesPath,

    [ValidateRange(1, 65535)]
    [int]$Port = 3350,

    [ValidateSet('auto', 'interactive', 'efficient', 'diagnostic')]
    [string]$Mode = 'interactive',

    [ValidateSet('chromium', 'chrome')]
    [string]$BrowserChannel = 'chromium',

    [string]$TaskName = 'MCP Access Stack production browser-worker',

    [ValidateRange(0, 300)]
    [int]$DelaySeconds = 5,

    [switch]$Headless,
    [switch]$Execute,
    [switch]$Force,
    [switch]$Activate,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Quote-McpBrowserTaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"')) {
        throw 'Browser Worker Scheduled Task arguments cannot contain quotes.'
    }
    return '"' + $Value + '"'
}

function Assert-McpBrowserTaskFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [ValidateRange(1, 10485760)][int]$MaxBytes = 10485760
    )

    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "$Name file was not found."
    }
    $item = Get-Item -LiteralPath $resolved
    if ($item.Length -le 0 -or $item.Length -gt $MaxBytes) {
        throw "$Name file size is invalid."
    }
    return $resolved
}

function Assert-McpBrowserTaskDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw "$Name directory was not found."
    }
    return $resolved
}

function Test-McpBrowserPathContains {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )

    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $childPath = [IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
    return $childPath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or
        $childPath.StartsWith(
            $parentPath + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )
}

function Get-McpBrowserReleaseArtifact {
    param(
        [Parameter(Mandatory = $true)][object]$Manifest,
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot
    )

    $records = @($Manifest.artifacts | Where-Object { [string]$_.role -eq $Role })
    if ($records.Count -ne 1) {
        throw "Browser Worker execution manifest role is missing or duplicated: $Role"
    }
    $relative = ([string]$records[0].path).Replace('/', '\')
    return [IO.Path]::GetFullPath((Join-Path $ReleaseRoot $relative))
}

$installation = [IO.Path]::GetFullPath($InstallationRoot)
$releaseRoot = Join-Path $installation ("releases\$ReleaseId")
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$tokenFile = Assert-McpBrowserTaskFile -Path $BrowserTokenFile -Name 'Browser Worker token' -MaxBytes 4096
$private = Assert-McpBrowserTaskDirectory -Path $PrivateDirectory -Name 'Browser Worker private'
$userData = Assert-McpBrowserTaskDirectory -Path $UserDataDirectory -Name 'Browser Worker user-data'
$sitePolicies = Assert-McpBrowserTaskFile -Path $SitePoliciesPath -Name 'Browser Worker site policies'
if (-not (Test-McpBrowserPathContains -Parent $runtime -Child $tokenFile)) {
    throw 'Browser Worker token file must stay inside its runtime directory.'
}
if (-not (Test-McpBrowserPathContains -Parent $private -Child $userData)) {
    throw 'Browser Worker user-data directory must stay inside its private directory.'
}
if (-not (Test-McpBrowserPathContains -Parent $private -Child $sitePolicies)) {
    throw 'Browser Worker site policies must stay inside its private directory.'
}
$tokenText = [IO.File]::ReadAllText($tokenFile, [Text.Encoding]::UTF8).Trim()
if ($tokenText.Length -lt 32 -or $tokenText.Length -gt 2048 -or $tokenText -match '[\r\n\0]') {
    throw 'Browser Worker token file contains an invalid token.'
}
$tokenText = $null

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$plan = [ordered]@{
    taskName = $TaskName
    releaseId = $ReleaseId
    releaseRoot = $releaseRoot
    runtimeRoot = $runtime
    port = $Port
    mode = $Mode
    profile = 'dedicated-persistent'
    browserChannel = $BrowserChannel
    headless = [bool]$Headless
    processSubsystem = 'windows-gui'
    consoleAttached = $false
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
    throw 'Browser Worker task installer must run as a script file.'
}
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required Browser Worker task dependency is missing: $bootstrapPath"
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
$nodePath = Get-McpBrowserReleaseArtifact -Manifest $release.executionManifest -Role 'node-runtime' -ReleaseRoot $releaseRoot
$browserWorkerPath = Get-McpBrowserReleaseArtifact -Manifest $release.executionManifest -Role 'browser-worker' -ReleaseRoot $releaseRoot
$nativeLauncherPath = Get-McpBrowserReleaseArtifact -Manifest $release.executionManifest -Role 'edge-native-launcher' -ReleaseRoot $releaseRoot
$nativeLauncherRecord = @($release.executionManifest.artifacts | Where-Object { [string]$_.role -eq 'edge-native-launcher' })
if ($nativeLauncherRecord.Count -ne 1 -or $nativeLauncherRecord[0].authenticodeRequired -ne $true) {
    throw 'Browser Worker native launcher must be a signed critical release artifact.'
}
$credentialBrokerPath = Join-Path $releaseRoot 'compat\McpCredentialBroker.exe'
if (-not (Test-Path -LiteralPath $credentialBrokerPath -PathType Leaf)) {
    throw 'Browser Worker credential broker is missing from the release.'
}
Assert-McpPublicSignature -Path $credentialBrokerPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

$logs = Join-Path $runtime 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$stdoutLog = Join-Path $logs 'browser-worker.stdout.log'
$stderrLog = Join-Path $logs 'browser-worker.stderr.log'

$arguments = [System.Collections.Generic.List[string]]::new()
foreach ($value in @(
    '--node', (Quote-McpBrowserTaskArgument $nodePath),
    '--stdout-log', (Quote-McpBrowserTaskArgument $stdoutLog),
    '--stderr-log', (Quote-McpBrowserTaskArgument $stderrLog),
    '--env', (Quote-McpBrowserTaskArgument 'BROWSER_WORKER_HOST=127.0.0.1'),
    '--env', (Quote-McpBrowserTaskArgument ("BROWSER_WORKER_PORT=$Port")),
    '--env-file', (Quote-McpBrowserTaskArgument ("BROWSER_WORKER_TOKEN=$tokenFile")),
    '--env', (Quote-McpBrowserTaskArgument ("BROWSER_WORKER_MODE=$Mode")),
    '--env', (Quote-McpBrowserTaskArgument 'BROWSER_WORKER_PROFILE_MODE=persistent'),
    '--env', (Quote-McpBrowserTaskArgument ("BROWSER_WORKER_BROWSER_CHANNEL=$BrowserChannel")),
    '--env', (Quote-McpBrowserTaskArgument ("BROWSER_WORKER_HEADLESS=$([bool]$Headless).ToString().ToLowerInvariant()")),
    '--env', (Quote-McpBrowserTaskArgument ("BROWSER_WORKER_USER_DATA_DIR=$userData")),
    '--env', (Quote-McpBrowserTaskArgument ("BROWSER_WORKER_RUNTIME_DIR=$runtime")),
    '--env', (Quote-McpBrowserTaskArgument ("BROWSER_WORKER_PRIVATE_DIR=$private")),
    '--env', (Quote-McpBrowserTaskArgument ("BROWSER_WORKER_SITE_POLICIES_PATH=$sitePolicies")),
    '--env', (Quote-McpBrowserTaskArgument ("BROWSER_WORKER_CREDENTIAL_BROKER_PATH=$credentialBrokerPath")),
    '--', (Quote-McpBrowserTaskArgument $browserWorkerPath)
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
        throw "Scheduled Task exists with a different Browser Worker contract: $TaskName"
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
        -Description 'Owns the native Windows MCP Browser Worker through the signed GUI-subsystem launcher.'
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
    browserWorkerValidated = $true
    nativeLauncherValidated = $true
    profile = 'dedicated-persistent'
    port = $Port
} | ConvertTo-Json -Compress
