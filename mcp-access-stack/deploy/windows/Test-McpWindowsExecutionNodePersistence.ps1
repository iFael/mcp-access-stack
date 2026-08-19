[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$builderPath = Join-Path $PSScriptRoot 'New-McpWindowsExecutionNodeArtifacts.ps1'
$taskInstallerPath = Join-Path $PSScriptRoot 'Install-McpWindowsExecutionNodeHostTask.ps1'
$cutoverPath = Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeCutover.ps1'
$cutoverTaskInstallerPath = Join-Path $PSScriptRoot 'Install-McpWindowsExecutionNodeCutoverTask.ps1'
$hostSourcePath = Join-Path $root 'tooling\windows-execution-node\McpHost.cs'
$persistenceSourcePath = Join-Path $root 'tooling\windows-execution-node\McpHostPersistence.cs'

$hostSource = Get-Content -LiteralPath $hostSourcePath -Raw
$persistenceSource = Get-Content -LiteralPath $persistenceSourcePath -Raw
$taskInstaller = Get-Content -LiteralPath $taskInstallerPath -Raw
$cutover = Get-Content -LiteralPath $cutoverPath -Raw

foreach ($required in @(
    'mcp-host-contract-v3',
    '--run-active',
    'installation-root'
)) {
    if (-not $hostSource.Contains($required)) {
        throw "Persistent McpHost CLI contract is missing: $required"
    }
}
foreach ($required in @(
    'host-ownership-',
    'Stable McpHost does not match the active release McpHost artifact.',
    'Another persistent McpHost already owns this execution-node environment.',
    'ExecutionNodeSupervisor.Run'
)) {
    if (-not $persistenceSource.Contains($required)) {
        throw "Persistent McpHost ownership contract is missing: $required"
    }
}
foreach ($required in @(
    'New-ScheduledTaskAction',
    '-Execute $stableHostPath',
    '--run-active',
    'New-ScheduledTaskTrigger -AtLogOn',
    '-LogonType Interactive',
    '-MultipleInstances IgnoreNew'
)) {
    if (-not $taskInstaller.Contains($required)) {
        throw "Persistent host Scheduled Task contract is missing: $required"
    }
}
foreach ($forbidden in @(
    'McpNodeHostLauncher.exe',
    'Run-DockerHostComponent.mjs',
    "-Execute 'pwsh.exe'",
    "-Execute 'powershell.exe'"
)) {
    if ($taskInstaller.Contains($forbidden)) {
        throw "Persistent host Scheduled Task reintroduced a legacy/generic runner: $forbidden"
    }
}
foreach ($required in @(
    'Disable-McpLegacyOwnership',
    'Invoke-McpStateTransition',
    'Sync-McpStableHost',
    'Wait-McpPersistentReady',
    'Restore-McpLegacyOwnership',
    'Restore-McpStateSnapshot',
    'Enter-McpWindowsExecutionNodeOperationMutex',
    'EdgeOnly'
)) {
    if (-not $cutover.Contains($required)) {
        throw "Execution-node cutover contract is missing: $required"
    }
}

$plan = (& $taskInstallerPath `
    -InstallationRoot (Join-Path ([IO.Path]::GetTempPath()) 'mcp-stage6-plan-install') `
    -ProjectRoot (Join-Path ([IO.Path]::GetTempPath()) 'mcp-stage6-plan-project') `
    -Environment production) | ConvertFrom-Json
if ([string]$plan.status -ne 'planned' -or
    [string]$plan.plan.execute -notlike '*\host\McpHost.exe' -or
    [string]$plan.plan.arguments -notlike '*--run-active*' -or
    [string]$plan.plan.arguments -like '*McpNodeHostLauncher*' -or
    [string]$plan.plan.logonType -ne 'Interactive' -or
    [string]$plan.plan.multipleInstances -ne 'IgnoreNew') {
    throw 'Persistent host Scheduled Task plan is not stable/direct/interactive.'
}

$executionNodeCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
. $executionNodeCommonPath
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (Test-McpWindowsAccountIdentityEquivalent `
    -Left $currentIdentity.Name `
    -Right $currentIdentity.User.Value)) {
    throw 'Scheduled Task account identity comparison must accept equivalent account name and SID forms.'
}
if (Test-McpWindowsAccountIdentityEquivalent `
    -Left $currentIdentity.Name `
    -Right 'S-1-5-21-0-0-0-999999999') {
    throw 'Scheduled Task account identity comparison accepted a different SID.'
}
if ([string]$env:GITHUB_ACTIONS -ne 'true') {
    Write-Output 'Execution-node persistent ownership static contract passed; Scheduled Task/cutover smoke is GitHub-only.'
    return
}

$testRoot = Join-Path $env:RUNNER_TEMP ('mcp-stage6-persistence-' + [guid]::NewGuid().ToString('N'))
$buildFixture = Join-Path $testRoot 'build-release'
$buildOutput = Join-Path $testRoot 'build-output'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$taskNames = [System.Collections.Generic.List[string]]::new()

function Write-TestUtf8 {
    param([string]$Path, [AllowEmptyString()][string]$Content)
    $parent = Split-Path -Parent $Path
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function New-TestDataScript {
    param([object]$Value, [string]$Path)
    $json = $Value | ConvertTo-Json -Depth 20 -Compress
    $base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $content = @(
        '$json = [Text.Encoding]::UTF8.GetString(',
        "    [Convert]::FromBase64String('$base64')",
        ')',
        '$json | ConvertFrom-Json'
    ) -join [Environment]::NewLine
    Write-TestUtf8 -Path $Path -Content ($content + [Environment]::NewLine)
}

function Get-FreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
}

function New-TestPointer {
    param([string]$ReleaseRoot, [string]$ReleaseId)
    return [ordered]@{
        releaseId = $ReleaseId
        manifestSha256 = (Get-FileHash -LiteralPath (Join-Path $ReleaseRoot 'execution-node-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        materializedAt = [DateTimeOffset]::UtcNow.ToString('O')
    }
}

function Write-TestState {
    param([string]$InstallationRoot, [AllowNull()][object]$Active, [AllowNull()][object]$Candidate, [AllowNull()][object]$Previous)
    $path = Join-Path $InstallationRoot 'state\lifecycle-state.v1.json'
    Write-TestUtf8 -Path $path -Content (([ordered]@{
        version = 1
        active = $Active
        candidate = $Candidate
        previous = $Previous
        updatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    } | ConvertTo-Json -Depth 12) + [Environment]::NewLine)
}

function New-TestPrivateConfiguration {
    param([string]$ProjectRoot, [int]$BrowserPort)
    $configRoot = Join-Path $ProjectRoot '.runtime-private\docker\production'
    $policyPath = Join-Path $ProjectRoot 'policy.json'
    $dataRoot = Join-Path $ProjectRoot 'agent-data'
    New-Item -ItemType Directory -Force -Path $configRoot, $dataRoot | Out-Null
    Write-TestUtf8 -Path $policyPath -Content "{}`n"
    Write-TestUtf8 -Path (Join-Path $configRoot 'agent.json') -Content (([ordered]@{
        gatewayUrl = 'ws://127.0.0.1:65534/agent'
        agentId = 'stage6-ci-agent'
        token = 'stage6-ci-token'
        policyPath = $policyPath
        dataDirectory = $dataRoot
        maxPayloadBytes = 1048576
        maxConcurrentSynchronousShells = 2
        qualifiedCommand = [ordered]@{
            qualifiedExecution = $false
            safeAutoCorrection = $false
            shadowMode = $false
            providerEnabled = $false
            workspaceAllowlist = @()
            providerTimeoutMs = 20000
        }
    } | ConvertTo-Json -Depth 10) + "`n")
    Write-TestUtf8 -Path (Join-Path $configRoot 'browser.json') -Content (([ordered]@{
        port = $BrowserPort
        token = 'stage6-ci-browser-token'
        mode = 'interactive'
        browserChannel = 'chromium'
        userDataDirectory = (Join-Path $ProjectRoot 'browser-profile')
        runtimeDirectory = (Join-Path $ProjectRoot 'browser-runtime')
        privateDirectory = (Join-Path $ProjectRoot 'browser-private')
        maxPayloadBytes = 1048576
        maxOwnedTabs = 8
        maxConcurrentTabs = 4
        idempotencyTtlMs = 60000
        idempotencyMaxEntries = 256
        connectTimeoutMs = 5000
        operationTimeoutMs = 5000
        actionTimeoutMs = 5000
        navigationTimeoutMs = 5000
        outputMaxBytes = 1048576
        diagnosticTimeoutMs = 5000
    } | ConvertTo-Json -Depth 10) + "`n")
}

function New-TestRelease {
    param(
        [string]$InstallationRoot,
        [string]$ReleaseId,
        [string]$Commit,
        [string]$BuiltHostPath
    )
    $release = Join-Path $InstallationRoot "releases\$ReleaseId"
    foreach ($directory in @(
        'native', 'compat', 'services\workspace-agent\dist',
        'services\browser-worker\dist', 'services\mcp-gateway\dist', 'deploy\windows', 'runtime\node'
    )) {
        New-Item -ItemType Directory -Force -Path (Join-Path $release $directory) | Out-Null
    }
    Copy-Item -LiteralPath $BuiltHostPath -Destination (Join-Path $release 'native\McpHost.exe')
    Copy-Item -LiteralPath $nodePath -Destination (Join-Path $release 'runtime\node\node.exe')
    Write-TestUtf8 -Path (Join-Path $release 'compat\McpNodeHostLauncher.exe') -Content 'legacy-launcher-fixture'
    Write-TestUtf8 -Path (Join-Path $release 'compat\McpCredentialBroker.exe') -Content 'credential-broker-fixture'
    Write-TestUtf8 -Path (Join-Path $release 'services\workspace-agent\dist\cli.js') -Content @'
process.stderr.write(JSON.stringify({ event: 'connected', pid: process.pid }) + '\n');
setInterval(() => {}, 1000);
'@
    Write-TestUtf8 -Path (Join-Path $release 'services\mcp-gateway\dist\edge-connector-cli.js') -Content "setInterval(() => {}, 1000);`n"
    Write-TestUtf8 -Path (Join-Path $release 'deploy\windows\Start-McpEdgeConnector.ps1') -Content "Write-Output 'edge-launcher-fixture'`n"
    Write-TestUtf8 -Path (Join-Path $release 'services\browser-worker\dist\server.js') -Content @'
const http = require('node:http');
const port = Number(process.env.BROWSER_WORKER_PORT);
http.createServer((request, response) => {
  if (request.url === '/health/live' || request.url === '/health/ready') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ready' }));
    return;
  }
  response.writeHead(404); response.end();
}).listen(port, '127.0.0.1');
setInterval(() => {}, 1000);
'@

    function New-ArtifactRecord {
        param([string]$Role, [string]$RelativePath, [bool]$AuthenticodeRequired)
        $path = Join-Path $release ($RelativePath.Replace('/', '\'))
        $item = Get-Item -LiteralPath $path
        return [ordered]@{
            role = $Role
            path = $RelativePath
            sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            sizeBytes = [long]$item.Length
            authenticodeRequired = $AuthenticodeRequired
        }
    }
    $execution = [ordered]@{
        version = 1
        releaseId = $ReleaseId
        commit = $Commit
        platform = 'win32-x64'
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        runtimeMode = 'bundled-node'
        integrityRoot = 'signed-distribution-manifest'
        artifacts = @(
            (New-ArtifactRecord 'mcp-host' 'native/McpHost.exe' $true),
            (New-ArtifactRecord 'workspace-agent' 'services/workspace-agent/dist/cli.js' $false),
            (New-ArtifactRecord 'browser-worker' 'services/browser-worker/dist/server.js' $false),
            (New-ArtifactRecord 'edge-connector' 'services/mcp-gateway/dist/edge-connector-cli.js' $false),
            (New-ArtifactRecord 'edge-connector-launcher' 'deploy/windows/Start-McpEdgeConnector.ps1' $false),
            (New-ArtifactRecord 'node-runtime' 'runtime/node/node.exe' $false)
        )
    }
    $executionPath = Join-Path $release 'execution-node-manifest.json'
    Write-TestUtf8 -Path $executionPath -Content (($execution | ConvertTo-Json -Depth 16) + "`n")

    $releaseFiles = @(
        Get-ChildItem -LiteralPath $release -Recurse -File |
            Where-Object { $_.Name -notin @('manifest.json', 'release-attestation.ps1') } |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    path = $_.FullName.Substring($release.Length).TrimStart('\', '/').Replace('\', '/')
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
    )
    $manifest = [ordered]@{
        releaseId = $ReleaseId
        version = $ReleaseId
        commit = $Commit
        builtAt = [DateTimeOffset]::UtcNow.ToString('O')
        nodeVersion = (& (Join-Path $release 'runtime\node\node.exe') --version)[0]
        testsPassed = $true
        dirty = $false
        executionNode = [ordered]@{
            schemaVersion = 1
            manifestPath = 'execution-node-manifest.json'
            manifestSha256 = (Get-FileHash -LiteralPath $executionPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        fileHashes = $releaseFiles
    }
    $manifestPath = Join-Path $release 'manifest.json'
    Write-TestUtf8 -Path $manifestPath -Content (($manifest | ConvertTo-Json -Depth 20) + "`n")
    New-TestDataScript -Path (Join-Path $release 'release-attestation.ps1') -Value ([ordered]@{
        schemaVersion = 1
        releaseId = $ReleaseId
        commit = $Commit
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        manifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        dockerImages = @(
            [ordered]@{ component='gateway'; repository='ghcr.io/example/gateway'; digest=('sha256:' + ('a' * 64)); platform='linux/amd64' },
            [ordered]@{ component='proxy'; repository='ghcr.io/example/proxy'; digest=('sha256:' + ('b' * 64)); platform='linux/amd64' }
        )
    })
    return $release
}

function Register-TestLegacyTask {
    param([string]$TaskName, [string]$ScriptPath)
    $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $action = New-ScheduledTaskAction -Execute $nodePath -Argument ('"' + $ScriptPath + '"') -WorkingDirectory (Split-Path -Parent $ScriptPath)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Stage 6 legacy ownership fixture.'
    Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null
    $taskNames.Add($TaskName)
    Start-ScheduledTask -TaskName $TaskName
}

function Wait-TaskState {
    param([string]$TaskName, [string]$Expected, [int]$Seconds = 20)
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task -and [string]$task.State -eq $Expected) { return }
        Start-Sleep -Milliseconds 200
    }
    throw "Task $TaskName did not reach state $Expected."
}

function Wait-ReadyHealth {
    param([string]$Path, [string]$ReleaseId, [int]$Seconds = 30)
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $Path) {
            try {
                $health = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
                if ([string]$health.status -eq 'ready' -and
                    [string]$health.releaseId -eq $ReleaseId -and
                    [string]$health.contractVersion -eq 'mcp-host-contract-v3' -and
                    $health.agent.ready -eq $true -and
                    $health.browserWorker.ready -eq $true) {
                    return $health
                }
            }
            catch {}
        }
        Start-Sleep -Milliseconds 200
    }
    throw "Persistent host did not become ready for $ReleaseId."
}

function Wait-CutoverBrokerResult {
    param([string]$Path, [int]$Seconds = 60)
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            try {
                $result = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
                if ([string]$result.status -in @('passed','failed')) { return $result }
            }
            catch {}
        }
        Start-Sleep -Milliseconds 200
    }
    throw "Detached cutover broker did not persist a terminal result: $Path"
}

