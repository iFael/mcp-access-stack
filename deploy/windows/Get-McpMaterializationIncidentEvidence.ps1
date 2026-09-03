[CmdletBinding()]
param(
    [string]$TaskName = 'MCP Access Stack production edge-connector',

    [ValidateRange(1, 120)]
    [int]$HttpTimeoutSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-McpEvidenceTaskArguments {
    param([Parameter(Mandatory = $true)][string]$Arguments)

    $result = [ordered]@{}
    $pattern = '(?<key>--[a-z0-9-]+)\s+(?:"(?<quoted>[^"]*)"|(?<bare>\S+))'
    foreach ($match in [regex]::Matches($Arguments, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        $key = [string]$match.Groups['key'].Value
        $value = if ($match.Groups['quoted'].Success) {
            [string]$match.Groups['quoted'].Value
        }
        else {
            [string]$match.Groups['bare'].Value
        }
        if ($result.Contains($key)) {
            throw "Scheduled Task contains a duplicate Edge Connector argument: $key"
        }
        $result[$key] = $value
    }
    return $result
}

function Get-McpEvidenceRequiredArgument {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Arguments,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if (-not $Arguments.Contains($Name) -or [string]::IsNullOrWhiteSpace([string]$Arguments[$Name])) {
        throw "Scheduled Task is missing required Edge Connector argument: $Name"
    }
    return [string]$Arguments[$Name]
}

function Read-McpEvidenceConnectorToken {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw 'Connector token file required for authenticated session diagnostics was not found.'
    }
    $item = Get-Item -LiteralPath $resolved
    if ($item.Length -le 0 -or $item.Length -gt 4096) {
        throw 'Connector token file required for authenticated session diagnostics has an invalid size.'
    }
    $token = [IO.File]::ReadAllText($resolved, [Text.Encoding]::UTF8).Trim()
    if ($token.Length -lt 32 -or $token.Length -gt 2048 -or $token -match '[\r\n\0]') {
        throw 'Connector token file required for authenticated session diagnostics is invalid.'
    }
    return $token
}

function Get-McpEvidenceOptionalProperty {
    param(
        [AllowNull()][object]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-McpEvidenceDescendant {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][int]$AncestorProcessId,
        [Parameter(Mandatory = $true)][hashtable]$ProcessById
    )

    $visited = [Collections.Generic.HashSet[int]]::new()
    $currentId = $ProcessId
    while ($currentId -gt 0 -and $visited.Add($currentId)) {
        if (-not $ProcessById.ContainsKey($currentId)) { return $false }
        $current = $ProcessById[$currentId]
        $parentId = [int]$current.ParentProcessId
        if ($parentId -eq $AncestorProcessId) { return $true }
        $currentId = $parentId
    }
    return $false
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    throw "Scheduled Task was not found: $TaskName"
}
$actions = @($task.Actions)
if ($actions.Count -ne 1) {
    throw "Scheduled Task must contain exactly one Edge Connector action: $TaskName"
}
$action = $actions[0]
$execute = [IO.Path]::GetFullPath([string]$action.Execute)
$workingDirectory = [IO.Path]::GetFullPath([string]$action.WorkingDirectory)
$taskArguments = Get-McpEvidenceTaskArguments -Arguments ([string]$action.Arguments)
$releaseRoot = [IO.Path]::GetFullPath((Get-McpEvidenceRequiredArgument -Arguments $taskArguments -Name '--release-root'))
$edgeBaseUrlText = Get-McpEvidenceRequiredArgument -Arguments $taskArguments -Name '--edge-base-url'
$connectorTokenFile = [IO.Path]::GetFullPath((Get-McpEvidenceRequiredArgument -Arguments $taskArguments -Name '--connector-token-file'))

try {
    $edgeUri = [Uri]$edgeBaseUrlText
}
catch {
    throw 'Scheduled Task Edge base URL is invalid.'
}
if (-not $edgeUri.IsAbsoluteUri -or
    $edgeUri.Scheme -ne 'https' -or
    -not [string]::IsNullOrWhiteSpace($edgeUri.UserInfo) -or
    $edgeUri.AbsolutePath -ne '/' -or
    -not [string]::IsNullOrWhiteSpace($edgeUri.Query) -or
    -not [string]::IsNullOrWhiteSpace($edgeUri.Fragment)) {
    throw 'Scheduled Task Edge base URL must be a credential-free HTTPS origin.'
}
$edgeOrigin = $edgeUri.GetLeftPart([UriPartial]::Authority)

$releaseManifestPath = Join-Path $releaseRoot 'execution-node-manifest.json'
$releaseManifest = $null
$releaseId = $null
$expectedNodePath = Join-Path $releaseRoot 'runtime\node\node.exe'
if (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf) {
    try {
        $releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw | ConvertFrom-Json
        $releaseId = Get-McpEvidenceOptionalProperty -InputObject $releaseManifest -Name 'releaseId'
        $nodeRecords = @(@(Get-McpEvidenceOptionalProperty -InputObject $releaseManifest -Name 'artifacts') | Where-Object {
            [string](Get-McpEvidenceOptionalProperty -InputObject $_ -Name 'role') -eq 'node-runtime'
        })
        if ($nodeRecords.Count -eq 1) {
            $relativeNodePath = [string](Get-McpEvidenceOptionalProperty -InputObject $nodeRecords[0] -Name 'path')
            if (-not [string]::IsNullOrWhiteSpace($relativeNodePath)) {
                $candidateNodePath = [IO.Path]::GetFullPath((Join-Path $releaseRoot ($relativeNodePath.Replace('/', '\'))))
                $releasePrefix = $releaseRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
                if ($candidateNodePath.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
                    $expectedNodePath = $candidateNodePath
                }
            }
        }
    }
    catch {
        throw 'Edge Connector execution-node manifest could not be read for incident evidence.'
    }
}
if ([string]::IsNullOrWhiteSpace([string]$releaseId)) {
    $releaseId = Split-Path -Leaf $releaseRoot
}

$allProcesses = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)
$processById = @{}
foreach ($process in $allProcesses) {
    $pidValue = [int](Get-McpEvidenceOptionalProperty -InputObject $process -Name 'ProcessId')
    if ($pidValue -gt 0) { $processById[$pidValue] = $process }
}
$edgeHostCandidates = @($allProcesses | Where-Object {
    $candidatePath = [string](Get-McpEvidenceOptionalProperty -InputObject $_ -Name 'ExecutablePath')
    -not [string]::IsNullOrWhiteSpace($candidatePath) -and
        [IO.Path]::GetFullPath($candidatePath) -eq $execute
})
$edgeHost = if ($edgeHostCandidates.Count -gt 0) { $edgeHostCandidates[0] } else { $null }
$edgeHostPid = if ($null -eq $edgeHost) { $null } else { [int]$edgeHost.ProcessId }
$edgeHostParentPid = if ($null -eq $edgeHost) { $null } else { [int]$edgeHost.ParentProcessId }

$nodeCandidates = @($allProcesses | Where-Object {
    $candidatePath = [string](Get-McpEvidenceOptionalProperty -InputObject $_ -Name 'ExecutablePath')
    -not [string]::IsNullOrWhiteSpace($candidatePath) -and
        [IO.Path]::GetFullPath($candidatePath) -eq [IO.Path]::GetFullPath($expectedNodePath)
})
$node = $null
if ($null -ne $edgeHostPid) {
    foreach ($candidate in $nodeCandidates) {
        if (Test-McpEvidenceDescendant -ProcessId ([int]$candidate.ProcessId) -AncestorProcessId ([int]$edgeHostPid) -ProcessById $processById) {
            $node = $candidate
            break
        }
    }
}
if ($null -eq $node -and $nodeCandidates.Count -gt 0) { $node = $nodeCandidates[0] }
$nodePid = if ($null -eq $node) { $null } else { [int]$node.ProcessId }
$nodeParentPid = if ($null -eq $node) { $null } else { [int]$node.ParentProcessId }
$nodeDescendsFromHost = if ($null -eq $node -or $null -eq $edgeHostPid) {
    $false
}
else {
    Test-McpEvidenceDescendant -ProcessId ([int]$node.ProcessId) -AncestorProcessId ([int]$edgeHostPid) -ProcessById $processById
}

try {
    $health = Invoke-RestMethod -Uri "$edgeOrigin/health" -Method Get -TimeoutSec $HttpTimeoutSeconds -ErrorAction Stop
}
catch {
    throw 'Public Edge health request failed while collecting materialization incident evidence.'
}

$connectorToken = Read-McpEvidenceConnectorToken -Path $connectorTokenFile
try {
    try {
        $diagnostics = Invoke-RestMethod `
            -Uri "$edgeOrigin/_internal/session-diagnostics" `
            -Method Get `
            -Headers @{ Authorization = "Bearer $connectorToken" } `
            -TimeoutSec $HttpTimeoutSeconds `
            -ErrorAction Stop
    }
    catch {
        throw 'Authenticated session diagnostics request failed while collecting materialization incident evidence.'
    }
}
finally {
    $connectorToken = $null
}
$runtimeTelemetry = Get-McpEvidenceOptionalProperty -InputObject $diagnostics -Name 'runtimeTelemetry'
if ($null -eq $runtimeTelemetry) {
    throw 'Authenticated session diagnostics response did not contain runtimeTelemetry.'
}

$now = [DateTimeOffset]::Now
$argumentNames = @($taskArguments.Keys | Sort-Object)
$evidence = [ordered]@{
    schemaVersion = 1
    timestampUtc = $now.UtcDateTime.ToString('O')
    timestampLocal = $now.ToString('O')
    scheduledTask = [ordered]@{
        found = $true
        name = [string]$TaskName
        state = [string]$task.State
        execute = $execute
        workingDirectory = $workingDirectory
        argumentNames = $argumentNames
    }
    release = [ordered]@{
        releaseId = [string]$releaseId
        path = $releaseRoot
        manifestPath = $releaseManifestPath
        manifestFound = [bool](Test-Path -LiteralPath $releaseManifestPath -PathType Leaf)
    }
    processes = [ordered]@{
        edgeHost = [ordered]@{
            found = $null -ne $edgeHost
            pid = $edgeHostPid
            parentPid = $edgeHostParentPid
            candidateCount = $edgeHostCandidates.Count
        }
        node = [ordered]@{
            found = $null -ne $node
            pid = $nodePid
            parentPid = $nodeParentPid
            candidateCount = $nodeCandidates.Count
            descendsFromMcpEdgeHost = [bool]$nodeDescendsFromHost
        }
    }
    health = $health
    runtimeTelemetry = $runtimeTelemetry
    edgeRequests = [ordered]@{
        lastRequestAt = Get-McpEvidenceOptionalProperty -InputObject $runtimeTelemetry -Name 'lastRequestAt'
        relayedRequestCount = Get-McpEvidenceOptionalProperty -InputObject $runtimeTelemetry -Name 'relayedRequestCount'
        lastSuccessfulRequestAt = Get-McpEvidenceOptionalProperty -InputObject $runtimeTelemetry -Name 'lastSuccessfulRequestAt'
        successfulResponseCount = Get-McpEvidenceOptionalProperty -InputObject $runtimeTelemetry -Name 'successfulResponseCount'
    }
    connector = [ordered]@{
        connectorInstanceId = Get-McpEvidenceOptionalProperty -InputObject $runtimeTelemetry -Name 'connectorInstanceId'
        connectionGeneration = Get-McpEvidenceOptionalProperty -InputObject $runtimeTelemetry -Name 'connectionGeneration'
    }
    catalog = [ordered]@{
        contractRevision = Get-McpEvidenceOptionalProperty -InputObject $runtimeTelemetry -Name 'catalogContractRevision'
        toolSetRevision = Get-McpEvidenceOptionalProperty -InputObject $runtimeTelemetry -Name 'toolSetRevision'
        toolCount = Get-McpEvidenceOptionalProperty -InputObject $runtimeTelemetry -Name 'toolCount'
        serverVersion = Get-McpEvidenceOptionalProperty -InputObject $runtimeTelemetry -Name 'serverVersion'
    }
}

$evidence | ConvertTo-Json -Depth 12 -Compress
