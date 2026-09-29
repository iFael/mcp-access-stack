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

$updateTask = Read-ProjectFile 'deploy\windows\Install-McpV3LocalUpdateTask.ps1'
Assert-ContainsAll -Label 'MCP V3 local auto-update task' -Source $updateTask -Tokens @(
    '-ExecutionPolicy AllSigned',
    'state.active.releaseId',
    'Invoke-McpV3LocalUpdateTask.ps1',
    'Get-Command pwsh.exe -CommandType Application -ErrorAction Stop',
    '-ExecutionTimeLimit (New-TimeSpan -Minutes 45)',
    '-UpdaterTaskName',
    '-LogonType Interactive',
    '-RunLevel Limited',
    'Set-McpWindowsScheduledTaskOwnerAccess'
)
$localTaskInstaller = Read-ProjectFile 'deploy\windows\Install-McpV3LocalTask.ps1'
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
    'Install-McpV3LocalUpdateTask.ps1',
    'Start-ScheduledTask -TaskName $UpdaterTaskName',
    '[IO.FileMode]::CreateNew',
    "status = 'accepted'",
    'restoreEnabled',
    'resultPath'
)
Assert-ContainsNone -Label 'MCP V3 local update handoff' -Source $updateHandoff -Tokens @(
    'RunLevel Highest',
    'LocalSystem',
    'ExecutionPolicy Bypass'
)

$updateRunner = Read-ProjectFile 'deploy\windows\Invoke-McpV3LocalUpdateTask.ps1'
Assert-ContainsAll -Label 'MCP V3 local update task runner' -Source $updateRunner -Tokens @(
    'update-request.v1.json',
    'Update-McpV3Local.ps1',
    "status = 'succeeded'",
    "status = 'failed'",
    'Disable-ScheduledTask -TaskName $UpdaterTaskName',
    'result-$operationId.json'
)

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
    'native\McpElevationBroker.exe'
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
    'LocalBrowserWorker',
    'WindowsElevationBroker',
    '"browser"',
    '"elevation"',
    'Repositórios'
)

Write-Output 'MCP V3 local lifecycle contracts passed.'