function Remove-TestTask {
    param([string]$TaskName)
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        if ([string]$task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}

try {
    New-Item -ItemType Directory -Force -Path `
        (Join-Path $buildFixture 'tooling\windows-host-launcher'), `
        (Join-Path $buildFixture 'tooling\windows-credential-broker') | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'tooling\windows-host-launcher\McpNodeHostLauncher.cs') -Destination (Join-Path $buildFixture 'tooling\windows-host-launcher\McpNodeHostLauncher.cs')
    Copy-Item -LiteralPath (Join-Path $root 'tooling\windows-credential-broker\McpCredentialBroker.cs') -Destination (Join-Path $buildFixture 'tooling\windows-credential-broker\McpCredentialBroker.cs')
    Write-TestUtf8 -Path (Join-Path $buildFixture 'manifest.json') -Content (([ordered]@{ releaseId='stage6-build'; commit=('c' * 40) } | ConvertTo-Json) + "`n")
    $buildJson = & pwsh -NoLogo -NoProfile -File $builderPath -ReleaseRoot $buildFixture -ReleaseId 'stage6-build' -SourceCommit ('c' * 40) -OutputDirectory $buildOutput
    if ($LASTEXITCODE -ne 0) { throw 'Stage 6 McpHost native build failed.' }
    $build = $buildJson | ConvertFrom-Json
    if ([string]$build.status -ne 'built') { throw 'Stage 6 McpHost native build evidence is invalid.' }
    $builtHost = Join-Path $buildOutput 'McpHost.exe'
    $builtBroker = Join-Path $buildOutput 'McpCredentialBroker.exe'
    $version = @(& $builtHost --version)
    if ($LASTEXITCODE -ne 0 -or [string]$version[0] -ne 'mcp-host-contract-v3') {
        throw 'Stage 6 McpHost did not compile as contract v3.'
    }

    # Successful first cutover: legacy Tasks -> one stable persistent host.
    $successRoot = Join-Path $testRoot 'success'
    $installation = Join-Path $successRoot 'installation'
    $project = Join-Path $successRoot 'project'
    New-Item -ItemType Directory -Force -Path (Join-Path $installation 'state'), (Join-Path $installation 'releases'), $project | Out-Null
    New-TestPrivateConfiguration -ProjectRoot $project -BrowserPort (Get-FreeTcpPort)
    $releaseId = 'stage6-cutover-b'
    $release = New-TestRelease -InstallationRoot $installation -ReleaseId $releaseId -Commit ('d' * 40) -BuiltHostPath $builtHost
    Write-TestState -InstallationRoot $installation -Active $null -Candidate (New-TestPointer -ReleaseRoot $release -ReleaseId $releaseId) -Previous $null
    $hostFixtureRoot = Join-Path $installation 'host'
    New-Item -ItemType Directory -Force -Path $hostFixtureRoot | Out-Null
    Copy-Item -LiteralPath $builtBroker -Destination (Join-Path $hostFixtureRoot 'McpCredentialBroker.exe')

    $legacyScript = Join-Path $successRoot 'legacy-owner.js'
    Write-TestUtf8 -Path $legacyScript -Content "setInterval(() => {}, 1000);`n"
    $suffix = [guid]::NewGuid().ToString('N')
    $legacyAgentTask = "MCP Stage6 CI legacy agent $suffix"
    $legacyBrowserTask = "MCP Stage6 CI legacy browser $suffix"
    $persistentTask = "MCP Stage6 CI host $suffix"
    $cutoverBrokerTask = "MCP Stage6 CI cutover $suffix"
    Register-TestLegacyTask -TaskName $legacyAgentTask -ScriptPath $legacyScript
    Register-TestLegacyTask -TaskName $legacyBrowserTask -ScriptPath $legacyScript
    Wait-TaskState -TaskName $legacyAgentTask -Expected 'Running'
    Wait-TaskState -TaskName $legacyBrowserTask -Expected 'Running'

    $cutoverTaskInstall = (& $cutoverTaskInstallerPath `
        -InstallationRoot $installation `
        -ProjectRoot $project `
        -Environment production `
        -TaskName $cutoverBrokerTask `
        -PersistentTaskName $persistentTask `
        -LegacyAgentTaskName $legacyAgentTask `
        -LegacyBrowserTaskName $legacyBrowserTask `
        -Execute `
        -Force `
        -AllowUnsignedDevelopment) | ConvertFrom-Json
    if ([string]$cutoverTaskInstall.status -ne 'installed' -or $cutoverTaskInstall.independentOwner -ne $true) {
        throw 'Detached cutover Task installer did not return independent-owner evidence.'
    }
    $taskNames.Add($cutoverBrokerTask)
    $taskNames.Add($persistentTask)
    $requestScript = Join-Path (Split-Path -Parent ([string]$cutoverTaskInstall.brokerPath)) 'Request-McpWindowsExecutionNodeCutover.ps1'
    $requestOutput = & pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $requestScript `
        -InstallationRoot $installation `
        -ProjectRoot $project `
        -Environment production `
        -Operation Promote `
        -ExpectedReleaseId $releaseId `
        -HealthTimeoutSeconds 40 `
        -TaskName $cutoverBrokerTask `
        -Execute `
        -AllowUnsignedDevelopment
    if ($LASTEXITCODE -ne 0) { throw 'Detached cutover request process failed.' }
    $request = $requestOutput | ConvertFrom-Json
    if ([string]$request.status -ne 'started' -or $request.detached -ne $true) {
        throw 'Detached cutover request did not return STARTED evidence.'
    }
    $cutoverBrokerResult = Wait-CutoverBrokerResult -Path ([string]$request.resultPath) -Seconds 60
    if ([string]$cutoverBrokerResult.status -ne 'passed') {
        throw ('Detached cutover broker failed: ' + [string]$cutoverBrokerResult.error)
    }
    $cutoverResult = $cutoverBrokerResult.cutover
    if ([string]$cutoverResult.status -ne 'cutover-ready' -or
        [string]$cutoverResult.activeReleaseId -ne $releaseId) {
        throw 'Stage 6 cutover did not return READY evidence.'
    }
    if ([string](Get-ScheduledTask -TaskName $legacyAgentTask).State -ne 'Disabled' -or
        [string](Get-ScheduledTask -TaskName $legacyBrowserTask).State -ne 'Disabled') {
        throw 'Legacy ownership Tasks were not disabled after successful cutover.'
    }
    Wait-TaskState -TaskName $persistentTask -Expected 'Running'
    $reinstall = (& $taskInstallerPath `
        -InstallationRoot $installation `
        -ProjectRoot $project `
        -Environment production `
        -TaskName $persistentTask `
        -CredentialBrokerPath (Join-Path $hostFixtureRoot 'McpCredentialBroker.exe') `
        -Execute `
        -Activate `
        -AllowUnsignedDevelopment) | ConvertFrom-Json
    if ([string]$reinstall.status -ne 'already-installed' -or $reinstall.changed -ne $false) {
        throw 'Persistent host task reinstall did not recognize the existing equivalent Windows principal.'
    }
    $healthPath = Join-Path $project 'runtime\windows-execution-node\production\host-state.json'
    $ready = Wait-ReadyHealth -Path $healthPath -ReleaseId $releaseId

    $persistentAction = @((Get-ScheduledTask -TaskName $persistentTask).Actions)
    $stableHost = Join-Path $installation 'host\McpHost.exe'
    if ($persistentAction.Count -ne 1 -or
        [string]$persistentAction[0].Execute -ne $stableHost -or
        [string]$persistentAction[0].Arguments -notlike '*--run-active*' -or
        [string]$persistentAction[0].Arguments -like '*McpNodeHostLauncher*') {
        throw 'Persistent Scheduled Task is not a direct stable McpHost owner.'
    }

    # A second persistent host must fail before spawning another Agent/Browser tree.
    $duplicateInfo = [Diagnostics.ProcessStartInfo]::new()
    $duplicateInfo.FileName = $stableHost
    $duplicateInfo.UseShellExecute = $false
    $duplicateInfo.CreateNoWindow = $true
    $duplicateInfo.RedirectStandardError = $true
    foreach ($argument in @(
        '--run-active', '--installation-root', $installation,
        '--project-root', $project, '--environment', 'production'
    )) { $null = $duplicateInfo.ArgumentList.Add([string]$argument) }
    $duplicate = [Diagnostics.Process]::Start($duplicateInfo)
    $duplicate.WaitForExit(10000) | Out-Null
    $duplicateError = $duplicate.StandardError.ReadToEnd()
    if (-not $duplicate.HasExited -or $duplicate.ExitCode -eq 0 -or
        $duplicateError -notlike '*already owns this execution-node environment*') {
        if (-not $duplicate.HasExited) { $duplicate.Kill() }
        throw 'Persistent ownership lock did not reject a second McpHost.'
    }
    $duplicate.Dispose()

    # Reboot-equivalent recovery: same stable Task + same active state starts a new host cleanly.
    $firstHostPid = [int]$ready.pid
    Stop-ScheduledTask -TaskName $persistentTask
    Wait-TaskState -TaskName $persistentTask -Expected 'Ready'
    $exitDeadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
    while ([DateTimeOffset]::UtcNow -lt $exitDeadline -and (Get-Process -Id $firstHostPid -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 200
    }
    if (Get-Process -Id $firstHostPid -ErrorAction SilentlyContinue) {
        throw 'Persistent McpHost did not exit when its Task was stopped.'
    }
    Remove-Item -LiteralPath $healthPath -Force -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $persistentTask
    $recovered = Wait-ReadyHealth -Path $healthPath -ReleaseId $releaseId
    if ([int]$recovered.pid -eq $firstHostPid) {
        throw 'Persistent host reboot-equivalent recovery did not create a new host process.'
    }

    # Edge-only cutover: promote lifecycle and retire an existing Host task without recreating it.
    $edgeRoot = Join-Path $testRoot 'edge-only'
    $edgeInstallation = Join-Path $edgeRoot 'installation'
    $edgeProject = Join-Path $edgeRoot 'project'
    New-Item -ItemType Directory -Force -Path (Join-Path $edgeInstallation 'state'), (Join-Path $edgeInstallation 'releases'), $edgeProject | Out-Null
    $edgeReleaseId = 'stage6-edge-only'
    $edgeRelease = New-TestRelease -InstallationRoot $edgeInstallation -ReleaseId $edgeReleaseId -Commit ('f' * 40) -BuiltHostPath $builtHost
    Write-TestState -InstallationRoot $edgeInstallation -Active $null -Candidate (New-TestPointer -ReleaseRoot $edgeRelease -ReleaseId $edgeReleaseId) -Previous $null
    $edgeHostRoot = Join-Path $edgeInstallation 'host'
    New-Item -ItemType Directory -Force -Path $edgeHostRoot | Out-Null
    Copy-Item -LiteralPath $builtBroker -Destination (Join-Path $edgeHostRoot 'McpCredentialBroker.exe')

    $edgeSuffix = [guid]::NewGuid().ToString('N')
    $edgePersistentTask = "MCP Stage6 CI edge host $edgeSuffix"
    $edgeCutoverTask = "MCP Stage6 CI edge cutover $edgeSuffix"
    $edgeLegacyScript = Join-Path $edgeRoot 'old-host.js'
    Write-TestUtf8 -Path $edgeLegacyScript -Content "setInterval(() => {}, 1000);`n"
    Register-TestLegacyTask -TaskName $edgePersistentTask -ScriptPath $edgeLegacyScript
    Wait-TaskState -TaskName $edgePersistentTask -Expected 'Running'
    $taskNames.Add($edgePersistentTask)

    $edgeCutoverInstall = (& $cutoverTaskInstallerPath `
        -InstallationRoot $edgeInstallation `
        -ProjectRoot $edgeProject `
        -Environment production `
        -TaskName $edgeCutoverTask `
        -PersistentTaskName $edgePersistentTask `
        -LegacyAgentTaskName "MCP Stage6 CI edge legacy agent $edgeSuffix" `
        -LegacyBrowserTaskName "MCP Stage6 CI edge legacy browser $edgeSuffix" `
        -EdgeOnly `
        -Execute `
        -Force `
        -AllowUnsignedDevelopment) | ConvertFrom-Json
    if ([string]$edgeCutoverInstall.status -ne 'installed' -or $edgeCutoverInstall.edgeOnly -ne $true) {
        throw 'Edge-only cutover Task installer did not return edge-only evidence.'
    }
    $taskNames.Add($edgeCutoverTask)
    $edgeCutoverAction = @((Get-ScheduledTask -TaskName $edgeCutoverTask).Actions)
    if ($edgeCutoverAction.Count -ne 1 -or
        [string]$edgeCutoverAction[0].Arguments -notlike '*-NonInteractive*' -or
        [string]$edgeCutoverAction[0].Arguments -notlike '*-WindowStyle Hidden*' -or
        [string]$edgeCutoverAction[0].Arguments -notlike '*-EdgeOnly*') {
        throw 'Edge-only cutover Task does not use the hidden/non-interactive EdgeOnly broker contract.'
    }

    $edgeRequestScript = Join-Path (Split-Path -Parent ([string]$edgeCutoverInstall.brokerPath)) 'Request-McpWindowsExecutionNodeCutover.ps1'
    $edgeRequestOutput = & pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $edgeRequestScript `
        -InstallationRoot $edgeInstallation `
        -ProjectRoot $edgeProject `
        -Environment production `
        -Operation Promote `
        -ExpectedReleaseId $edgeReleaseId `
        -HealthTimeoutSeconds 40 `
        -TaskName $edgeCutoverTask `
        -Execute `
        -AllowUnsignedDevelopment
    if ($LASTEXITCODE -ne 0) { throw 'Edge-only detached cutover request process failed.' }
    $edgeRequest = $edgeRequestOutput | ConvertFrom-Json
    $edgeBrokerResult = Wait-CutoverBrokerResult -Path ([string]$edgeRequest.resultPath) -Seconds 60
    if ([string]$edgeBrokerResult.status -ne 'passed') {
        throw ('Edge-only detached cutover broker failed: ' + [string]$edgeBrokerResult.error)
    }
    $edgeCutover = $edgeBrokerResult.cutover
    if ([string]$edgeCutover.status -ne 'cutover-ready' -or
        [string]$edgeCutover.ownershipMode -ne 'edge-only' -or
        [string]$edgeCutover.activeReleaseId -ne $edgeReleaseId -or
        [int]$edgeCutover.persistentHostPid -ne 0 -or
        [string]$edgeCutover.taskStatus -ne 'retired-edge-only') {
        throw 'Edge-only cutover did not return the expected lifecycle/ownership evidence.'
    }
    if (Get-ScheduledTask -TaskName $edgePersistentTask -ErrorAction SilentlyContinue) {
        throw 'Edge-only cutover recreated or retained the persistent Host task.'
    }
    $edgeState = Get-Content -LiteralPath (Join-Path $edgeInstallation 'state\lifecycle-state.v1.json') -Raw | ConvertFrom-Json
    if ($null -eq $edgeState.active -or
        [string]$edgeState.active.releaseId -ne $edgeReleaseId -or
        $null -ne $edgeState.candidate) {
        throw 'Edge-only cutover did not commit the expected lifecycle state.'
    }

    # Failed first cutover after state commit must restore pre-cutover state + legacy ownership.
    $failureRoot = Join-Path $testRoot 'failure'
    $failureInstallation = Join-Path $failureRoot 'installation'
    $failureProject = Join-Path $failureRoot 'project'
    New-Item -ItemType Directory -Force -Path (Join-Path $failureInstallation 'state'), (Join-Path $failureInstallation 'releases'), $failureProject | Out-Null
    New-TestPrivateConfiguration -ProjectRoot $failureProject -BrowserPort (Get-FreeTcpPort)
    $failureReleaseId = 'stage6-cutover-failure'
    $failureRelease = New-TestRelease -InstallationRoot $failureInstallation -ReleaseId $failureReleaseId -Commit ('e' * 40) -BuiltHostPath $builtHost
    $failureCandidate = New-TestPointer -ReleaseRoot $failureRelease -ReleaseId $failureReleaseId
    Write-TestState -InstallationRoot $failureInstallation -Active $null -Candidate $failureCandidate -Previous $null

    $failureLegacyScript = Join-Path $failureRoot 'legacy-owner.js'
    Write-TestUtf8 -Path $failureLegacyScript -Content "setInterval(() => {}, 1000);`n"
    $failureSuffix = [guid]::NewGuid().ToString('N')
    $failureAgentTask = "MCP Stage6 CI fallback agent $failureSuffix"
    $failureBrowserTask = "MCP Stage6 CI fallback browser $failureSuffix"
    $failurePersistentTask = "MCP Stage6 CI fallback host $failureSuffix"
    Register-TestLegacyTask -TaskName $failureAgentTask -ScriptPath $failureLegacyScript
    Register-TestLegacyTask -TaskName $failureBrowserTask -ScriptPath $failureLegacyScript
    Wait-TaskState -TaskName $failureAgentTask -Expected 'Running'
    Wait-TaskState -TaskName $failureBrowserTask -Expected 'Running'

    $fallbackObserved = $false
    try {
        & $cutoverPath `
            -InstallationRoot $failureInstallation `
            -ProjectRoot $failureProject `
            -Environment production `
            -Operation Promote `
            -PersistentTaskName $failurePersistentTask `
            -LegacyAgentTaskName $failureAgentTask `
            -LegacyBrowserTaskName $failureBrowserTask `
            -CredentialBrokerPath (Join-Path $failureRoot 'missing-broker.exe') `
            -HealthTimeoutSeconds 40 `
            -Execute `
            -AllowUnsignedDevelopment | Out-Null
    }
    catch {
        $fallbackObserved = $true
    }
    if (-not $fallbackObserved) {
        throw 'Stage 6 fallback fixture unexpectedly completed cutover.'
    }
    $restoredState = Get-Content -LiteralPath (Join-Path $failureInstallation 'state\lifecycle-state.v1.json') -Raw | ConvertFrom-Json
    if ($null -ne $restoredState.active -or
        $null -eq $restoredState.candidate -or
        [string]$restoredState.candidate.releaseId -ne $failureReleaseId) {
        throw 'Failed first cutover did not restore the pre-cutover execution-node state.'
    }
    Wait-TaskState -TaskName $failureAgentTask -Expected 'Running'
    Wait-TaskState -TaskName $failureBrowserTask -Expected 'Running'
    if (Get-ScheduledTask -TaskName $failurePersistentTask -ErrorAction SilentlyContinue) {
        throw 'Failed first cutover left a newly-created persistent host Task registered.'
    }

    Write-Output 'Execution-node persistent ownership/cutover smoke passed host ownership, EdgeOnly retirement, restart recovery and legacy fallback.'
}
finally {
    foreach ($taskName in @($taskNames)) {
        Remove-TestTask -TaskName $taskName
    }
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
