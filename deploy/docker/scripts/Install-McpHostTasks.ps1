[CmdletBinding()]
param(
    [ValidateSet('development', 'production')]
    [string]$Environment = 'production',
    [string]$ReleaseRoot,
    [string]$TaskPrefix = 'MCP Access Stack Docker',
    [switch]$Force,
    [switch]$Activate
)

. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Get-McpProjectRoot
if (-not $ReleaseRoot) {
    if ($Environment -eq 'production') {
        throw 'Production host task installation requires an explicit -ReleaseRoot.'
    }
    $ReleaseRoot = $root
}
$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
$manifestPath = Join-Path $ReleaseRoot 'manifest.json'
$releaseManifest = if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    Read-McpJsonFile -Path $manifestPath
}
else {
    $null
}
if ($Environment -eq 'production') {
    if (-not $releaseManifest) {
        throw 'Production host task installation requires a release manifest.'
    }
    Assert-McpReleasePointerEligible -Root $root -Pointer ([pscustomobject]@{
        releaseId = [string]$releaseManifest.releaseId
        path = $ReleaseRoot
        commit = [string]$releaseManifest.commit
    }) | Out-Null
}

$componentRunner = Get-McpReleaseHostRunnerPath -ReleaseRoot $ReleaseRoot
$nativeLauncher = Get-McpNodeHostLauncherExecutable -ProjectRoot $root -ReleaseRoot $ReleaseRoot
$credentialBroker = Get-McpCredentialBrokerExecutable -ProjectRoot $root -ReleaseRoot $ReleaseRoot
$managedRuntimeRoot = $null
$managedReleaseId = $null
$directNode = $null
if ($releaseManifest) {
    [void](Initialize-McpReleaseNodeRuntimeState -ReleaseRoot $ReleaseRoot -ProjectRoot $root -InstallMissing)
    $managedRuntimeRoot = Get-McpManagedNodeRuntimeRoot -ProjectRoot $root
    $managedReleaseId = [string]$releaseManifest.releaseId
}
else {
    $directNode = Get-McpNodeExecutable
}

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settingsParameters = @{
    AllowStartIfOnBatteries = $true
    DontStopIfGoingOnBatteries = $true
    StartWhenAvailable = $true
    MultipleInstances = 'IgnoreNew'
    RestartCount = 5
    RestartInterval = (New-TimeSpan -Minutes 1)
    ExecutionTimeLimit = [TimeSpan]::Zero
    Hidden = $true
}
$settings = New-ScheduledTaskSettingsSet @settingsParameters

function Quote-TaskArgument {
    param([string]$Value)
    if ($Value.Contains('"')) {
        throw 'Scheduled task arguments cannot contain quotes.'
    }
    return '"' + $Value + '"'
}

function Replace-ExistingTask {
    param([Parameter(Mandatory = $true)][string]$TaskName)

    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing -and -not $Force) {
        throw "Scheduled task already exists: $TaskName. Use -Force to replace it."
    }
    if ($existing -and $existing.State -eq 'Running') {
        throw "Scheduled task is running and must be stopped explicitly before replacement: $TaskName"
    }
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
}

