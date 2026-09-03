[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$collector = Join-Path $PSScriptRoot 'Get-McpMaterializationIncidentEvidence.ps1'
if (-not (Test-Path -LiteralPath $collector -PathType Leaf)) {
    throw "Materialization incident collector is missing: $collector"
}

$collectorContent = Get-Content -LiteralPath $collector -Raw
foreach ($forbidden in @(
    'Start-ScheduledTask',
    'Stop-ScheduledTask',
    'Set-ScheduledTask',
    'Register-ScheduledTask',
    'Unregister-ScheduledTask',
    'Start-Process',
    'Stop-Process',
    'Remove-Item',
    'Restart-Service',
    'Set-ItemProperty',
    'Bitdefender',
    'BitDefender'
)) {
    if ($collectorContent.Contains($forbidden)) {
        throw "Materialization collector must remain read-only: $forbidden"
    }
}

$fixtureRoot = Join-Path $env:TEMP ('mcp-materialization-evidence-' + [guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $fixtureRoot 'releases\release-fixture'
$tokenFile = Join-Path $fixtureRoot 'connector-token.txt'
$connectorToken = 'connector-super-secret-' + ('x' * 48)
$edgeBaseUrl = 'https://edge.example'
$taskName = 'MCP Access Stack production edge-connector'
$edgeHostPath = Join-Path $releaseRoot 'native\McpEdgeHost.exe'
$nodePath = Join-Path $releaseRoot 'runtime\node\node.exe'
$ownerTokenPath = Join-Path $fixtureRoot 'owner-token.txt'
$policyPath = Join-Path $fixtureRoot 'policy.json'
$healthFixture = [pscustomobject]@{
    service = 'mcp-edge-gateway'
    status = 'ok'
    edgeEnabled = $true
    controlPlaneReady = $true
    executionPlaneReady = $true
    connectorReady = $true
    runtime = [pscustomobject]@{
        connectorInstanceId = '11111111-1111-4111-8111-111111111111'
        connectionGeneration = 4
        catalogContractRevision = ('a' * 64)
        toolSetRevision = ('b' * 64)
        toolCount = 61
        serverVersion = '1.1.0-beta.24-catalog.test'
        readySince = '2026-09-02T12:00:00.000Z'
        lastRequestAt = '2026-09-02T12:01:00.000Z'
        lastSuccessfulRequestAt = '2026-09-02T12:01:01.000Z'
        readyCount = 5
        disconnectCount = 1
    }
}
$runtimeTelemetryFixture = [pscustomobject]@{
    version = 1
    connectorInstanceId = '11111111-1111-4111-8111-111111111111'
    connectionGeneration = 4
    processStartedAt = '2026-09-02T11:55:00.000Z'
    catalogContractRevision = ('a' * 64)
    toolSetRevision = ('b' * 64)
    toolCount = 61
    serverVersion = '1.1.0-beta.24-catalog.test'
    nodePid = 2200
    hostPid = 1100
    readySince = '2026-09-02T12:00:00.000Z'
    lastDisconnectedAt = '2026-09-02T11:59:00.000Z'
    lastRequestAt = '2026-09-02T12:01:00.000Z'
    lastSuccessfulRequestAt = '2026-09-02T12:01:01.000Z'
    lastRequestId = 'request-fixture-id'
    readyCount = 5
    disconnectCount = 1
    relayedRequestCount = 12
    successfulResponseCount = 11
}

try {
    New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
    [IO.File]::WriteAllText($tokenFile, $connectorToken, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($ownerTokenPath, ('o' * 64), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($policyPath, "{}`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText(
        (Join-Path $releaseRoot 'execution-node-manifest.json'),
        (([ordered]@{ version = 1; releaseId = 'release-fixture'; platform = 'win32-x64'; runtimeMode = 'bundled-node' } | ConvertTo-Json) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )

    $global:McpEvidenceFixtureTask = [pscustomobject]@{
        TaskName = $taskName
        State = 'Running'
        Actions = @([pscustomobject]@{
            Execute = $edgeHostPath
            Arguments = ('--release-root "{0}" --runtime-root "{1}" --edge-base-url "{2}" --connector-token-file "{3}" --owner-token-file "{4}" --policy-path "{5}"' -f $releaseRoot, (Join-Path $fixtureRoot 'runtime'), $edgeBaseUrl, $tokenFile, $ownerTokenPath, $policyPath)
            WorkingDirectory = $releaseRoot
        })
    }
    $global:McpEvidenceFixtureProcesses = @(
        [pscustomobject]@{ ProcessId = 1100; ParentProcessId = 100; Name = 'McpEdgeHost.exe'; ExecutablePath = $edgeHostPath },
        [pscustomobject]@{ ProcessId = 2200; ParentProcessId = 1100; Name = 'node.exe'; ExecutablePath = $nodePath }
    )
    $global:McpEvidenceDiagnosticsShouldFail = $false

    function Get-ScheduledTask {
        param([string]$TaskName, [object]$ErrorAction)
        if ($TaskName -eq $global:McpEvidenceFixtureTask.TaskName) { return $global:McpEvidenceFixtureTask }
        return $null
    }
    function Get-CimInstance {
        param([string]$ClassName, [object]$ErrorAction)
        if ($ClassName -ne 'Win32_Process') { throw "Unexpected CIM class: $ClassName" }
        return $global:McpEvidenceFixtureProcesses
    }
    function Invoke-RestMethod {
        param([string]$Uri, [string]$Method, [hashtable]$Headers, [int]$TimeoutSec, [object]$ErrorAction)
        if ($Uri -eq "$edgeBaseUrl/health") { return $healthFixture }
        if ($Uri -eq "$edgeBaseUrl/_internal/session-diagnostics") {
            if ($global:McpEvidenceDiagnosticsShouldFail) { throw 'fixture unauthorized diagnostics' }
            if ([string]$Headers.Authorization -ne "Bearer $connectorToken") {
                throw 'Collector did not authenticate diagnostics from the connector token file.'
            }
            return [pscustomobject]@{ version = 1; events = @(); runtimeTelemetry = $runtimeTelemetryFixture }
        }
        throw "Unexpected URI: $Uri"
    }

    $output = @(& $collector -TaskName $taskName)
    if ($output.Count -ne 1) { throw "Collector must emit exactly one JSON document. count=$($output.Count)" }
    $jsonText = [string]$output[0]
    if ($jsonText.Contains($connectorToken) -or $jsonText.Contains('Bearer ')) {
        throw 'Collector leaked connector-token material.'
    }
    $evidence = $jsonText | ConvertFrom-Json
    $checks = [ordered]@{
        schemaVersion = ([int]$evidence.schemaVersion -eq 1)
        timestampUtc = (([DateTimeOffset]$evidence.timestampUtc).Offset -eq [TimeSpan]::Zero)
        timestampLocal = (-not [string]::IsNullOrWhiteSpace([string]$evidence.timestampLocal))
        taskFound = ($evidence.scheduledTask.found -eq $true)
        taskState = ([string]$evidence.scheduledTask.state -eq 'Running')
        taskExecute = ([string]$evidence.scheduledTask.execute -eq [IO.Path]::GetFullPath($edgeHostPath))
        taskWorkingDirectory = ([string]$evidence.scheduledTask.workingDirectory -eq [IO.Path]::GetFullPath($releaseRoot))
        releaseId = ([string]$evidence.release.releaseId -eq 'release-fixture')
        releasePath = ([string]$evidence.release.path -eq [IO.Path]::GetFullPath($releaseRoot))
        edgeHostFound = ($evidence.processes.edgeHost.found -eq $true)
        edgeHostPid = ([int]$evidence.processes.edgeHost.pid -eq 1100)
        nodeFound = ($evidence.processes.node.found -eq $true)
        nodePid = ([int]$evidence.processes.node.pid -eq 2200)
        nodeParentPid = ([int]$evidence.processes.node.parentPid -eq 1100)
        nodeDescendant = ($evidence.processes.node.descendsFromMcpEdgeHost -eq $true)
        generation = ([int]$evidence.runtimeTelemetry.connectionGeneration -eq 4)
        requestCount = ([int]$evidence.runtimeTelemetry.relayedRequestCount -eq 12)
        successCount = ([int]$evidence.runtimeTelemetry.successfulResponseCount -eq 11)
        lastRequestId = ([string]$evidence.runtimeTelemetry.lastRequestId -eq 'request-fixture-id')
    }
    $schemaFailures = @($checks.GetEnumerator() | Where-Object { -not [bool]$_.Value } | ForEach-Object { [string]$_.Key })
    if ($schemaFailures.Count -gt 0) {
        throw "Collector returned an unexpected evidence schema: $($schemaFailures -join ', ')"
    }

    $global:McpEvidenceFixtureProcesses = @()
    $missingProcessOutput = @(& $collector -TaskName $taskName)
    $missingProcessEvidence = [string]$missingProcessOutput[0] | ConvertFrom-Json
    if ($missingProcessEvidence.processes.edgeHost.found -ne $false -or
        $missingProcessEvidence.processes.node.found -ne $false) {
        throw 'Collector must represent missing process state without mutating the host.'
    }

    $missingTaskFailed = $false
    try { $null = & $collector -TaskName 'missing-task-fixture' }
    catch {
        $missingTaskFailed = $_.Exception.Message.Contains('Scheduled Task was not found')
    }
    if (-not $missingTaskFailed) {
        throw 'Collector must fail clearly when the canonical Scheduled Task is missing.'
    }

    $global:McpEvidenceFixtureProcesses = @(
        [pscustomobject]@{ ProcessId = 1100; ParentProcessId = 100; Name = 'McpEdgeHost.exe'; ExecutablePath = $edgeHostPath }
    )
    $global:McpEvidenceDiagnosticsShouldFail = $true
    $authFailure = $null
    try { $null = & $collector -TaskName $taskName }
    catch { $authFailure = $_.Exception.Message }
    if ([string]::IsNullOrWhiteSpace([string]$authFailure) -or
        -not $authFailure.Contains('Authenticated session diagnostics request failed') -or
        $authFailure.Contains($connectorToken)) {
        $safeAuthFailure = ([string]$authFailure).Replace($connectorToken, '<redacted>')
        throw "Collector must fail clearly on internal diagnostics authentication failure without leaking the token. actual=$safeAuthFailure"
    }
}
finally {
    Remove-Item Function:\Get-ScheduledTask -ErrorAction SilentlyContinue
    Remove-Item Function:\Get-CimInstance -ErrorAction SilentlyContinue
    Remove-Item Function:\Invoke-RestMethod -ErrorAction SilentlyContinue
    Remove-Variable -Name McpEvidenceFixtureTask -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name McpEvidenceFixtureProcesses -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name McpEvidenceDiagnosticsShouldFail -Scope Global -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}

Write-Output 'Materialization incident evidence collector contract passed.'
