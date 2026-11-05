[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Read-ProjectFile {
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    $path = Join-Path $root $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required MCP V3 local lifecycle file is missing: $RelativePath"
    }
    return Get-Content -LiteralPath $path -Raw
}

function Assert-ContainsAll {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string[]]$Tokens
    )
    foreach ($token in $Tokens) {
        if (-not $Source.Contains($token)) {
            throw "$Label is missing required token: $token"
        }
    }
}

function Assert-ContainsNone {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string[]]$Tokens
    )
    foreach ($token in $Tokens) {
        if ($Source.Contains($token)) {
            throw "$Label contains forbidden token: $token"
        }
    }
}

$taskInstaller = Read-ProjectFile 'deploy\windows\Install-McpV3LocalTask.ps1'
Assert-ContainsAll -Label 'MCP V3 local task installer' -Source $taskInstaller -Tokens @(
    "Resolve-McpV3Artifact -Id 'node-host-launcher'",
    "Resolve-McpV3Artifact -Id 'node-runtime'",
    "Resolve-McpV3Artifact -Id 'local-companion-runtime'",
    "Resolve-McpV3Artifact -Id 'browser-credential-broker'",
    "Resolve-McpV3Artifact -Id 'elevation-broker'",
    '-LogonType Interactive',
    '-RunLevel Limited',
    'Set-McpWindowsScheduledTaskOwnerAccess',
    'Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force',
    'MCP_V3_CONFIG_PATH',
    'MCP_V3_RELEASE_ROOT'
)
Assert-ContainsNone -Label 'MCP V3 local task installer' -Source $taskInstaller -Tokens @(
    'MCP_CONNECTOR_TOKEN',
    'MCP_OWNER_TOKEN',
    'VS_CODE_GPT_POLICY_PATH',
    'RunLevel Highest',
    'LocalSystem'
)

$installer = Read-ProjectFile 'deploy\windows\Install-McpV3Local.ps1'
Assert-ContainsAll -Label 'MCP V3 local installer' -Source $installer -Tokens @(
    'Stage-McpWindowsExecutionNodeCandidate.ps1',
    'Invoke-McpV3LocalReleaseSwitch.ps1',
    'Install-McpV3LocalUpdateTask.ps1',
    'Get-McpV3LocalDefaultStateRoot',
    'Assert-McpWindowsScheduledTaskPathVisibility',
    'Where-Object { [string]$_.id -eq ''node-host-launcher'' }',
    'Where-Object { [string]$_.id -eq ''node-runtime'' }',
    '[string]$distribution.edgeBaseUrl',
    'edgeBaseUrl = $edgeOrigin',
    'No connector token or manual workspace policy is required.'
)
Assert-ContainsNone -Label 'MCP V3 local installer' -Source $installer -Tokens @(
    'ConnectorTokenFile',
    'OwnerTokenFile',
    'PolicyPath',
    'MCP_CONNECTOR_TOKEN',
    "Join-Path $env:LOCALAPPDATA 'MCP V3'"
)

$switch = Read-ProjectFile 'deploy\windows\Invoke-McpV3LocalReleaseSwitch.ps1'
Assert-ContainsAll -Label 'MCP V3 local release switch' -Source $switch -Tokens @(
    'Export-ScheduledTask',
    'Invoke-McpWindowsExecutionNodeCutover.ps1',
    'Install-McpV3LocalTask.ps1',
    'Restore-McpV3LocalTask',
    'Stop-McpV3LocalCompanionLaunchers',
    'Wait-McpV3LocalHandover',
    '[int]$HandoverWaitSeconds = 90',
    '-TimeoutSeconds $HandoverWaitSeconds',
    'sourceAlive=$sourceAlive',
    'sourceLauncherAlive=$sourceLauncherAlive',
    'launcherPid = [int]$sourceLauncherProcess.ProcessId',
    'taskkill.exe /PID ([string]$Source.launcherPid) /T /F',
    '$oldLauncherExited',
    'companion-instance.v1.json',
    '-MultipleInstances Parallel',
    '-HandoverFromInstanceId',
    '-AllowRunningReplacement',
    '-MultipleInstances IgnoreNew',
    'zeroGapHandover = $usedZeroGapHandover',
    'McpNodeHostLauncher.exe',
    'companion-cli.js',
    'taskkill.exe',
    'Write-McpWindowsExecutionNodeState -Path $statePath -Value $stateBefore',
    'Start-ScheduledTask -TaskName $TaskName'
)

