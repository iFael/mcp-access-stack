[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'Common.ps1'
$initializerPath = Join-Path $PSScriptRoot 'Initialize-DockerProduction.ps1'
$developmentInitializerPath = Join-Path $PSScriptRoot 'Initialize-DockerDevelopment.ps1'
$installerPath = Join-Path $PSScriptRoot 'Install-McpHostTasks.ps1'
$hostRunnerPath = Join-Path $PSScriptRoot 'Run-DockerHostComponent.mjs'
$nativeLauncherSourcePath = Join-Path $PSScriptRoot '..\..\..\tooling\windows-host-launcher\McpNodeHostLauncher.cs'
$persistentEnablePath = Join-Path $PSScriptRoot '..\..\..\operations\browser\Enable-PersistentBrowserProfile.ps1'
$productionComposePath = Join-Path $PSScriptRoot '..\compose.production.yml'
$developmentComposePath = Join-Path $PSScriptRoot '..\compose.development.yml'
$productionComposeExamplePath = Join-Path $PSScriptRoot '..\config\production\compose.env.example'
$developmentComposeExamplePath = Join-Path $PSScriptRoot '..\config\development\compose.env.example'

$common = Get-Content -Raw -LiteralPath $commonPath
$initializer = Get-Content -Raw -LiteralPath $initializerPath
$developmentInitializer = Get-Content -Raw -LiteralPath $developmentInitializerPath
$installer = Get-Content -Raw -LiteralPath $installerPath
$hostRunner = Get-Content -Raw -LiteralPath $hostRunnerPath
$nativeLauncherSource = Get-Content -Raw -LiteralPath $nativeLauncherSourcePath
$persistentEnable = Get-Content -Raw -LiteralPath $persistentEnablePath
$productionCompose = Get-Content -Raw -LiteralPath $productionComposePath
$developmentCompose = Get-Content -Raw -LiteralPath $developmentComposePath

if (-not $common.Contains('function Set-McpObjectProperty')) {
    throw 'Common Docker helpers must support optional JSON properties under strict mode.'
}
if (-not $common.Contains('Run-DockerHostComponent.mjs')) {
    throw 'Immutable host releases must include the task-owned Node runner.'
}
if ($common.Contains('Start-McpHostComponentHidden.ps1')) {
    throw 'Immutable host releases must not include the legacy hidden PowerShell launcher.'
}

if ($persistentEnable -notmatch "NotePropertyName profileMode -NotePropertyValue 'persistent'") {
    throw 'Persistent browser profile enablement must select the isolated profile mode.'
}
if (-not $persistentEnable.Contains("NotePropertyName engine -NotePropertyValue 'playwright-direct'")) {
    throw 'Persistent browser profile enablement must select the direct engine.'
}
if (
    -not $persistentEnable.Contains("Properties.Remove('extensionTokenFile')") -or
    -not $persistentEnable.Contains("Properties.Remove('cliSessionName')")
) {
    throw 'Direct-engine migration must remove obsolete extension and CLI configuration.'
}
if (-not $persistentEnable.Contains('The persistent Chrome profile must stay inside browser.privateDirectory.')) {
    throw 'Persistent browser profile enablement must keep Chrome data inside the private directory.'
}
if (-not $initializer.Contains("engine = 'playwright-direct'")) {
    throw 'Docker production initialization must select the direct browser engine.'
}
if (-not $initializer.Contains("profileMode = 'persistent'")) {
    throw 'Docker production initialization must force the isolated persistent browser profile.'
}
if (
    -not $initializer.Contains("`$authMode -notin @('none', 'owner')") -or
    -not $initializer.Contains('OWNER_TOKEN=') -or
    -not $initializer.Contains('OWNER_OAUTH_SCOPES=')
) {
    throw 'Docker production initialization must preserve protected owner OAuth mode.'
}
if (
    $hostRunner.Contains('PLAYWRIGHT_MCP_EXTENSION_TOKEN') -or
    $hostRunner.Contains('BROWSER_WORKER_CLI_SESSION_NAME')
) {
    throw 'Docker host runner must not retain extension or CLI runtime configuration.'
}
if (-not $hostRunner.Contains('BROWSER_WORKER_BROWSER_CHANNEL')) {
    throw 'Docker host runner must configure the managed browser channel.'
}

if (-not $initializer.Contains("`$maxOwnedTabsProperty = `$config.browser.PSObject.Properties['maxOwnedTabs']")) {
    throw 'Docker production initializer must read optional browser.maxOwnedTabs safely.'
}
if ($initializer -match '\$config\.browser\.maxOwnedTabs') {
    throw 'Docker production initializer must not directly access optional browser.maxOwnedTabs.'
}
if (-not $initializer.Contains("`$maxConcurrentTabsProperty = `$config.browser.PSObject.Properties['maxConcurrentTabs']")) {
    throw 'Docker production initializer must read optional browser.maxConcurrentTabs safely.'
}
if ($initializer -match '\$config\.browser\.maxConcurrentTabs') {
    throw 'Docker production initializer must not directly access optional browser.maxConcurrentTabs.'
}
if (-not $initializer.Contains("`$idempotencyTtlMsProperty = `$config.browser.PSObject.Properties['idempotencyTtlMs']")) {
    throw 'Docker production initializer must read optional browser.idempotencyTtlMs safely.'
}
if ($initializer -match '\$config\.browser\.idempotencyTtlMs') {
    throw 'Docker production initializer must not directly access optional browser.idempotencyTtlMs.'
}
if (-not $initializer.Contains("`$idempotencyMaxEntriesProperty = `$config.browser.PSObject.Properties['idempotencyMaxEntries']")) {
    throw 'Docker production initializer must read optional browser.idempotencyMaxEntries safely.'
}
if ($initializer -match '\$config\.browser\.idempotencyMaxEntries') {
    throw 'Docker production initializer must not directly access optional browser.idempotencyMaxEntries.'
}

$expectedNgrokImage = 'ngrok/ngrok:3.30.0-alpine'
$invalidNgrokPattern = 'ngrok/ngrok:3\.30\.0(?!-)'
$ngrokSources = @(
    [pscustomobject]@{ Name = 'production initializer'; Content = $initializer },
    [pscustomobject]@{ Name = 'development initializer'; Content = $developmentInitializer },
    [pscustomobject]@{ Name = 'production compose'; Content = $productionCompose },
    [pscustomobject]@{ Name = 'development compose'; Content = $developmentCompose },
    [pscustomobject]@{ Name = 'production compose example'; Content = (Get-Content -Raw -LiteralPath $productionComposeExamplePath) },
    [pscustomobject]@{ Name = 'development compose example'; Content = (Get-Content -Raw -LiteralPath $developmentComposeExamplePath) }
)
foreach ($source in $ngrokSources) {
    if (-not $source.Content.Contains($expectedNgrokImage)) {
        throw "Pinned ngrok image is missing from $($source.Name): $expectedNgrokImage"
    }
    if ($source.Content -match $invalidNgrokPattern) {
        throw "Invalid unsuffixed ngrok image remains in $($source.Name)."
    }
}

foreach ($composeSource in @(
    [pscustomobject]@{ Name = 'production compose'; Content = $productionCompose },
    [pscustomobject]@{ Name = 'development compose'; Content = $developmentCompose }
)) {
    if (-not $composeSource.Content.Contains('NGROK_CONFIG: /var/lib/ngrok/auth-config.yml')) {
        throw "Ngrok generated auth configuration is not selected in $($composeSource.Name)."
    }
    if (-not $composeSource.Content.Contains('/var/lib/ngrok:rw,noexec,nosuid,size=1m')) {
        throw "Ngrok writable tmpfs is missing from $($composeSource.Name)."
    }
}

$installerRequirements = @(
    '\[switch\]\$Activate',
    'Get-McpReleaseHostRunnerPath',
    'Get-McpNodeExecutable',
    'Get-McpNodeHostLauncherExecutable',
    '-Execute \$nativeLauncher',
    "'--task-owned'",
    "'true'",
    "'--runner-restart-count'",
    "'--runner-restart-interval-seconds'",
    "'--restart-count'",
    "'--restart-interval-seconds'",
    "'--project-root'",
    "'--release-root'",
    'if \(-not \$Activate\)',
    'Disable-ScheduledTask',
    'RestartCount = 5',
    'ExecutionTimeLimit = \[TimeSpan\]::Zero',
    'Hidden = \$true',
    'must be stopped explicitly before replacement'
)
foreach ($pattern in $installerRequirements) {
    if ($installer -notmatch $pattern) {
        throw "Host task installer safety requirement is missing: $pattern"
    }
}

$hostRunnerRequirements = @(
    'spawn\(process\.execPath',
    'windowsHide: true',
    'host_runner_started',
    'host_runner_ignored_sigint',
    'openSync\(',
    'closeSync\(',
    'stdio: \["ignore", stdoutFd, stderrFd\]',
    'VS_CODE_GPT_GATEWAY_URL',
    'BROWSER_WORKER_PORT',
    'requiredArgument\(argumentsMap, "project-root"\)',
    'requiredArgument\(argumentsMap, "release-root"\)',
    'requiredArgument\(argumentsMap, "task-owned"\)',
    'Host runner requires --task-owned true',
    'ownership: "scheduled-task"',
    'runner-lease\.json',
    'LEASE_WRITE_RETRY_COUNT',
    'TRANSIENT_LEASE_FILE_ERROR_CODES',
    'host_runner_lease_write_failed',
    'writeTaskRunnerLeaseSafely\("heartbeat"\)',
    'host_runner_restart_scheduled',
    'host_runner_restart_exhausted',
    'host_runner_ignored_console_signal'
)
foreach ($pattern in $hostRunnerRequirements) {
    if ($hostRunner -notmatch $pattern) {
        throw "Node host runner safety requirement is missing: $pattern"
    }
}
if ($hostRunner.Contains('createWriteStream')) {
    throw 'Node host runner must pass opened file descriptors to child_process.spawn.'
}
if ($hostRunner -match 'launcher-pid|launcher-lease|runLauncherOwned|optionalBooleanArgument') {
    throw 'Node host runner must not retain legacy external-launcher ownership code.'
}

$nativeLauncherRequirements = @(
    'RunnerRestartCount = 0',
    'RunnerRestartIntervalSeconds = 60',
    '--runner-restart-count',
    '--runner-restart-interval-seconds',
    'native_launcher_child_restart_scheduled',
    'native_launcher_restart_exhausted',
    'Thread\.Sleep',
    'RunNodeChild',
    'AssignProcessToJobObject',
    'JobObjectLimitKillOnJobClose'
)
foreach ($pattern in $nativeLauncherRequirements) {
    if ($nativeLauncherSource -notmatch $pattern) {
        throw "Native launcher supervision requirement is missing: $pattern"
    }
}

Write-Output 'Docker safety test passed: current Compose, resilient native host supervision and task-owned runner contracts are enforced.'
