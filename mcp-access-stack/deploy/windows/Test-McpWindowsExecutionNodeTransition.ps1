[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$transition = Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeTransition.ps1'
$builder = Join-Path $PSScriptRoot 'New-McpWindowsExecutionNodeArtifacts.ps1'
$transitionSource = Get-Content -LiteralPath $transition -Raw

foreach ($required in @(
    "ValidateSet('Promote', 'Rollback')",
    'state.lock',
    'Assert-McpWindowsExecutionNodeRelease',
    'executionManifestSha256',
    'healthValidated',
    'qualificationHostRetained = $false',
    'candidate = $null',
    'previous = $sourcePointer',
    'candidate = $sourcePointer',
    'State remains unchanged on any pre-commit health or validation failure',
    'qualification-owner-pid'
)) {
    if (-not $transitionSource.Contains($required)) {
        throw "Execution-node transition contract is missing: $required"
    }
}
foreach ($forbidden in @(
    'Invoke-Expression',
    'cmd.exe',
    'powershell.exe',
    'pwsh.exe',
    'Run-DockerHostComponent.mjs'
)) {
    if ($transitionSource.Contains($forbidden)) {
        throw "Execution-node transition must not expose a generic runner path: $forbidden"
    }
}

if ([string]$env:GITHUB_ACTIONS -ne 'true') {
    Write-Output 'Execution-node transition static contract passed; transactional runtime smoke is GitHub-only.'
    return
}

$testRoot = Join-Path $env:RUNNER_TEMP ('mcp-execution-node-transition-' + [guid]::NewGuid().ToString('N'))
$projectRoot = Join-Path $testRoot 'project root'
$installationRoot = Join-Path $testRoot 'installation root'
$releasesRoot = Join-Path $installationRoot 'releases'
$stateRoot = Join-Path $installationRoot 'state'
$configurationRoot = Join-Path $projectRoot '.runtime-private\docker\production'
$buildRelease = Join-Path $testRoot 'build release'
$buildOutput = Join-Path $testRoot 'native build'
$environmentName = 'production'

function Write-TestUtf8 {
    param([string]$Path, [AllowEmptyString()][string]$Content)
    $parent = Split-Path -Parent $Path
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($Path), $Content, [Text.UTF8Encoding]::new($false))
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
    try {
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

function New-ReleasePointer {
    param([string]$ReleaseId, [string]$ReleaseRoot)
    return [ordered]@{
        releaseId = $ReleaseId
        manifestSha256 = (Get-FileHash -LiteralPath (Join-Path $ReleaseRoot 'execution-node-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        materializedAt = [DateTimeOffset]::UtcNow.ToString('O')
    }
}

function Write-State {
    param([AllowNull()][object]$Active, [AllowNull()][object]$Candidate, [AllowNull()][object]$Previous)
    Write-TestUtf8 -Path (Join-Path $stateRoot 'lifecycle-state.v1.json') -Content (([ordered]@{
        version = 1
        active = $Active
        candidate = $Candidate
        previous = $Previous
        updatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    } | ConvertTo-Json -Depth 12) + [Environment]::NewLine)
}

function New-TestRelease {
    param(
        [string]$ReleaseId,
        [string]$Commit,
        [string]$HostPath,
        [string]$NodePath,
        [bool]$BrowserHealthy
    )

    $release = Join-Path $releasesRoot $ReleaseId
    New-Item -ItemType Directory -Force -Path `
        (Join-Path $release 'native'), `
        (Join-Path $release 'compat'), `
        (Join-Path $release 'services\workspace-agent\dist'), `
        (Join-Path $release 'services\browser-worker\dist'), `
        (Join-Path $release 'runtime\node') | Out-Null
    Copy-Item -LiteralPath $HostPath -Destination (Join-Path $release 'native\McpHost.exe')
    Copy-Item -LiteralPath $NodePath -Destination (Join-Path $release 'runtime\node\node.exe')
    Write-TestUtf8 -Path (Join-Path $release 'compat\McpNodeHostLauncher.exe') -Content "compat-launcher-$ReleaseId"
    Write-TestUtf8 -Path (Join-Path $release 'compat\McpCredentialBroker.exe') -Content "compat-broker-$ReleaseId"

    $agentScript = @'
process.stderr.write(JSON.stringify({ event: 'connected', pid: process.pid }) + '\n');
setInterval(() => {}, 1000);
'@
    Write-TestUtf8 -Path (Join-Path $release 'services\workspace-agent\dist\cli.js') -Content ($agentScript + "`n")

    if ($BrowserHealthy) {
        $browserScript = @'
const http = require('node:http');
const port = Number(process.env.BROWSER_WORKER_PORT);
const server = http.createServer((request, response) => {
  if (request.url === '/health/live' || request.url === '/health/ready') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ready' }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(port, '127.0.0.1');
setInterval(() => {}, 1000);
'@
    }
    else {
        $browserScript = @'
const http = require('node:http');
const port = Number(process.env.BROWSER_WORKER_PORT);
const server = http.createServer((request, response) => {
  response.writeHead(request.url === '/health/live' ? 200 : 503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ status: request.url === '/health/live' ? 'live' : 'not-ready' }));
});
server.listen(port, '127.0.0.1');
setInterval(() => {}, 1000);
'@
    }
    Write-TestUtf8 -Path (Join-Path $release 'services\browser-worker\dist\server.js') -Content ($browserScript + "`n")

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

    $executionManifest = [ordered]@{
        version = 1
        releaseId = $ReleaseId
        commit = $Commit
        platform = 'win32-x64'
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        runtimeMode = 'bundled-node'
        integrityRoot = 'signed-distribution-manifest'
        artifacts = @(
            (New-ArtifactRecord -Role 'mcp-host' -RelativePath 'native/McpHost.exe' -AuthenticodeRequired $true),
            (New-ArtifactRecord -Role 'workspace-agent' -RelativePath 'services/workspace-agent/dist/cli.js' -AuthenticodeRequired $false),
            (New-ArtifactRecord -Role 'browser-worker' -RelativePath 'services/browser-worker/dist/server.js' -AuthenticodeRequired $false),
            (New-ArtifactRecord -Role 'node-runtime' -RelativePath 'runtime/node/node.exe' -AuthenticodeRequired $false)
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
                    path = $_.FullName.Substring($release.Length).TrimStart('\', '/').Replace('\', '/')
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
    )
    $releaseManifest = [ordered]@{
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
            manifestSha256 = (Get-FileHash -LiteralPath $executionManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        fileHashes = $releaseFiles
    }
    $releaseManifestPath = Join-Path $release 'manifest.json'
    Write-TestUtf8 -Path $releaseManifestPath -Content (($releaseManifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine)

    New-TestDataScript -Path (Join-Path $release 'release-attestation.ps1') -Value ([ordered]@{
        schemaVersion = 1
        releaseId = $ReleaseId
        commit = $Commit
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        manifestSha256 = (Get-FileHash -LiteralPath $releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        dockerImages = @(
            [ordered]@{ component = 'gateway'; repository = 'ghcr.io/example/gateway'; digest = ('sha256:' + ('a' * 64)); platform = 'linux/amd64' },
            [ordered]@{ component = 'proxy'; repository = 'ghcr.io/example/proxy'; digest = ('sha256:' + ('b' * 64)); platform = 'linux/amd64' }
        )
    })
    return $release
}

try {
    New-Item -ItemType Directory -Force -Path $releasesRoot, $stateRoot, $configurationRoot | Out-Null

    $nodeSource = (Get-Command node -ErrorAction Stop).Source
    $browserPort = Get-FreeTcpPort
    $policyPath = Join-Path $projectRoot 'policy.json'
    $dataDirectory = Join-Path $projectRoot 'agent-data'
    $browserUserData = Join-Path $projectRoot 'browser-profile'
    $browserRuntime = Join-Path $projectRoot 'browser-runtime'
    $browserPrivate = Join-Path $projectRoot 'browser-private'
    New-Item -ItemType Directory -Force -Path $dataDirectory, $browserUserData, $browserRuntime, $browserPrivate | Out-Null
    Write-TestUtf8 -Path $policyPath -Content "{}`n"

    $agentConfig = [ordered]@{
        gatewayUrl = 'ws://127.0.0.1:65534/agent'
        agentId = 'ci-transition-agent'
        token = 'fixture-agent-token'
        policyPath = $policyPath
        dataDirectory = $dataDirectory
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
    }
    Write-TestUtf8 -Path (Join-Path $configurationRoot 'agent.json') -Content (($agentConfig | ConvertTo-Json -Depth 8) + "`n")
    $browserConfig = [ordered]@{
        port = $browserPort
        token = 'fixture-browser-token'
        mode = 'interactive'
        browserChannel = 'chromium'
        userDataDirectory = $browserUserData
        runtimeDirectory = $browserRuntime
        privateDirectory = $browserPrivate
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
    }
    Write-TestUtf8 -Path (Join-Path $configurationRoot 'browser.json') -Content (($browserConfig | ConvertTo-Json -Depth 8) + "`n")

    New-Item -ItemType Directory -Force -Path `
        (Join-Path $buildRelease 'tooling\windows-host-launcher'), `
        (Join-Path $buildRelease 'tooling\windows-credential-broker') | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'tooling\windows-host-launcher\McpNodeHostLauncher.cs') -Destination (Join-Path $buildRelease 'tooling\windows-host-launcher\McpNodeHostLauncher.cs')
    Copy-Item -LiteralPath (Join-Path $root 'tooling\windows-credential-broker\McpCredentialBroker.cs') -Destination (Join-Path $buildRelease 'tooling\windows-credential-broker\McpCredentialBroker.cs')
    Write-TestUtf8 -Path (Join-Path $buildRelease 'manifest.json') -Content (([ordered]@{ releaseId = 'ci-transition-build'; commit = ('f' * 40) } | ConvertTo-Json) + "`n")

    $buildJson = & pwsh -NoLogo -NoProfile -File $builder `
        -ReleaseRoot $buildRelease `
        -ReleaseId 'ci-transition-build' `
        -SourceCommit ('f' * 40) `
        -OutputDirectory $buildOutput
    if ($LASTEXITCODE -ne 0) {
        throw 'Execution-node transition native host build failed.'
    }
    $buildResult = $buildJson | ConvertFrom-Json
    if ([string]$buildResult.status -ne 'built') {
        throw 'Execution-node transition native host build returned unexpected evidence.'
    }
    $hostPath = Join-Path $buildOutput 'McpHost.exe'

    $releaseA = New-TestRelease -ReleaseId '1.2.0-a' -Commit ('a' * 40) -HostPath $hostPath -NodePath $nodeSource -BrowserHealthy $true
    $releaseB = New-TestRelease -ReleaseId '1.2.0-b' -Commit ('b' * 40) -HostPath $hostPath -NodePath $nodeSource -BrowserHealthy $true
    $releaseC = New-TestRelease -ReleaseId '1.2.0-c' -Commit ('c' * 40) -HostPath $hostPath -NodePath $nodeSource -BrowserHealthy $false
    $pointerA = New-ReleasePointer -ReleaseId '1.2.0-a' -ReleaseRoot $releaseA
    $pointerB = New-ReleasePointer -ReleaseId '1.2.0-b' -ReleaseRoot $releaseB
    $pointerC = New-ReleasePointer -ReleaseId '1.2.0-c' -ReleaseRoot $releaseC

    # Healthy candidate promotion commits only after the target host reaches ready.
    Write-State -Active $pointerA -Candidate $pointerB -Previous $null
    $promote = (& $transition `
        -InstallationRoot $installationRoot `
        -ProjectRoot $projectRoot `
        -Environment $environmentName `
        -Operation Promote `
        -HealthTimeoutSeconds 15 `
        -RestartCount 0 `
        -RestartIntervalSeconds 1 `
        -ReadinessTimeoutSeconds 5 `
        -Execute `
        -AllowUnsignedDevelopment) | ConvertFrom-Json
    if ([string]$promote.status -ne 'promoted' -or
        $promote.healthValidated -ne $true -or
        $promote.qualificationHostRetained -ne $false -or
        [string]$promote.activeReleaseId -ne '1.2.0-b' -or
        [string]$promote.previousReleaseId -ne '1.2.0-a' -or
        $null -ne $promote.candidateReleaseId) {
        throw 'Healthy execution-node promotion returned unexpected evidence.'
    }
    $stateAfterPromote = Get-Content -LiteralPath (Join-Path $stateRoot 'lifecycle-state.v1.json') -Raw | ConvertFrom-Json
    if ([string]$stateAfterPromote.active.releaseId -ne '1.2.0-b' -or
        [string]$stateAfterPromote.previous.releaseId -ne '1.2.0-a' -or
        $null -ne $stateAfterPromote.candidate) {
        throw 'Healthy promotion did not commit active/previous/candidate correctly.'
    }

    # Healthy rollback restores previous and keeps the displaced active as a re-qualifiable candidate.
    $rollback = (& $transition `
        -InstallationRoot $installationRoot `
        -ProjectRoot $projectRoot `
        -Environment $environmentName `
        -Operation Rollback `
        -HealthTimeoutSeconds 15 `
        -RestartCount 0 `
        -RestartIntervalSeconds 1 `
        -ReadinessTimeoutSeconds 5 `
        -Execute `
        -AllowUnsignedDevelopment) | ConvertFrom-Json
    if ([string]$rollback.status -ne 'rolled-back' -or
        [string]$rollback.activeReleaseId -ne '1.2.0-a' -or
        [string]$rollback.candidateReleaseId -ne '1.2.0-b' -or
        $null -ne $rollback.previousReleaseId) {
        throw 'Healthy execution-node rollback returned unexpected evidence.'
    }

        # Qualification is owner-bound: killing the transition controller must terminate McpHost and its Job Object tree.
    Write-State -Active $pointerA -Candidate $pointerC -Previous $null
    $healthStatePath = Join-Path $projectRoot 'runtime\windows-execution-node\production\host-state.json'
    Remove-Item -LiteralPath $healthStatePath -Force -ErrorAction SilentlyContinue
    $controllerInfo = [Diagnostics.ProcessStartInfo]::new()
    $controllerInfo.FileName = (Get-Command pwsh -ErrorAction Stop).Source
    $controllerInfo.UseShellExecute = $false
    $controllerInfo.CreateNoWindow = $true
    foreach ($argument in @(
        '-NoLogo', '-NoProfile', '-File', $transition,
        '-InstallationRoot', $installationRoot,
        '-ProjectRoot', $projectRoot,
        '-Environment', $environmentName,
        '-Operation', 'Promote',
        '-HealthTimeoutSeconds', '40',
        '-RestartCount', '0',
        '-RestartIntervalSeconds', '1',
        '-ReadinessTimeoutSeconds', '30',
        '-Execute',
        '-AllowUnsignedDevelopment'
    )) {
        $null = $controllerInfo.ArgumentList.Add([string]$argument)
    }
    $controller = [Diagnostics.Process]::new()
    $controller.StartInfo = $controllerInfo
    if (-not $controller.Start()) {
        throw 'Execution-node qualification owner test controller did not start.'
    }
    $ownedHostPid = 0
    try {
        $ownerDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
        while ([DateTimeOffset]::UtcNow -lt $ownerDeadline) {
            if ($controller.HasExited) {
                throw 'Execution-node qualification controller exited before owner-binding could be observed.'
            }
            if (Test-Path -LiteralPath $healthStatePath -PathType Leaf) {
                try {
                    $ownerHealth = Get-Content -LiteralPath $healthStatePath -Raw | ConvertFrom-Json
                    if ([string]$ownerHealth.releaseId -eq '1.2.0-c' -and [int]$ownerHealth.pid -gt 0) {
                        $ownedHostPid = [int]$ownerHealth.pid
                        break
                    }
                }
                catch {
                }
            }
            Start-Sleep -Milliseconds 200
        }
        if ($ownedHostPid -le 0 -or $null -eq (Get-Process -Id $ownedHostPid -ErrorAction SilentlyContinue)) {
            throw 'Execution-node qualification owner test did not observe a live McpHost.'
        }

        Stop-Process -Id $controller.Id -Force
        $controller.WaitForExit(10000) | Out-Null
        $hostExitDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
        while ([DateTimeOffset]::UtcNow -lt $hostExitDeadline -and
            $null -ne (Get-Process -Id $ownedHostPid -ErrorAction SilentlyContinue)) {
            Start-Sleep -Milliseconds 200
        }
        if ($null -ne (Get-Process -Id $ownedHostPid -ErrorAction SilentlyContinue)) {
            throw 'McpHost survived loss of its qualification owner process.'
        }
        $ownerState = Get-Content -LiteralPath (Join-Path $stateRoot 'lifecycle-state.v1.json') -Raw | ConvertFrom-Json
        if ([string]$ownerState.active.releaseId -ne '1.2.0-a' -or
            [string]$ownerState.candidate.releaseId -ne '1.2.0-c' -or
            $null -ne $ownerState.previous) {
            throw 'Qualification owner loss changed execution-node state before commit.'
        }
    }
    finally {
        if (-not $controller.HasExited) {
            Stop-Process -Id $controller.Id -Force -ErrorAction SilentlyContinue
        }
        if ($ownedHostPid -gt 0) {
            Stop-Process -Id $ownedHostPid -Force -ErrorAction SilentlyContinue
        }
    }

    # A target that never reaches ready must leave the state unchanged.
    Write-State -Active $pointerA -Candidate $pointerC -Previous $null
    $beforeFailedPromotion = Get-Content -LiteralPath (Join-Path $stateRoot 'lifecycle-state.v1.json') -Raw | ConvertFrom-Json
    $healthRejected = $false
    try {
        & $transition `
            -InstallationRoot $installationRoot `
            -ProjectRoot $projectRoot `
            -Environment $environmentName `
            -Operation Promote `
            -HealthTimeoutSeconds 10 `
            -RestartCount 0 `
            -RestartIntervalSeconds 1 `
            -ReadinessTimeoutSeconds 5 `
            -Execute `
            -AllowUnsignedDevelopment | Out-Null
    }
    catch {
        $healthRejected = $_.Exception.Message -like '*qualification*'
    }
    $afterFailedPromotion = Get-Content -LiteralPath (Join-Path $stateRoot 'lifecycle-state.v1.json') -Raw | ConvertFrom-Json
    if (-not $healthRejected -or
        [string]$afterFailedPromotion.active.releaseId -ne [string]$beforeFailedPromotion.active.releaseId -or
        [string]$afterFailedPromotion.candidate.releaseId -ne [string]$beforeFailedPromotion.candidate.releaseId -or
        $null -ne $afterFailedPromotion.previous) {
        throw 'Failed health qualification changed execution-node state.'
    }

    # Pointer tampering must fail before starting the target host.
    $badPointer = [ordered]@{
        releaseId = '1.2.0-b'
        manifestSha256 = ('9' * 64)
        materializedAt = [DateTimeOffset]::UtcNow.ToString('O')
    }
    Write-State -Active $pointerA -Candidate $badPointer -Previous $null
    $tamperRejected = $false
    try {
        & $transition `
            -InstallationRoot $installationRoot `
            -ProjectRoot $projectRoot `
            -Environment $environmentName `
            -Operation Promote `
            -Execute `
            -AllowUnsignedDevelopment | Out-Null
    }
    catch {
        $tamperRejected = $_.Exception.Message -like '*pointer does not match*'
    }
    if (-not $tamperRejected) {
        throw 'Tampered candidate pointer was not rejected before qualification.'
    }

    # The canonical state.lock serializes staging, promotion and rollback.
    Write-State -Active $pointerA -Candidate $pointerB -Previous $null
    $heldLock = [IO.File]::Open(
        (Join-Path $stateRoot 'state.lock'),
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
    )
    try {
        $lockRejected = $false
        try {
            & $transition `
                -InstallationRoot $installationRoot `
                -ProjectRoot $projectRoot `
                -Environment $environmentName `
                -Operation Promote `
                -Execute `
                -AllowUnsignedDevelopment | Out-Null
        }
        catch {
            $lockRejected = $_.Exception.Message -like '*already active*'
        }
        if (-not $lockRejected) {
            throw 'Concurrent execution-node transition was not rejected by state.lock.'
        }
    }
    finally {
        $heldLock.Dispose()
    }

    Write-Output 'Execution-node promotion/rollback smoke passed health-before-commit, reversible state and state.lock serialization.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