$updater = Read-ProjectFile 'deploy\windows\Update-McpV3Local.ps1'
Assert-ContainsAll -Label 'MCP V3 local updater' -Source $updater -Tokens @(
    'Update-McpAccessStack.ps1',
    'Invoke-McpV3LocalReleaseSwitch.ps1',
    'targetReleaseRoot = Join-Path $installation ("releases\$expectedReleaseId")',
    "switchScript = Join-Path `$targetReleaseRoot 'deploy\windows\Invoke-McpV3LocalReleaseSwitch.ps1'",
    'Get-McpV3LocalDefaultStateRoot',
    "status = 'up-to-date'",
    "status = 'updated'"
)

$catalogSelector = Read-ProjectFile 'deploy\common\select-mcp-v3-release.mjs'
Assert-ContainsAll -Label 'shared published-release selection' -Source $catalogSelector -Tokens @(
    'selectPublishedRelease',
    'compareReleaseTags',
    'assetSuffix',
    'RELEASE_CATALOG_REFUSED'
)
Assert-ContainsAll -Label 'Windows selector integration' -Source $updater -Tokens @(
    'select-mcp-v3-release.mjs',
    'Assert-McpWindowsExecutionNodeRelease',
    'windows-x64.zip'
)
$distributor = Read-ProjectFile 'deploy\windows\New-McpPublicDistribution.ps1'
Assert-ContainsAll -Label 'signed Windows distribution selector' -Source $distributor -Tokens @(
    'deploy\common\select-mcp-v3-release.mjs',
    '$catalogSelectorTarget'
)

$updateTask = Read-ProjectFile 'deploy\windows\Install-McpV3LocalUpdateTask.ps1'
Assert-ContainsAll -Label 'MCP V3 local auto-update task' -Source $updateTask -Tokens @(
    '-ExecutionPolicy RemoteSigned',
    'state.active.releaseId',
    'Invoke-McpV3LocalUpdateTask.ps1',
    'Get-Command pwsh.exe -CommandType Application -ErrorAction Stop',
    '-ExecutionTimeLimit (New-TimeSpan -Minutes 45)',
    '-UpdaterTaskName',
    '-LogonType Interactive',
    '-RunLevel Limited',
    'Set-McpWindowsScheduledTaskOwnerAccess',
    'updater\Invoke-McpV3LocalActiveUpdater.ps1',
    '-ExecutionPolicy RemoteSigned -File',
    'updater\settings.json',
    'autoUpdate = [bool]$Activate',
    'Enable-ScheduledTask -TaskName $TaskName',
    '-RepetitionInterval (New-TimeSpan -Minutes $PollMinutes)',
    'Repetition.Interval -eq $pollInterval',
    # The windowless launcher runs pwsh so the 5-minute poll shows no console.
    'updater\McpNodeHostLauncher.exe',
    '--restart-on-failure false',
    'New-ScheduledTaskAction -Execute $launcher'
)
# Endpoint protection treats hidden tasks and encoded PowerShell as malware signals.
Assert-ContainsNone -Label 'MCP V3 local auto-update task' -Source $updateTask -Tokens @('-EncodedCommand', '-Hidden')
$localTaskInstaller = Read-ProjectFile 'deploy\windows\Install-McpV3LocalTask.ps1'
Assert-ContainsNone -Label 'MCP V3 local task visibility' -Source $localTaskInstaller -Tokens @('-Hidden')
Assert-ContainsAll -Label 'MCP V3 local task handover contract' -Source $localTaskInstaller -Tokens @(
    "[ValidateSet('IgnoreNew', 'Parallel')]",
    'MCP_V3_HANDOVER_FROM_INSTANCE_ID',
    'AllowRunningReplacement',
    '-MultipleInstances $MultipleInstances'
)

Assert-ContainsNone -Label 'MCP V3 local auto-update task' -Source $updateTask -Tokens @(
    'ExecutionPolicy Bypass',
    'RunLevel Highest',
    'WindowsPowerShell\v1.0\powershell.exe',
    'MCP_CONNECTOR_TOKEN'
)

