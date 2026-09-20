[CmdletBinding()]
param(
    [ValidateSet('rollback-failure', 'handover-success')]
    [string]$Scenario = 'rollback-failure'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1')

function Write-TestUtf8 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )

    $directory = Split-Path -Parent $Path
    if ($directory) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    [IO.File]::WriteAllText(
        [IO.Path]::GetFullPath($Path),
        $Content,
        [Text.UTF8Encoding]::new($false)
    )
}

function Write-TestDataScript {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 24 -Compress
    $base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    Write-TestUtf8 -Path $Path -Content (
        '$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(''' +
        $base64 +
        '''))' + [Environment]::NewLine +
        '$json | ConvertFrom-Json' + [Environment]::NewLine
    )
}

function Get-TestFreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

function Wait-TestHealth {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [ValidateRange(1, 30)][int]$TimeoutSeconds = 10
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 1 -ErrorAction Stop
        }
        catch {
            Start-Sleep -Milliseconds 200
        }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw "Timed out waiting for test health endpoint: $Uri"
}

function New-TestRelease {
    param(
        [Parameter(Mandatory = $true)][string]$InstallationRoot,
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [Parameter(Mandatory = $true)][string]$Commit
    )

    $release = Join-Path $InstallationRoot "releases\$ReleaseId"
    $windows = Join-Path $release 'deploy\windows'
    New-Item -ItemType Directory -Force -Path $windows | Out-Null

    foreach ($scriptName in @(
        'PublicDistribution.Common.ps1',
        'WindowsExecutionNode.Common.ps1',
        'Invoke-McpWindowsExecutionNodeCutover.ps1',
        'Invoke-McpAccessStackCutoverBroker.ps1'
    )) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $scriptName) -Destination (Join-Path $windows $scriptName)
    }

    $candidateSleeper = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PidFile,
    [Parameter(Mandatory = $true)][string]$HealthStateFile,
    [Parameter(Mandatory = $true)][string]$ReleaseId,
    [Parameter(Mandatory = $true)][string]$ConnectorInstanceId,
    [int]$Port = 0,
    [switch]$PublishHealth,
    [switch]$ServeHealth
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText($PidFile, [string]$PID, [Text.UTF8Encoding]::new($false))
$health = [ordered]@{
    service = 'mcp-edge-gateway'
    controlPlaneReady = $true
    executionPlaneReady = $true
    connectorReady = $true
    contractCompatible = $true
    runtime = [ordered]@{
        connectorInstanceId = $ConnectorInstanceId
        catalogContractRevision = 'rollback-test-contract'
        releaseId = $ReleaseId
    }
}
if ($PublishHealth -or $ServeHealth) {
    [IO.File]::WriteAllText(
        $HealthStateFile,
        (($health | ConvertTo-Json -Depth 6 -Compress) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
}
if (-not $ServeHealth) {
    Start-Sleep -Seconds 300
    return
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$started = $false
for ($attempt = 0; $attempt -lt 30 -and -not $started; $attempt++) {
    try {
        $listener.Start()
        $started = $true
    }
    catch {
        if ($attempt -ge 29) { throw }
        Start-Sleep -Milliseconds 100
    }
}
$body = $health | ConvertTo-Json -Depth 6 -Compress
$payload = [Text.Encoding]::UTF8.GetBytes($body)
$crlf = [string][char]13 + [string][char]10
$headerTerminator = $crlf + $crlf
$headers = 'HTTP/1.1 200 OK' + $crlf +
    'Content-Type: application/json' + $crlf +
    'Content-Length: ' + $payload.Length + $crlf +
    'Connection: close' + $crlf + $crlf
$headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $buffer = [byte[]]::new(4096)
            $request = ''
            do {
                $read = $stream.Read($buffer, 0, $buffer.Length)
                if ($read -le 0) { break }
                $request += [Text.Encoding]::ASCII.GetString($buffer, 0, $read)
            } while ($request.Length -lt 16384 -and -not $request.Contains($headerTerminator))
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            $stream.Write($payload, 0, $payload.Length)
            $stream.Flush()
        }
        finally {
            if ($null -ne $client) { $client.Dispose() }
        }
    }
}
finally {
    $listener.Stop()
}
'@
    Write-TestUtf8 -Path (Join-Path $windows 'Test-CutoverCandidateSleeper.ps1') -Content $candidateSleeper

    $edgeInstaller = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallationRoot,
    [Parameter(Mandatory = $true)][string]$ReleaseId,
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$EdgeBaseUrl,
    [Parameter(Mandatory = $true)][string]$ConnectorTokenFile,
    [Parameter(Mandatory = $true)][string]$OwnerTokenFile,
    [Parameter(Mandatory = $true)][string]$PolicyPath,
    [string]$AllowedOrigins,
    [string]$OwnerOAuthScopes,
    [string]$McpSessionMode,
    [int]$MaxConcurrentRequests,
    [int]$DelaySeconds,
    [string]$TaskName,
    [switch]$EnableBrowserWorker,
    [string]$BrowserWorkerUrl,
    [string]$BrowserWorkerTokenFile,
    [switch]$Execute,
    [switch]$Force,
    [switch]$Activate,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $Execute) { throw 'Test Edge installer requires -Execute.' }

. (Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1')

$releaseRoot = Join-Path $InstallationRoot "releases\$ReleaseId"
$sleeper = Join-Path $releaseRoot 'deploy\windows\Test-CutoverCandidateSleeper.ps1'
$pidFile = Join-Path $InstallationRoot 'state\candidate-task.pid'
$healthStateFile = Join-Path $InstallationRoot 'state\health-state.json'
$connectorInstanceId = if ($TaskName -like '* handover *') {
    'rollback-handover-' + $ReleaseId
}
else {
    'rollback-canonical-' + $ReleaseId
}
$pwsh = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    $sleeper + '" -PidFile "' + $pidFile +
    '" -HealthStateFile "' + $healthStateFile +
    '" -ReleaseId "' + $ReleaseId +
    '" -ConnectorInstanceId "' + $connectorInstanceId + '"'
if ($TaskName -like '* handover *') {
    $arguments += ' -PublishHealth'
}
elseif (Test-Path -LiteralPath (Join-Path $InstallationRoot 'state\handover-success.flag')) {
    $edgeUri = [Uri]$EdgeBaseUrl
    $arguments += ' -ServeHealth -Port ' + [string]$edgeUri.Port
}
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $releaseRoot
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description 'MCP Access Stack isolated rollback-test candidate.'
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
$null = Set-McpWindowsScheduledTaskOwnerAccess -TaskName $TaskName -UserId $userId
if ($Activate) { Enable-ScheduledTask -TaskName $TaskName | Out-Null }
else { Disable-ScheduledTask -TaskName $TaskName | Out-Null }

[pscustomobject]@{
    status = 'installed'
    changed = $true
    activated = [bool]$Activate
    taskName = $TaskName
    releaseId = $ReleaseId
} | ConvertTo-Json -Compress
'@
    Write-TestUtf8 -Path (Join-Path $windows 'Install-McpEdgeConnectorTask.ps1') -Content $edgeInstaller
    Write-TestUtf8 -Path (Join-Path $windows 'Install-McpBrowserWorkerTask.ps1') -Content "param()\r\n"

    foreach ($relative in @(
        'native\McpEdgeHost.exe',
        'compat\McpNodeHostLauncher.exe',
        'compat\McpCredentialBroker.exe',
        'services\browser-worker\dist\server.js',
        'node_modules\@vs-code-gpt\remote-mcp-gateway\dist\edge-connector-cli.js',
        'deploy\windows\Start-McpEdgeConnector.ps1',
        'runtime\node\node.exe'
    )) {
        Write-TestUtf8 -Path (Join-Path $release $relative) -Content ("fixture:" + $ReleaseId + ":" + $relative)
    }

    function New-ArtifactRecord {
        param(
            [Parameter(Mandatory = $true)][string]$Id,
            [Parameter(Mandatory = $true)][string]$Owner,
            [Parameter(Mandatory = $true)][string]$RelativePath,
            [Parameter(Mandatory = $true)][bool]$AuthenticodeRequired
        )

        $path = Join-Path $release ($RelativePath.Replace('/', '\'))
        $item = Get-Item -LiteralPath $path
        return [ordered]@{
            id = $Id
            owner = $Owner
            path = $RelativePath
            sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            sizeBytes = [long]$item.Length
            authenticodeRequired = $AuthenticodeRequired
        }
    }

    $executionManifest = [ordered]@{
        version = 2
        releaseId = $ReleaseId
        commit = $Commit
        platform = 'win32-x64'
        createdAt = '2026-09-19T00:00:00.000Z'
        runtimeMode = 'bundled-node'
        integrityRoot = 'signed-distribution-manifest'
        services = @(
            [ordered]@{ id = 'edge-runtime'; entryArtifactId = 'edge-host' },
            [ordered]@{ id = 'browser-worker'; entryArtifactId = 'browser-native-launcher' }
        )
        artifacts = @(
            (New-ArtifactRecord 'edge-host' 'edge-runtime' 'native/McpEdgeHost.exe' $true),
            (New-ArtifactRecord 'edge-connector' 'edge-runtime' 'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js' $false),
            (New-ArtifactRecord 'edge-validation-launcher' 'edge-runtime' 'deploy/windows/Start-McpEdgeConnector.ps1' $true),
            (New-ArtifactRecord 'browser-worker-server' 'browser-worker' 'services/browser-worker/dist/server.js' $false),
            (New-ArtifactRecord 'browser-native-launcher' 'browser-worker' 'compat/McpNodeHostLauncher.exe' $true),
            (New-ArtifactRecord 'browser-credential-broker' 'browser-worker' 'compat/McpCredentialBroker.exe' $true),
            (New-ArtifactRecord 'node-runtime' 'shared' 'runtime/node/node.exe' $false)
        )
    }
    $executionManifestPath = Join-Path $release 'execution-node-manifest.json'
    Write-TestUtf8 -Path $executionManifestPath -Content (($executionManifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine)

    $releaseFiles = @(
        Get-ChildItem -LiteralPath $release -Recurse -File |
            Where-Object { $_.Name -notin @('manifest.json', 'release-attestation.ps1') } |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    path = [IO.Path]::GetRelativePath($release, $_.FullName).Replace('\', '/')
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
    )
    $releaseManifest = [ordered]@{
        releaseId = $ReleaseId
        version = $ReleaseId
        commit = $Commit
        builtAt = '2026-09-19T00:00:00.000Z'
        nodeVersion = 'v26.7.0'
        testsPassed = $true
        dirty = $false
        executionNode = [ordered]@{
            schemaVersion = 2
            manifestPath = 'execution-node-manifest.json'
            manifestSha256 = (Get-FileHash -LiteralPath $executionManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        fileHashes = $releaseFiles
    }
    $releaseManifestPath = Join-Path $release 'manifest.json'
    Write-TestUtf8 -Path $releaseManifestPath -Content (($releaseManifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine)

    Write-TestDataScript -Path (Join-Path $release 'release-attestation.ps1') -Value ([ordered]@{
        schemaVersion = 2
        releaseId = $ReleaseId
        commit = $Commit
        createdAt = '2026-09-19T00:00:00.000Z'
        manifestSha256 = (Get-FileHash -LiteralPath $releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    })

    return [pscustomobject]@{
        releaseId = $ReleaseId
        releaseRoot = $release
        manifestSha256 = (Get-FileHash -LiteralPath $executionManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Register-TestPreviousTask {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$ServerScript,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [Parameter(Mandatory = $true)][string]$ConnectorInstanceId,
        [Parameter(Mandatory = $true)][string]$PidFile,
        [Parameter(Mandatory = $true)][string]$LogFile,
        [Parameter(Mandatory = $true)][string]$HealthStateFile
    )

    $pwsh = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
        $ServerScript + '" -Port ' + $Port +
        ' -ReleaseId "' + $ReleaseId +
        '" -ConnectorInstanceId "' + $ConnectorInstanceId +
        '" -PidFile "' + $PidFile +
        '" -LogFile "' + $LogFile +
        '" -HealthStateFile "' + $HealthStateFile + '"'
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $WorkingDirectory
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    $task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description 'MCP Access Stack isolated rollback-test previous connector.'
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    $null = Set-McpWindowsScheduledTaskOwnerAccess -TaskName $TaskName -UserId $userId
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Start-ScheduledTask -TaskName $TaskName

    return [pscustomobject]@{
        execute = $pwsh
        arguments = $arguments
        workingDirectory = $WorkingDirectory
        userId = $userId
    }
}

$suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("mcp-cutover-health-rollback-$suffix")
$installation = Join-Path $testRoot 'installation'
$stateRoot = Join-Path $installation 'state'
$runtimeRoot = Join-Path $testRoot 'runtime'
$edgeTaskName = "MCP Access Stack rollback-test-$suffix"
$brokerTaskName = "MCP Access Stack rollback-broker-$suffix"
$previousReleaseId = "rollback-prev-$suffix"
$candidateReleaseId = "rollback-bad-$suffix"
$previousConnectorInstanceId = "rollback-prev-instance-$suffix"
$handoverConnectorInstanceId = "rollback-handover-$candidateReleaseId"
$canonicalConnectorInstanceId = "rollback-canonical-$candidateReleaseId"
$previousPidFile = Join-Path $stateRoot 'previous-task.pid'
$previousLogFile = Join-Path $stateRoot 'previous-task.log'
$candidatePidFile = Join-Path $stateRoot 'candidate-task.pid'
$healthStateFile = Join-Path $stateRoot 'health-state.json'
$port = Get-TestFreeTcpPort
$edgeBaseUrl = "http://127.0.0.1:$port"
$healthUrl = "$edgeBaseUrl/health"

$serverScript = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$ReleaseId,
    [Parameter(Mandatory = $true)][string]$ConnectorInstanceId,
    [Parameter(Mandatory = $true)][string]$PidFile,
    [Parameter(Mandatory = $true)][string]$LogFile,
    [Parameter(Mandatory = $true)][string]$HealthStateFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-ServerLog {
    param([Parameter(Mandatory = $true)][string]$Message)
    [IO.File]::AppendAllText(
        $LogFile,
        ([DateTimeOffset]::UtcNow.ToString('O') + ' ' + $Message + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
}

[IO.File]::WriteAllText($PidFile, [string]$PID, [Text.UTF8Encoding]::new($false))
Write-ServerLog -Message ('started pid=' + [string]$PID + ' port=' + [string]$Port)

$initialHealth = [ordered]@{
    service = 'mcp-edge-gateway'
    controlPlaneReady = $true
    executionPlaneReady = $true
    connectorReady = $true
    contractCompatible = $true
    runtime = [ordered]@{
        connectorInstanceId = $ConnectorInstanceId
        catalogContractRevision = 'rollback-test-contract'
        releaseId = $ReleaseId
    }
}
[IO.File]::WriteAllText(
    $HealthStateFile,
    (($initialHealth | ConvertTo-Json -Depth 6 -Compress) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
)
$crlf = [string][char]13 + [string][char]10
$headerTerminator = $crlf + $crlf

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$listener.Start()
try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 2000
            $client.SendTimeout = 2000
            $stream = $client.GetStream()
            $buffer = [byte[]]::new(4096)
            $request = ''
            do {
                $read = $stream.Read($buffer, 0, $buffer.Length)
                if ($read -le 0) { break }
                $request += [Text.Encoding]::ASCII.GetString($buffer, 0, $read)
            } while ($request.Length -lt 16384 -and -not $request.Contains($headerTerminator))

            $body = (Get-Content -LiteralPath $HealthStateFile -Raw).Trim()
            $payload = [Text.Encoding]::UTF8.GetBytes($body)
            $headers = 'HTTP/1.1 200 OK' + $crlf +
                'Content-Type: application/json' + $crlf +
                'Content-Length: ' + $payload.Length + $crlf +
                'Connection: close' + $crlf + $crlf
            $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            $stream.Write($payload, 0, $payload.Length)
            $stream.Flush()
            Write-ServerLog -Message 'request-served'
        }
        catch {
            Write-ServerLog -Message ('client-error: ' + $_.Exception.ToString())
        }
        finally {
            if ($null -ne $client) { $client.Dispose() }
        }
    }
}
catch {
    Write-ServerLog -Message ('fatal-error: ' + $_.Exception.ToString())
    throw
}
finally {
    $listener.Stop()
    Write-ServerLog -Message 'stopped'
}
'@

try {
    New-Item -ItemType Directory -Force -Path $stateRoot, $runtimeRoot | Out-Null

    $previous = New-TestRelease -InstallationRoot $installation -ReleaseId $previousReleaseId -Commit ('a' * 40)
    $candidate = New-TestRelease -InstallationRoot $installation -ReleaseId $candidateReleaseId -Commit ('b' * 40)

    $now = [DateTimeOffset]::UtcNow.ToString('O')
    $statePath = Join-Path $stateRoot 'lifecycle-state.v1.json'
    Write-TestUtf8 -Path $statePath -Content (([ordered]@{
        version = 1
        active = [ordered]@{
            releaseId = $previous.releaseId
            manifestSha256 = $previous.manifestSha256
            materializedAt = $now
        }
        candidate = [ordered]@{
            releaseId = $candidate.releaseId
            manifestSha256 = $candidate.manifestSha256
            materializedAt = $now
        }
        previous = $null
        updatedAt = $now
    } | ConvertTo-Json -Depth 10) + [Environment]::NewLine)

    $recoveryConfigPath = Join-Path $stateRoot 'edge-task-config.v1.json'
    Write-TestUtf8 -Path $recoveryConfigPath -Content (([ordered]@{
        schemaVersion = 1
        marker = 'rollback-test-previous-config'
        taskName = $edgeTaskName
        releaseId = $previousReleaseId
        edgeBaseUrl = $edgeBaseUrl
    } | ConvertTo-Json -Depth 6) + [Environment]::NewLine)
    $recoveryConfigBefore = Get-Content -LiteralPath $recoveryConfigPath -Raw

    $connectorToken = Join-Path $stateRoot 'connector-token.txt'
    $ownerToken = Join-Path $stateRoot 'owner-token.txt'
    $policyPath = Join-Path $stateRoot 'policy.json'
    Write-TestUtf8 -Path $connectorToken -Content 'rollback-test-connector-token'
    Write-TestUtf8 -Path $ownerToken -Content 'rollback-test-owner-token'
    Write-TestUtf8 -Path $policyPath -Content '{}'
    if ($Scenario -eq 'handover-success') {
        Write-TestUtf8 -Path (Join-Path $stateRoot 'handover-success.flag') -Content 'enabled'
    }

    $serverPath = Join-Path $testRoot 'previous-health-server.ps1'
    Write-TestUtf8 -Path $serverPath -Content $serverScript
    $previousTask = Register-TestPreviousTask -TaskName $edgeTaskName -ServerScript $serverPath -WorkingDirectory $testRoot -Port $port -ReleaseId $previousReleaseId -ConnectorInstanceId $previousConnectorInstanceId -PidFile $previousPidFile -LogFile $previousLogFile -HealthStateFile $healthStateFile

    try {
        $healthBefore = Wait-TestHealth -Uri $healthUrl
    }
    catch {
        $initialTask = Get-ScheduledTask -TaskName $edgeTaskName -ErrorAction SilentlyContinue
        $initialInfo = Get-ScheduledTaskInfo -TaskName $edgeTaskName -ErrorAction SilentlyContinue
        $initialState = if ($initialTask) { [string]$initialTask.State } else { 'missing' }
        $initialPid = if (Test-Path -LiteralPath $previousPidFile -PathType Leaf) {
            (Get-Content -LiteralPath $previousPidFile -Raw).Trim()
        }
        else {
            ''
        }
        $serverLog = if (Test-Path -LiteralPath $previousLogFile -PathType Leaf) {
            (Get-Content -LiteralPath $previousLogFile -Raw).Trim()
        }
        else {
            '<missing>'
        }
        throw (
            'Previous isolated connector did not become healthy before cutover. ' +
            "taskState=$initialState lastTaskResult=$($initialInfo.LastTaskResult) " +
            "lastRunTime=$($initialInfo.LastRunTime.ToString('O')) pid=$initialPid serverLog=$serverLog"
        )
    }
    if ([string]$healthBefore.runtime.connectorInstanceId -ne $previousConnectorInstanceId -or
        [string]$healthBefore.runtime.releaseId -ne $previousReleaseId) {
        throw 'Previous isolated connector returned unexpected health identity before cutover.'
    }
    $taskBeforeBroker = Get-ScheduledTask -TaskName $edgeTaskName -ErrorAction Stop
    $taskInfoBeforeBroker = Get-ScheduledTaskInfo -TaskName $edgeTaskName -ErrorAction Stop
    Write-Output ('PRE_BROKER_TASK_STATE=' + [string]$taskBeforeBroker.State)
    Write-Output ('PRE_BROKER_LAST_RESULT=' + [string]$taskInfoBeforeBroker.LastTaskResult)
    if ([string]$taskBeforeBroker.State -ne 'Running') {
        throw 'Previous isolated connector task was not Running immediately before broker execution.'
    }
    try {
        $healthBeforeSecond = Wait-TestHealth -Uri $healthUrl
    }
    catch {
        $serverLog = if (Test-Path -LiteralPath $previousLogFile -PathType Leaf) {
            (Get-Content -LiteralPath $previousLogFile -Raw).Trim()
        }
        else {
            '<missing>'
        }
        throw ('Previous isolated connector did not survive a second pre-cutover health request. serverLog=' + $serverLog)
    }
    if ([string]$healthBeforeSecond.runtime.connectorInstanceId -ne $previousConnectorInstanceId) {
        throw 'Previous isolated connector returned unexpected identity on the second pre-cutover health request.'
    }
    Remove-Item -LiteralPath $previousPidFile -Force -ErrorAction Stop

    $requestId = [guid]::NewGuid().ToString('D')
    $createdAt = [DateTimeOffset]::UtcNow
    $requestPath = Join-Path $stateRoot 'access-stack-cutover-request.v1.json'
    $request = [ordered]@{
        schemaVersion = 1
        requestId = $requestId
        expectedReleaseId = $candidateReleaseId
        expectedManifestSha256 = $candidate.manifestSha256
        createdAt = $createdAt.ToString('O')
        createdAtUnixTimeMilliseconds = $createdAt.ToUnixTimeMilliseconds()
        handoverDelaySeconds = 1
        projectRoot = $PSScriptRoot
        edge = [ordered]@{
            taskName = $edgeTaskName
            runtimeRoot = $runtimeRoot
            edgeBaseUrl = $edgeBaseUrl
            connectorTokenFile = $connectorToken
            ownerTokenFile = $ownerToken
            policyPath = $policyPath
            allowedOrigins = 'https://chatgpt.com'
            ownerOAuthScopes = 'workspaces:read'
            mcpSessionMode = 'stateless'
            maxConcurrentRequests = 1
            delaySeconds = 0
        }
        browser = [ordered]@{
            enabled = $false
            taskName = "MCP Access Stack rollback-browser-$suffix"
            runtimeRoot = $null
            tokenFile = $null
            privateDirectory = $null
            userDataDirectory = $null
            sitePoliciesPath = $null
            port = 3350
        }
    }
    Write-TestUtf8 -Path $requestPath -Content (($request | ConvertTo-Json -Depth 12) + [Environment]::NewLine)
    $requestSha256 = (Get-FileHash -LiteralPath $requestPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $brokerPath = Join-Path $candidate.releaseRoot 'deploy\windows\Invoke-McpAccessStackCutoverBroker.ps1'
    $pwsh = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $brokerArgs = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', $brokerPath,
        '-InstallationRoot', $installation,
        '-RequestPath', $requestPath,
        '-ExpectedRequestSha256', $requestSha256,
        '-BrokerTaskName', $brokerTaskName,
        '-AllowUnsignedDevelopment'
    )
    $brokerOutput = (& $pwsh @brokerArgs 2>&1 | Out-String).Trim()
    $brokerExitCode = $LASTEXITCODE
    $resultPath = Join-Path $stateRoot "access-stack-cutover-runs\$requestId\result.json"
    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
        throw 'Broker completion did not persist result.json.'
    }
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json

    if ($Scenario -eq 'handover-success') {
        if ($brokerExitCode -ne 0 -or [string]$result.status -ne 'passed') {
            throw "Broker handover success scenario failed. exitCode=$brokerExitCode result=$($result | ConvertTo-Json -Depth 8 -Compress) output=$brokerOutput"
        }
        if ([string]$result.healthGate.connectorInstanceId -ne $canonicalConnectorInstanceId) {
            throw "Canonical connector did not become final owner: $($result.healthGate.connectorInstanceId)"
        }

        $stateAfterSuccess = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ([string]$stateAfterSuccess.active.releaseId -ne $candidateReleaseId -or
            $null -ne $stateAfterSuccess.candidate -or
            [string]$stateAfterSuccess.previous.releaseId -ne $previousReleaseId) {
            throw 'Successful handover lifecycle state is inconsistent.'
        }

        $handoverTasksAfterSuccess = @(Get-ScheduledTask -TaskName ($edgeTaskName + ' handover *') -ErrorAction SilentlyContinue)
        if ($handoverTasksAfterSuccess.Count -ne 0) {
            throw "Handover Scheduled Task remained after successful cutover: $($handoverTasksAfterSuccess.TaskName -join ', ')"
        }
        $canonicalTask = Get-ScheduledTask -TaskName $edgeTaskName -ErrorAction Stop
        if ([string]$canonicalTask.State -ne 'Running') {
            throw "Canonical candidate task is not Running after successful handover: $($canonicalTask.State)"
        }
        $healthAfterSuccess = Wait-TestHealth -Uri $healthUrl
        if ([string]$healthAfterSuccess.runtime.connectorInstanceId -ne $canonicalConnectorInstanceId -or
            [string]$healthAfterSuccess.runtime.releaseId -ne $candidateReleaseId) {
            throw 'Canonical candidate did not answer health after successful handover.'
        }

        [pscustomobject]@{
            status = 'passed'
            scenario = 'zero-gap-handover-success'
            brokerExitCode = $brokerExitCode
            resultStatus = [string]$result.status
            handoverConnectorInstanceId = $handoverConnectorInstanceId
            canonicalConnectorInstanceId = [string]$result.healthGate.connectorInstanceId
            activeReleaseId = [string]$stateAfterSuccess.active.releaseId
            previousReleaseId = [string]$stateAfterSuccess.previous.releaseId
            handoverTaskRemoved = $true
            canonicalTaskRunning = $true
            canonicalHealthResponding = $true
        } | ConvertTo-Json -Depth 8
        return
    }

    if ($brokerExitCode -eq 0) {
        throw 'Broker unexpectedly succeeded despite the deliberately unavailable canonical candidate health endpoint.'
    }
    if ([string]$result.status -ne 'failed') {
        throw "Broker failure result must be failed, got: $($result.status)"
    }
    if ([string]$result.error -notlike '*Edge post-cutover health gate failed*') {
        throw "Broker failure did not preserve health-gate cause: $($result.error)"
    }
    if ([string]$result.failureStage -ne 'post-cutover-health') {
        throw "Broker failure stage mismatch: $($result.failureStage)"
    }
    if ([string]$result.failureCode -ne 'CUTOVER_POST_HEALTH_FAILED') {
        throw "Broker failure code mismatch: $($result.failureCode)"
    }
    if ($null -eq $result.rollback -or
        $result.rollback.attempted -ne $true -or
        [string]$result.rollback.status -ne 'passed' -or
        [string]$result.rollback.restoredReleaseId -ne $previousReleaseId) {
        throw ('Broker rollback telemetry mismatch: ' + ($result.rollback | ConvertTo-Json -Compress))
    }

    $stateAfter = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ([string]$stateAfter.active.releaseId -ne $previousReleaseId -or
        [string]$stateAfter.candidate.releaseId -ne $candidateReleaseId -or
        $null -ne $stateAfter.previous) {
        throw 'Lifecycle state was not rolled back to previous active with failed candidate preserved.'
    }

    $recoveryConfigAfter = Get-Content -LiteralPath $recoveryConfigPath -Raw
    if ($recoveryConfigAfter -ne $recoveryConfigBefore) {
        throw 'Previous recovery configuration changed during failed post-cutover health gate.'
    }

    $restoredTask = Get-ScheduledTask -TaskName $edgeTaskName -ErrorAction Stop
    $restoredActions = @($restoredTask.Actions)
    if ($restoredActions.Count -ne 1 -or
        [IO.Path]::GetFullPath([string]$restoredActions[0].Execute) -ne [IO.Path]::GetFullPath([string]$previousTask.execute) -or
        [string]$restoredActions[0].Arguments -ne [string]$previousTask.arguments -or
        [string]$restoredActions[0].WorkingDirectory -ne [string]$previousTask.workingDirectory) {
        throw 'Previous Scheduled Task action was not restored after failed health gate.'
    }

    $restoredInfo = Get-ScheduledTaskInfo -TaskName $edgeTaskName -ErrorAction Stop
    $restoredPid = $null
    if (Test-Path -LiteralPath $previousPidFile -PathType Leaf) {
        $restoredPid = (Get-Content -LiteralPath $previousPidFile -Raw).Trim()
    }
    Write-Output ('BROKER_RESULT_ERROR=' + [string]$result.error)
    Write-Output ('RESTORED_TASK_STATE=' + [string]$restoredTask.State)
    Write-Output ('RESTORED_TASK_LAST_RESULT=' + [string]$restoredInfo.LastTaskResult)
    Write-Output ('RESTORED_PID=' + [string]$restoredPid)

    try {
        $healthAfter = Wait-TestHealth -Uri $healthUrl
    }
    catch {
        $restoredTask = Get-ScheduledTask -TaskName $edgeTaskName -ErrorAction SilentlyContinue
        $state = if ($restoredTask) { [string]$restoredTask.State } else { 'missing' }
        $restoredPidRunning = $false
        if (-not [string]::IsNullOrWhiteSpace([string]$restoredPid)) {
            $restoredPidRunning = [bool](Get-Process -Id ([int]$restoredPid) -ErrorAction SilentlyContinue)
        }
        throw (
            'Previous release did not respond after automatic rollback. ' +
            "taskState=$state lastTaskResult=$($restoredInfo.LastTaskResult) " +
            "lastRunTime=$($restoredInfo.LastRunTime.ToString('O')) restoredPid=$restoredPid " +
            "restoredPidRunning=$restoredPidRunning resultError=$([string]$result.error) " +
            "brokerOutput=$([string]$brokerOutput)"
        )
    }
    if ([string]$healthAfter.runtime.connectorInstanceId -ne $previousConnectorInstanceId -or
        [string]$healthAfter.runtime.releaseId -ne $previousReleaseId) {
        throw 'Previous release health response identity changed after automatic rollback.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$restoredPid)) {
        throw 'Previous Scheduled Task was restored but did not start a new process instance.'
    }

    $candidatePid = if (Test-Path -LiteralPath $candidatePidFile) {
        [int](Get-Content -LiteralPath $candidatePidFile -Raw)
    }
    else {
        $null
    }
    if ($candidatePid -and (Get-Process -Id $candidatePid -ErrorAction SilentlyContinue)) {
        throw "Candidate Scheduled Task process remained orphaned after rollback: PID=$candidatePid"
    }
    $handoverTasksAfter = @(Get-ScheduledTask -TaskName ($edgeTaskName + ' handover *') -ErrorAction SilentlyContinue)
    if ($handoverTasksAfter.Count -ne 0) {
        throw "Handover Scheduled Task remained after rollback: $($handoverTasksAfter.TaskName -join ', ')"
    }
    $candidateProcessesAfter = @(
        Get-CimInstance Win32_Process |
            Where-Object {
                [string]$_.CommandLine -like ('*' + $testRoot + '*Test-CutoverCandidateSleeper.ps1*')
            }
    )
    if ($candidateProcessesAfter.Count -ne 0) {
        throw "Candidate process remained after rollback: $($candidateProcessesAfter.ProcessId -join ', ')"
    }
    if (Test-Path -LiteralPath $requestPath) {
        throw 'Consumed cutover request remained pending after broker completion.'
    }

    [pscustomobject]@{
        status = 'passed'
        scenario = 'post-cutover-health-failure-automatic-rollback'
        brokerExitCode = $brokerExitCode
        resultStatus = [string]$result.status
        failureStage = [string]$result.failureStage
        failureCode = [string]$result.failureCode
        rollbackAttempted = [bool]$result.rollback.attempted
        rollbackStatus = [string]$result.rollback.status
        rollbackRestoredReleaseId = [string]$result.rollback.restoredReleaseId
        resultError = [string]$result.error
        activeReleaseId = [string]$stateAfter.active.releaseId
        preservedCandidateReleaseId = [string]$stateAfter.candidate.releaseId
        scheduledTaskRestored = $true
        recoveryConfigRestored = $true
        previousReleaseResponding = $true
        candidateProcessOrphaned = $false
        pendingRequest = $false
        brokerOutput = $brokerOutput
    } | ConvertTo-Json -Depth 8
}
finally {
    $handoverTasks = @(Get-ScheduledTask -TaskName ($edgeTaskName + ' handover *') -ErrorAction SilentlyContinue)
    foreach ($handoverTask in $handoverTasks) {
        if ([string]$handoverTask.State -eq 'Running') {
            Stop-ScheduledTask -TaskName ([string]$handoverTask.TaskName) -ErrorAction SilentlyContinue
        }
        Unregister-ScheduledTask -TaskName ([string]$handoverTask.TaskName) -Confirm:$false -ErrorAction SilentlyContinue
    }

    $candidateProcesses = @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                [string]$_.CommandLine -like ('*' + $testRoot + '*Test-CutoverCandidateSleeper.ps1*')
            }
    )
    foreach ($candidateProcess in $candidateProcesses) {
        Stop-Process -Id ([int]$candidateProcess.ProcessId) -Force -ErrorAction SilentlyContinue
    }

    $task = Get-ScheduledTask -TaskName $edgeTaskName -ErrorAction SilentlyContinue
    if ($task) {
        if ([string]$task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $edgeTaskName -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 300
        }
        Unregister-ScheduledTask -TaskName $edgeTaskName -Confirm:$false -ErrorAction SilentlyContinue
    }

    foreach ($pidFile in @($previousPidFile, $candidatePidFile)) {
        if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { continue }
        $processId = 0
        if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw), [ref]$processId) -and $processId -gt 0) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }

    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