function Install-ComponentTask {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('agent', 'browser-worker')]
        [string]$Component,
        [int]$DelaySeconds = 0
    )

    $configurationFile = if ($Component -eq 'agent') { 'agent.json' } else { 'browser.json' }
    $configurationPath = Join-Path $root ".runtime-private\docker\$Environment\$configurationFile"
    if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
        if ($Component -eq 'browser-worker' -and $Environment -eq 'development') {
            return
        }
        throw "Private component configuration is missing: $configurationPath"
    }

    $taskName = "$TaskPrefix $Environment $Component"
    Replace-ExistingTask -TaskName $taskName

    $componentRuntimeDirectory = Join-Path $root "runtime\windows-services\$Environment\$Component"
    New-Item -ItemType Directory -Force -Path $componentRuntimeDirectory | Out-Null
    $launcherStdoutPath = Join-Path $componentRuntimeDirectory 'native-launcher.stdout.log'
    $launcherStderrPath = Join-Path $componentRuntimeDirectory 'native-launcher.stderr.log'

    $nodeArguments = if ($managedReleaseId) {
        @(
            '--node-runtime-root',
            (Quote-TaskArgument $managedRuntimeRoot),
            '--node-release-id',
            $managedReleaseId
        )
    }
    else {
        @('--node', (Quote-TaskArgument $directNode))
    }

    $arguments = @(
        $nodeArguments
        '--stdout-log'
        (Quote-TaskArgument $launcherStdoutPath)
        '--stderr-log'
        (Quote-TaskArgument $launcherStderrPath)
        '--runner-restart-count'
        '0'
        '--runner-restart-interval-seconds'
        '60'
        '--'
        (Quote-TaskArgument $componentRunner)
        '--component'
        $Component
        '--environment'
        $Environment
        '--release-root'
        (Quote-TaskArgument $ReleaseRoot)
        '--project-root'
        (Quote-TaskArgument $root)
        '--credential-broker-path'
        (Quote-TaskArgument $credentialBroker)
        '--task-owned'
        'true'
        '--restart-count'
        '5'
        '--restart-interval-seconds'
        '5'
    ) -join ' '

    $action = New-ScheduledTaskAction `
        -Execute $nativeLauncher `
        -Argument $arguments `
        -WorkingDirectory $ReleaseRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    if ($DelaySeconds -gt 0) {
        $trigger.Delay = 'PT{0}S' -f $DelaySeconds
    }
    $task = New-ScheduledTask `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description "Starts the task-owned MCP $Component runner using the release-qualified managed Node.js runtime."
    Register-ScheduledTask -TaskName $taskName -InputObject $task | Out-Null
    if (-not $Activate) {
        Disable-ScheduledTask -TaskName $taskName | Out-Null
    }
    $mode = if ($Activate) { 'active' } else { 'staged and disabled' }
    Write-Output "Installed scheduled task ($mode): $taskName"
}

function Install-NodeRuntimeMaintenanceTask {
    if ($Environment -ne 'production' -or -not $releaseManifest) {
        return
    }

    $taskName = "$TaskPrefix production node-runtime-update"
    Replace-ExistingTask -TaskName $taskName
    $updateScript = Join-Path $ReleaseRoot 'deploy\docker\scripts\Update-McpNodeRuntime.ps1'
    if (-not (Test-Path -LiteralPath $updateScript -PathType Leaf)) {
        throw "Release Node runtime updater is missing: $updateScript"
    }

    $arguments = @(
        '-NoLogo'
        '-NoProfile'
        '-ExecutionPolicy'
        'AllSigned'
        '-File'
        (Quote-TaskArgument $updateScript)
        '-ReleaseRoot'
        (Quote-TaskArgument $ReleaseRoot)
        '-ProjectRoot'
        (Quote-TaskArgument $root)
        '-Channel'
        'Current'
    ) -join ' '
    $action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument $arguments -WorkingDirectory $ReleaseRoot
    $trigger = New-ScheduledTaskTrigger -Daily -At '03:30'
    $maintenanceSettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
        -Hidden
    $task = New-ScheduledTask `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $maintenanceSettings `
        -Description 'Checks the official Node.js Current channel, qualifies new runtimes against the exact active MCP release commit and promotes only passing versions.'
    Register-ScheduledTask -TaskName $taskName -InputObject $task | Out-Null
    if (-not $Activate) {
        Disable-ScheduledTask -TaskName $taskName | Out-Null
    }
    $mode = if ($Activate) { 'active' } else { 'staged and disabled' }
    Write-Output "Installed scheduled task ($mode): $taskName"
}

Install-ComponentTask -Component 'agent' -DelaySeconds 15
Install-ComponentTask -Component 'browser-worker' -DelaySeconds 30
Install-NodeRuntimeMaintenanceTask