$updateHandoff = Read-ProjectFile 'deploy\windows\Start-McpV3LocalUpdate.ps1'
Assert-ContainsAll -Label 'MCP V3 local update handoff' -Source $updateHandoff -Tokens @(
    'update-request.v1.json',
    'Get-ScheduledTask -TaskName $UpdaterTaskName',
    'updater\Invoke-McpV3LocalActiveUpdater.ps1',
    '[IO.FileMode]::CreateNew',
    "status = 'accepted'",
    'restoreEnabled',
    'resultPath'
)
# The companion runs this handoff as its own child, and endpoint protection
# kills a node process whose child changes or starts a Scheduled Task.
Assert-ContainsNone -Label 'MCP V3 local update handoff' -Source $updateHandoff -Tokens @(
    'RunLevel Highest',
    'LocalSystem',
    'ExecutionPolicy Bypass',
    'Register-ScheduledTask',
    'Enable-ScheduledTask',
    'Disable-ScheduledTask',
    'Start-ScheduledTask',
    'Install-McpV3LocalUpdateTask.ps1 -InstallationRoot $'
)

$updateRunner = Read-ProjectFile 'deploy\windows\Invoke-McpV3LocalUpdateTask.ps1'
Assert-ContainsAll -Label 'MCP V3 local update task runner' -Source $updateRunner -Tokens @(
    'update-request.v1.json',
    'Update-McpV3Local.ps1',
    "status = 'succeeded'",
    "status = 'failed'",
    'updater\settings.json',
    'no-request-and-auto-update-off',
    'auto-update-checked-recently',
    'updater\last-auto-check.json',
    'result-$operationId.json'
)
Assert-ContainsNone -Label 'MCP V3 local update task runner' -Source $updateRunner -Tokens @('Disable-ScheduledTask')

$uninstaller = Read-ProjectFile 'deploy\windows\Uninstall-McpV3Local.ps1'
Assert-ContainsAll -Label 'MCP V3 local uninstaller' -Source $uninstaller -Tokens @(
    'Test-McpWindowsAccountIdentityEquivalent',
    'Get-McpV3LocalDefaultStateRoot',
    '--mode delete --target $target',
    '[switch]$PurgeRepositories',
    'repositoriesPreserved = -not [bool]$PurgeRepositories',
    'Repositórios',
    'Assert-McpV3RemovalBoundary',
    '[char[]]@(',
    '[IO.Path]::DirectorySeparatorChar',
    '[IO.Path]::AltDirectorySeparatorChar',
    '.TrimEnd($trimChars)'
)

$stager = Read-ProjectFile 'deploy\windows\Stage-McpWindowsExecutionNodeCandidate.ps1'
Assert-ContainsAll -Label 'MCP V3 Windows execution-node staging retry' -Source $stager -Tokens @(
    'Move-McpWindowsExecutionNodeDirectoryWithRetry',
    '[IO.IOException]',
    '[System.UnauthorizedAccessException]',
    'Start-Sleep -Milliseconds $delay',
    'directory move failed after {0} attempts'
)

$immutableReleaseBuilder = Read-ProjectFile 'deploy\windows\New-McpRelease.ps1'
Assert-ContainsAll -Label 'Immutable Windows runtime dependencies' -Source $immutableReleaseBuilder -Tokens @(
    "'packages/update-control-contract'",
    'oracle-control-caller.js',
    'Immutable Windows release cannot load its Oracle runtime dependencies.'
)

$distribution = Read-ProjectFile 'deploy\windows\New-McpPublicDistribution.ps1'
Assert-ContainsAll -Label 'MCP V3 public distribution' -Source $distribution -Tokens @(
    'Install-McpV3Local.ps1',
    'Install-McpV3LocalTask.ps1',
    'Install-McpV3LocalUpdateTask.ps1',
    'Invoke-McpV3LocalReleaseSwitch.ps1',
    'Invoke-McpV3LocalUpdateTask.ps1',
    'Start-McpV3LocalUpdate.ps1',
    'Update-McpV3Local.ps1',
    'Uninstall-McpV3Local.ps1',
    "id = 'local-companion'",
    "-Id 'local-companion-runtime'",
    'edgeBaseUrl = $edgeOrigin',
    'native/McpElevationBroker.exe'
)

