[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$workflowRoot = [IO.Path]::GetFullPath((Join-Path $root '..\.github\workflows'))

$parseIssues = @()
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.ps1') {
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile(
        $file.FullName,
        [ref]$tokens,
        [ref]$errors
    ) | Out-Null
    foreach ($parseError in $errors) {
        $parseIssues += "$($file.Name): $($parseError.Message)"
    }
}
if ($parseIssues.Count -gt 0) {
    throw ($parseIssues -join [Environment]::NewLine)
}

function Read-ProjectFile {
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    $path = Join-Path $root $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required project file is missing: $RelativePath"
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
            throw "$Label still contains retired token: $token"
        }
    }
}

$releaseWorkflowPath = Join-Path $workflowRoot 'release.yml'
if (-not (Test-Path -LiteralPath $releaseWorkflowPath -PathType Leaf)) {
    throw 'Public release workflow is missing.'
}
$releaseWorkflow = Get-Content -LiteralPath $releaseWorkflowPath -Raw
Assert-ContainsAll -Label 'Public release workflow' -Source $releaseWorkflow -Tokens @(
    'npm run build',
    'New-McpWindowsExecutionNodeArtifacts.ps1',
    'New-McpPublicDistribution.ps1',
    'Test-McpWindowsExecutionNodePackage.ps1',
    '-OfflinePinnedAuthenticode',
    'timeout-minutes: 5'
)
Assert-ContainsNone -Label 'Public release workflow' -Source $releaseWorkflow -Tokens @(
    'docker build',
    'docker push',
    'ghcr.io/',
    'deploy/release/'
)

$artifactBuilder = Read-ProjectFile 'deploy\windows\New-McpWindowsExecutionNodeArtifacts.ps1'
Assert-ContainsAll -Label 'Native artifact builder' -Source $artifactBuilder -Tokens @(
    'McpEdgeHost.cs',
    'McpEdgeHost.exe',
    'McpNodeHostLauncher.cs',
    'McpNodeHostLauncher.exe',
    'McpCredentialBroker.cs',
    'McpCredentialBroker.exe'
)
Assert-ContainsNone -Label 'Native artifact builder' -Source $artifactBuilder -Tokens @(
    'McpHost.cs',
    'McpHostSupervisor.cs',
    'McpHostPersistence.cs',
    'McpHost.exe',
    'mcp-host-contract-v3'
)

$distributionBuilder = Read-ProjectFile 'deploy\windows\New-McpPublicDistribution.ps1'
Assert-ContainsAll -Label 'Public distribution builder' -Source $distributionBuilder -Tokens @(
    'distribution-manifest.ps1',
    'release-attestation.ps1',
    'execution-node-manifest.json',
    'McpEdgeHost.exe',
    'Install-McpAccessStack.ps1',
    'Start-McpAccessStackCutover.ps1',
    'Invoke-McpAccessStackCutoverBroker.ps1',
    'Stage-McpWindowsExecutionNodeCandidate.ps1',
    'Invoke-McpWindowsExecutionNodeCutover.ps1',
    'Install-McpEdgeConnectorTask.ps1',
    'Install-McpBrowserWorkerTask.ps1',
    'Start-McpEdgeConnector.ps1',
    'Invoke-McpEdgeOwnerOAuthBootstrap.ps1',
    "-Id 'edge-connector'",
    "-Id 'edge-host'",
    "-Id 'browser-native-launcher'",
    "-Id 'node-runtime'",
    "-Owner 'edge-runtime'",
    "-Owner 'browser-worker'",
    "-Owner 'shared'",
    'services = @(',
    'Set-AuthenticodeSignature'
)
Assert-ContainsNone -Label 'Public distribution builder' -Source $distributionBuilder -Tokens @(
    'McpHost.exe',
    "-Role 'mcp-host'",
    'Invoke-McpWindowsExecutionNodeTransition.ps1',
    'Install-McpWindowsExecutionNodeHostTask.ps1',
    'Install-McpWindowsExecutionNodeCutoverTask.ps1',
    'Invoke-McpWindowsExecutionNodeCutoverTask.ps1',
    'Request-McpWindowsExecutionNodeCutover.ps1',
    'deploy\docker'
)

$executionCommon = Read-ProjectFile 'deploy\windows\WindowsExecutionNode.Common.ps1'
Assert-ContainsAll -Label 'Execution-node verifier' -Source $executionCommon -Tokens @(
    '$requiredServices',
    "'edge-runtime'",
    "'browser-worker'",
    "'edge-host'",
    "'browser-native-launcher'",
    'Historical execution-node manifest must contain exactly the eight-role split-owner contract.'
)
Assert-ContainsNone -Label 'Execution-node verifier' -Source $executionCommon -Tokens @(
    'four legacy',
    'six Edge PowerShell',
    'seven native-Edge legacy'
)

$cutover = Read-ProjectFile 'deploy\windows\Invoke-McpWindowsExecutionNodeCutover.ps1'
Assert-ContainsAll -Label 'Edge cutover' -Source $cutover -Tokens @(
    "ownershipMode = 'edge-only'",
    'Write-McpWindowsExecutionNodeState',
    'Enter-McpWindowsExecutionNodeOperationMutex',
    'operation = $Operation.ToLowerInvariant()'
)
Assert-ContainsNone -Label 'Edge cutover' -Source $cutover -Tokens @(
    'McpHost.exe',
    'persistent-host',
    'ScheduledTask',
    'Install-McpWindowsExecutionNodeHostTask.ps1',
    '[switch]$EdgeOnly'
)

