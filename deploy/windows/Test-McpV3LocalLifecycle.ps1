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
    '[string]$distribution.edgeBaseUrl',
    'edgeBaseUrl = $edgeOrigin',
    'No connector token or manual workspace policy is required.'
)
Assert-ContainsNone -Label 'MCP V3 local installer' -Source $installer -Tokens @(
    'ConnectorTokenFile',
    'OwnerTokenFile',
    'PolicyPath',
    'MCP_CONNECTOR_TOKEN'
)

$switch = Read-ProjectFile 'deploy\windows\Invoke-McpV3LocalReleaseSwitch.ps1'
Assert-ContainsAll -Label 'MCP V3 local release switch' -Source $switch -Tokens @(
    'Export-ScheduledTask',
    'Invoke-McpWindowsExecutionNodeCutover.ps1',
    'Install-McpV3LocalTask.ps1',
    'Restore-McpV3LocalTask',
    'Write-McpWindowsExecutionNodeState -Path $statePath -Value $stateBefore',
    'Start-ScheduledTask -TaskName $TaskName'
)

$updater = Read-ProjectFile 'deploy\windows\Update-McpV3Local.ps1'
Assert-ContainsAll -Label 'MCP V3 local updater' -Source $updater -Tokens @(
    'Update-McpAccessStack.ps1',
    'Invoke-McpV3LocalReleaseSwitch.ps1',
    "status = 'up-to-date'",
    "status = 'updated'"
)

$updateTask = Read-ProjectFile 'deploy\windows\Install-McpV3LocalUpdateTask.ps1'
Assert-ContainsAll -Label 'MCP V3 local auto-update task' -Source $updateTask -Tokens @(
    '-ExecutionPolicy AllSigned',
    'state.active.releaseId',
    'Update-McpV3Local.ps1',
    '-LogonType Interactive',
    '-RunLevel Limited',
    'Set-McpWindowsScheduledTaskOwnerAccess'
)
Assert-ContainsNone -Label 'MCP V3 local auto-update task' -Source $updateTask -Tokens @(
    'ExecutionPolicy Bypass',
    'RunLevel Highest',
    'MCP_CONNECTOR_TOKEN'
)

$uninstaller = Read-ProjectFile 'deploy\windows\Uninstall-McpV3Local.ps1'
Assert-ContainsAll -Label 'MCP V3 local uninstaller' -Source $uninstaller -Tokens @(
    'Test-McpWindowsAccountIdentityEquivalent',
    '--mode delete --target $target',
    '[switch]$PurgeRepositories',
    'repositoriesPreserved = -not [bool]$PurgeRepositories',
    'Repositórios',
    'Assert-McpV3RemovalBoundary'
)

$distribution = Read-ProjectFile 'deploy\windows\New-McpPublicDistribution.ps1'
Assert-ContainsAll -Label 'MCP V3 public distribution' -Source $distribution -Tokens @(
    'Install-McpV3Local.ps1',
    'Install-McpV3LocalTask.ps1',
    'Install-McpV3LocalUpdateTask.ps1',
    'Invoke-McpV3LocalReleaseSwitch.ps1',
    'Update-McpV3Local.ps1',
    'Uninstall-McpV3Local.ps1',
    "id = 'local-companion'",
    "-Id 'local-companion-runtime'",
    'edgeBaseUrl = $edgeOrigin',
    'native\McpElevationBroker.exe'
)

$executionCommon = Read-ProjectFile 'deploy\windows\WindowsExecutionNode.Common.ps1'
Assert-ContainsAll -Label 'MCP V3 execution manifest verifier' -Source $executionCommon -Tokens @(
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