$executionCommon = Read-ProjectFile 'deploy\windows\WindowsExecutionNode.Common.ps1'
Assert-ContainsAll -Label 'MCP V3 execution manifest verifier' -Source $executionCommon -Tokens @(
    'Get-McpV3LocalDefaultStateRoot',
    'Join-Path (Join-Path $profileRoot ''MCP V3'') ''Local''',
    'Assert-McpWindowsScheduledTaskPathVisibility',
    'Filesystem redirection or virtualization is active.',
    "'edge-runtime', 'browser-worker', 'local-companion'",
    "'local-companion-runtime'",
    'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/companion-cli.js'
)

$elevationBroker = Read-ProjectFile 'tooling\windows-elevation-broker\McpElevationBroker.cs'
Assert-ContainsAll -Label 'MCP V3 Windows elevation broker' -Source $elevationBroker -Tokens @(
    'Require(values, "request")',
    'Require(values, "sha256")',
    'Require(values, "nonce")',
    'SHA256.Create()',
    'request.cancelPath',
    'WriteResponseAtomic',
    'powershell.exe',
    'pwsh.exe',
    'cmd.exe'
)
Assert-ContainsNone -Label 'MCP V3 Windows elevation broker' -Source $elevationBroker -Tokens @(
    'LocalSystem',
    'CreateService',
    'NamedPipeServerStream'
)

$companion = Read-ProjectFile 'services\mcp-gateway\src\companion-cli.ts'
Assert-ContainsAll -Label 'MCP V3 companion runtime' -Source $companion -Tokens @(
    'PersonalBrowserBridge',
    'WindowsElevationBroker',
    'resolveCanonicalStackRoot',
    'VS_CODE_GPT_STACK_ROOT',
    'mcp_v3_local_stack_root_resolved',
    '"browser"',
    '"elevation"',
    'Repositórios'
)
# The companion drives only the user's own Chrome; it never starts a managed profile.
Assert-ContainsNone -Label 'MCP V3 companion runtime' -Source $companion -Tokens @(
    'LocalBrowserWorker',
    'local-browser-worker'
)

# The five-minute updater supervises liveness even when the version check
# is disabled or postponed. Exercise the real recovery function with mocks;
# never touch a real Windows Scheduled Task from this test.
Assert-ContainsAll -Label 'MCP V3 companion recovery' -Source $updateRunner -Tokens @(
    'Ensure-McpV3LocalCompanionRunning',
    'Start-ScheduledTask -TaskName $TaskName',
    'Test-McpWindowsAccountIdentityEquivalent',
    'companionRecovery = $companionRecovery',
    "if ([string]`$task.State -eq 'Running')",
    "if (-not [bool]`$task.Settings.Enabled"
)
Assert-ContainsNone -Label 'MCP V3 recovery task changes' -Source $updateRunner -Tokens @(
    'Register-ScheduledTask',
    'Enable-ScheduledTask',
    'Disable-ScheduledTask',
    'Stop-ScheduledTask'
)
$recoveryBeforeDaily = $updateRunner.IndexOf('$companionRecovery = Ensure-McpV3LocalCompanionRunning')
$dailySkip = $updateRunner.IndexOf("reason = 'auto-update-checked-recently'")
if ($recoveryBeforeDaily -lt 0 -or $dailySkip -lt $recoveryBeforeDaily) {
    throw 'Companion recovery must run before the version-check idle path.'
}

$parseTokens = $null
$parseErrors = $null
$runnerAst = [Management.Automation.Language.Parser]::ParseInput($updateRunner, [ref]$parseTokens, [ref]$parseErrors)
if ($null -ne $parseErrors -and $parseErrors.Count -gt 0) {
    throw "MCP V3 local updater has a PowerShell syntax error: $($parseErrors[0].Message)"
}
$recoveryAst = $runnerAst.Find({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Ensure-McpV3LocalCompanionRunning'
}, $true)
if ($null -eq $recoveryAst) {
    throw 'MCP V3 local companion recovery function is missing.'
}
. ([scriptblock]::Create($recoveryAst.Extent.Text))