$installer = Read-ProjectFile 'deploy\windows\Install-McpAccessStack.ps1'
Assert-ContainsAll -Label 'Windows installer detached handover' -Source $installer -Tokens @(
    'Stage-McpWindowsExecutionNodeCandidate.ps1',
    'Start-McpAccessStackCutover.ps1',
    "status = 'handover-started'",
    'handoverStarted = $true',
    "ownershipMode = 'edge-only'"
)
Assert-ContainsNone -Label 'Windows installer detached handover' -Source $installer -Tokens @(
    'Stop-McpScheduledTaskForReplacement',
    'Stop-ScheduledTask -TaskName $edgeTaskName',
    'Invoke-McpWindowsExecutionNodeCutover.ps1',
    'Install-McpEdgeConnectorTask.ps1',
    'Install-McpBrowserWorkerTask.ps1',
    'Install-McpWindowsExecutionNodeCutoverTask.ps1',
    'Invoke-McpWindowsExecutionNodeCutoverTask.ps1',
    'Request-McpWindowsExecutionNodeCutover.ps1',
    'Docker',
    'Ngrok',
    'wsl.exe'
)

$handover = Read-ProjectFile 'deploy\windows\Start-McpAccessStackCutover.ps1'
Assert-ContainsAll -Label 'Windows detached cutover handover' -Source $handover -Tokens @(
    'Invoke-McpAccessStackCutoverBroker.ps1',
    'access-stack-cutover-request.v1.json',
    'Register-ScheduledTask',
    'Start-ScheduledTask -TaskName $BrokerTaskName',
    'ExpectedRequestSha256',
    'handoverDelaySeconds = 3',
    'Set-McpWindowsScheduledTaskOwnerAccess',
    "'AllSigned'",
    "status = 'started'",
    'detached = $true'
)
Assert-ContainsNone -Label 'Windows detached cutover handover' -Source $handover -Tokens @(
    'Stop-ScheduledTask -TaskName $EdgeTaskName',
    'Invoke-McpWindowsExecutionNodeCutover.ps1'
)

$broker = Read-ProjectFile 'deploy\windows\Invoke-McpAccessStackCutoverBroker.ps1'
Assert-ContainsAll -Label 'Windows detached cutover broker' -Source $broker -Tokens @(
    'Stop-McpScheduledTaskForReplacement',
    'Restore-McpScheduledTaskSnapshot',
    'Invoke-McpWindowsExecutionNodeCutover.ps1',
    'Force = $true',
    'Activate = $false',
    'access-stack-cutover-runs',
    'Get-FileHash',
    'failed SHA-256 validation',
    'Start-Sleep -Seconds ([int]$request.handoverDelaySeconds)',
    'Start-ScheduledTask -TaskName $edgeTaskName',
    'Wait-McpEdgeCutoverHealth',
    'PreviousConnectorInstanceId',
    'executionPlaneReady',
    'contractCompatible',
    "status = 'passed'"
)
$edgeInstallIndex = $broker.IndexOf('$edgeTaskResult = & $edgeTaskInstaller @edgeParameters | ConvertFrom-Json')
$cutoverIndex = $broker.IndexOf('$cutoverCommitted = $true')
$edgeStartIndex = $broker.IndexOf('Start-ScheduledTask -TaskName $edgeTaskName')
$healthGateIndex = $broker.IndexOf('$healthGate = Wait-McpEdgeCutoverHealth')
$passedIndex = $broker.IndexOf("status = 'passed'")
if ($edgeInstallIndex -lt 0 -or $cutoverIndex -lt 0 -or $edgeStartIndex -lt 0 -or
    $healthGateIndex -lt 0 -or $passedIndex -lt 0 -or
    $edgeInstallIndex -ge $cutoverIndex -or
    $cutoverIndex -ge $edgeStartIndex -or
    $edgeStartIndex -ge $healthGateIndex -or
    $healthGateIndex -ge $passedIndex) {
    throw 'Detached cutover broker must install, promote, start, pass the functional health gate, and only then report success.'
}
$updater = Read-ProjectFile 'deploy\windows\Update-McpAccessStack.ps1'
Assert-ContainsAll -Label 'Windows updater' -Source $updater -Tokens @(
    'browser_download_url',
    'SHA-256',
    'Stage-McpWindowsExecutionNodeCandidate.ps1',
    'candidatePrepared',
    'Run Install-McpAccessStack.ps1'
)
Assert-ContainsNone -Label 'Windows updater' -Source $updater -Tokens @(
    'docker',
    'McpHost.exe'
)

& (Join-Path $PSScriptRoot 'Test-McpWindowsScheduledTaskSecurity.ps1')

& (Join-Path $PSScriptRoot 'Test-McpWindowsExecutionNodeStaging.ps1')

Write-Output 'Windows Edge distribution contract passed current build, staging and cutover gates.'