$script:mockInstallation = [IO.Path]::GetFullPath((Join-Path $root '.mock-companion-recovery'))
$script:mockStateRoot = Join-Path $script:mockInstallation 'state'
$script:mockReleaseId = '1.1.0-companion.123'
$script:mockReleaseRoot = [IO.Path]::GetFullPath((Join-Path $script:mockInstallation ("releases\$($script:mockReleaseId)")))
$script:mockLauncher = [IO.Path]::GetFullPath((Join-Path $script:mockReleaseRoot 'compat\McpNodeHostLauncher.exe'))
$script:mockUser = 'CPX\recovery-test'
$script:mockStarts = 0
$script:mockVerifications = 0
$script:mockFailStart = $false
$script:mockTask = [pscustomobject]@{
    TaskPath = '\'
    State = 'Ready'
    Settings = [pscustomobject]@{ Enabled = $true; MultipleInstances = 'IgnoreNew' }
    Principal = [pscustomobject]@{ UserId = $script:mockUser; LogonType = 'Interactive'; RunLevel = 'Limited' }
    Actions = @([pscustomobject]@{
        Execute = $script:mockLauncher
        WorkingDirectory = $script:mockReleaseRoot
        Arguments = "MCP_V3_RELEASE_ROOT=$($script:mockReleaseRoot) MCP_V3_STATE_ROOT=$($script:mockStateRoot) companion-cli.js"
    })
}
function Get-ScheduledTask {
    param($TaskName, $TaskPath, $ErrorAction)
    if ($TaskName -ne 'MCP V3 local companion' -or $TaskPath -ne '\') { throw 'Unexpected recovery task.' }
    return $script:mockTask
}
function Start-ScheduledTask {
    param($TaskName, $TaskPath, $ErrorAction)
    $script:mockStarts++
    if ($script:mockFailStart) { throw 'Simulated recovery refusal.' }
    $script:mockTask.State = 'Running'
}
function Test-McpWindowsAccountIdentityEquivalent { param($Left, $Right) return $Left -eq $Right }
function Get-McpWindowsExecutionNodeStatePath { param($InstallationRoot) return 'mock-release-state' }
function Read-McpWindowsExecutionNodeState {
    param($Path)
    return [pscustomobject]@{ active = [pscustomobject]@{ releaseId = $script:mockReleaseId } }
}
function Assert-McpPublicFile { param($Path, [switch]$AllowUnsignedDevelopment) $script:mockVerifications++ }

$recoveryArgs = @{
    InstallationRoot = $script:mockInstallation
    StateRoot = $script:mockStateRoot
    TaskName = 'MCP V3 local companion'
    CurrentUser = $script:mockUser
}
if ((Ensure-McpV3LocalCompanionRunning @recoveryArgs) -ne 'restarted' -or
    $script:mockStarts -ne 1 -or $script:mockVerifications -ne 1) {
    throw 'Stopped trusted companion was not recovered exactly once.'
}
if ((Ensure-McpV3LocalCompanionRunning @recoveryArgs) -ne 'running' -or $script:mockStarts -ne 1) {
    throw 'Running companion must not be restarted.'
}
$script:mockTask.State = 'Disabled'
$script:mockTask.Settings.Enabled = $false
if ((Ensure-McpV3LocalCompanionRunning @recoveryArgs) -ne 'disabled' -or $script:mockStarts -ne 1) {
    throw 'Intentionally disabled companion must not be started.'
}
$script:mockTask.State = 'Ready'
$script:mockTask.Settings.Enabled = $true
$script:mockTask.Actions[0].Execute = 'C:\unexpected-launcher.exe'
try {
    $null = Ensure-McpV3LocalCompanionRunning @recoveryArgs
    throw 'Mismatched companion action was allowed.'
}
catch {
    if ($_.Exception.Message -notmatch 'differs from the active release') { throw }
}
$script:mockTask.Actions[0].Execute = $script:mockLauncher
$script:mockTask.Principal.UserId = 'CPX\other-user'
try {
    $null = Ensure-McpV3LocalCompanionRunning @recoveryArgs
    throw 'Companion recovery accepted a different owner.'
}
catch {
    if ($_.Exception.Message -notmatch 'differs from the active release') { throw }
}
$script:mockTask.Principal.UserId = $script:mockUser
$script:mockFailStart = $true
try {
    $null = Ensure-McpV3LocalCompanionRunning @recoveryArgs
    throw 'Companion recovery suppressed a failed task start.'
}
catch {
    if ($_.Exception.Message -notmatch 'Simulated recovery refusal') { throw }
}
if ($script:mockStarts -ne 2) {
    throw 'Companion recovery started a task on an unsafe path.'
}

Write-Output 'MCP V3 local lifecycle contracts passed.'
