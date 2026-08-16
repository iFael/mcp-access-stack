[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$hostSourcePath = Join-Path $root 'tooling\windows-execution-node\McpHost.cs'
$supervisorSourcePath = Join-Path $root 'tooling\windows-execution-node\McpHostSupervisor.cs'
$builderPath = Join-Path $PSScriptRoot 'New-McpWindowsExecutionNodeArtifacts.ps1'

$hostSource = Get-Content -LiteralPath $hostSourcePath -Raw
$supervisorSource = Get-Content -LiteralPath $supervisorSourcePath -Raw
$builder = Get-Content -LiteralPath $builderPath -Raw

foreach ($required in @(
    'mcp-host-contract-v2',
    '--supervise',
    'expected-manifest-sha256',
    'release-root',
    'project-root',
    'environment'
)) {
    if (-not $hostSource.Contains($required)) {
        throw "McpHost supervisor CLI requirement is missing: $required"
    }
}
foreach ($required in @(
    'JobObjectLimitKillOnJobClose',
    'services", "workspace-agent", "dist", "cli.js',
    'services", "browser-worker", "dist", "server.js',
    'runtime", "node", "node.exe',
    'Execution-node artifact changed after validation',
    'eventName, "connected"',
    '/health/ready',
    'host-state.json',
    'restart budget exhausted',
    'BROWSER_WORKER_PROFILE_MODE"] = "persistent"'
)) {
    if (-not $supervisorSource.Contains($required)) {
        throw "McpHost supervisor source requirement is missing: $required"
    }
}
foreach ($forbidden in @(
    'Run-DockerHostComponent.mjs',
    'cmd.exe',
    'powershell.exe',
    'pwsh.exe',
    'ProcessStartInfo.Arguments = options'
)) {
    if ($hostSource.Contains($forbidden) -or $supervisorSource.Contains($forbidden)) {
        throw "McpHost supervisor must not expose a generic runner path: $forbidden"
    }
}
foreach ($required in @(
    'McpHostSupervisor.cs',
    'System.Web.Extensions.dll',
    'mcp-host-contract-v2'
)) {
    if (-not $builder.Contains($required)) {
        throw "McpHost native builder is missing supervisor support: $required"
    }
}

if ([string]$env:GITHUB_ACTIONS -ne 'true') {
    Write-Output 'McpHost supervisor static contract passed; runtime smoke is GitHub-only.'
    return
}

$testRoot = Join-Path $env:RUNNER_TEMP ('mcp-host-supervisor-' + [guid]::NewGuid().ToString('N'))
$projectRoot = Join-Path $testRoot 'project root'
$releaseRoot = Join-Path $testRoot 'release root'
$buildOutput = Join-Path $testRoot 'native build'
$environmentName = 'production'
$configurationRoot = Join-Path $projectRoot '.runtime-private\docker\production'
$runtimeRoot = Join-Path $projectRoot 'runtime\windows-execution-node\production'
$healthStatePath = Join-Path $runtimeRoot 'host-state.json'
$hostProcess = $null

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $parent = Split-Path -Parent $Path
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
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

function New-ArtifactRecord {
    param([string]$Role, [string]$RelativePath, [bool]$AuthenticodeRequired)
    $path = Join-Path $releaseRoot ($RelativePath.Replace('/', '\'))
    $item = Get-Item -LiteralPath $path
    return [ordered]@{
        role = $Role
        path = $RelativePath
        sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        sizeBytes = [long]$item.Length
        authenticodeRequired = $AuthenticodeRequired
    }
}

function Test-ProcessAlive {
    param([int]$Id)
    if ($Id -le 0) { return $false }
    return $null -ne (Get-Process -Id $Id -ErrorAction SilentlyContinue)
}

try {
    $commit = 'd' * 40
    $releaseId = 'ci-host-supervisor'
    $browserPort = Get-FreeTcpPort
    $policyPath = Join-Path $projectRoot 'policy.json'
    $dataDirectory = Join-Path $projectRoot 'agent-data'
    $browserUserData = Join-Path $projectRoot 'browser-profile'
    $browserRuntime = Join-Path $projectRoot 'browser-runtime'
    $browserPrivate = Join-Path $projectRoot 'browser-private'

    New-Item -ItemType Directory -Force -Path `
        $configurationRoot, `
        (Join-Path $releaseRoot 'services\workspace-agent\dist'), `
        (Join-Path $releaseRoot 'services\browser-worker\dist'), `
        (Join-Path $releaseRoot 'runtime\node'), `
        (Join-Path $releaseRoot 'native'), `
        (Join-Path $releaseRoot 'tooling\windows-host-launcher'), `
        (Join-Path $releaseRoot 'tooling\windows-credential-broker'), `
        $dataDirectory, `
        $browserUserData, `
        $browserRuntime, `
        $browserPrivate | Out-Null

    Copy-Item `
        -LiteralPath (Join-Path $root 'tooling\windows-host-launcher\McpNodeHostLauncher.cs') `
        -Destination (Join-Path $releaseRoot 'tooling\windows-host-launcher\McpNodeHostLauncher.cs')
    Copy-Item `
        -LiteralPath (Join-Path $root 'tooling\windows-credential-broker\McpCredentialBroker.cs') `
        -Destination (Join-Path $releaseRoot 'tooling\windows-credential-broker\McpCredentialBroker.cs')

    $nodeSource = (Get-Command node -ErrorAction Stop).Source
    Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $releaseRoot 'runtime\node\node.exe')
    Write-Utf8NoBom -Path $policyPath -Content "{}`n"

    $agentScript = @'
const fs = require('node:fs');
const path = require('node:path');
const marker = path.join(process.env.VS_CODE_GPT_DATA_DIR, 'restart-marker.txt');
process.stderr.write(JSON.stringify({ event: 'connected', pid: process.pid }) + '\n');
if (!fs.existsSync(marker)) {
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, 'restart-once', 'utf8');
  setTimeout(() => process.exit(7), 500);
} else {
  setInterval(() => {}, 1000);
}
'@
    Write-Utf8NoBom `
        -Path (Join-Path $releaseRoot 'services\workspace-agent\dist\cli.js') `
        -Content ($agentScript + "`n")

    $browserScript = @'
const http = require('node:http');
const port = Number(process.env.BROWSER_WORKER_PORT);
const server = http.createServer((request, response) => {
  if (request.url === '/health/live' || request.url === '/health/ready') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: request.url === '/health/ready' ? 'ready' : 'live' }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(port, '127.0.0.1');
setInterval(() => {}, 1000);
'@
    Write-Utf8NoBom `
        -Path (Join-Path $releaseRoot 'services\browser-worker\dist\server.js') `
        -Content ($browserScript + "`n")

    $agentConfig = [ordered]@{
        gatewayUrl = 'ws://127.0.0.1:65534/agent'
        agentId = 'ci-host-supervisor'
        token = 'ci-agent-token'
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
    Write-Utf8NoBom `
        -Path (Join-Path $configurationRoot 'agent.json') `
        -Content (($agentConfig | ConvertTo-Json -Depth 8) + "`n")

    $browserConfig = [ordered]@{
        port = $browserPort
        token = 'ci-browser-token'
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
    Write-Utf8NoBom `
        -Path (Join-Path $configurationRoot 'browser.json') `
        -Content (($browserConfig | ConvertTo-Json -Depth 8) + "`n")

    $releaseManifest = [ordered]@{
        releaseId = $releaseId
        commit = $commit
        nodeVersion = (& (Join-Path $releaseRoot 'runtime\node\node.exe') --version)[0]
    }
    Write-Utf8NoBom `
        -Path (Join-Path $releaseRoot 'manifest.json') `
        -Content (($releaseManifest | ConvertTo-Json -Depth 8) + "`n")

    $buildResultJson = & pwsh -NoLogo -NoProfile `
        -File $builderPath `
        -ReleaseRoot $releaseRoot `
        -ReleaseId $releaseId `
        -SourceCommit $commit `
        -OutputDirectory $buildOutput
    if ($LASTEXITCODE -ne 0) {
        throw 'McpHost supervisor CI native build failed.'
    }
    $buildResult = $buildResultJson | ConvertFrom-Json
    if ([string]$buildResult.status -ne 'built') {
        throw 'McpHost supervisor CI native build returned unexpected evidence.'
    }
    Copy-Item `
        -LiteralPath (Join-Path $buildOutput 'McpHost.exe') `
        -Destination (Join-Path $releaseRoot 'native\McpHost.exe')

    $executionManifest = [ordered]@{
        version = 1
        releaseId = $releaseId
        commit = $commit
        platform = 'win32-x64'
        runtimeMode = 'bundled-node'
        integrityRoot = 'signed-distribution-manifest'
        artifacts = @(
            (New-ArtifactRecord -Role 'mcp-host' -RelativePath 'native/McpHost.exe' -AuthenticodeRequired $true),
            (New-ArtifactRecord -Role 'workspace-agent' -RelativePath 'services/workspace-agent/dist/cli.js' -AuthenticodeRequired $false),
            (New-ArtifactRecord -Role 'browser-worker' -RelativePath 'services/browser-worker/dist/server.js' -AuthenticodeRequired $false),
            (New-ArtifactRecord -Role 'node-runtime' -RelativePath 'runtime/node/node.exe' -AuthenticodeRequired $false)
        )
    }
    $executionManifestPath = Join-Path $releaseRoot 'execution-node-manifest.json'
    Write-Utf8NoBom `
        -Path $executionManifestPath `
        -Content (($executionManifest | ConvertTo-Json -Depth 12) + "`n")
    $manifestHash = (Get-FileHash -LiteralPath $executionManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $hostPath = Join-Path $releaseRoot 'native\McpHost.exe'
    $version = @(& $hostPath --version)
    if ($LASTEXITCODE -ne 0 -or $version.Count -ne 1 -or [string]$version[0] -ne 'mcp-host-contract-v2') {
        throw 'McpHost supervisor CI artifact returned the wrong contract version.'
    }
    $validated = @(& $hostPath --validate-release-root $releaseRoot)
    if ($LASTEXITCODE -ne 0 -or $validated.Count -ne 1 -or [string]$validated[0] -ne 'release-root-valid') {
        throw 'McpHost supervisor CI release validation failed.'
    }

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $hostPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @(
        '--supervise',
        'release-root', $releaseRoot,
        'project-root', $projectRoot,
        'environment', $environmentName,
        'expected-manifest-sha256', $manifestHash,
        '--restart-count', '2',
        '--restart-interval-seconds', '1',
        '--readiness-timeout-seconds', '10'
    )) {
        $null = $startInfo.ArgumentList.Add([string]$argument)
    }
    $hostProcess = [Diagnostics.Process]::new()
    $hostProcess.StartInfo = $startInfo
    if (-not $hostProcess.Start()) {
        throw 'McpHost supervisor CI process did not start.'
    }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    $readyState = $null
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if ($hostProcess.HasExited) {
            $stderr = $hostProcess.StandardError.ReadToEnd()
            throw "McpHost supervisor exited before readiness. Exit=$($hostProcess.ExitCode) Error=$stderr"
        }
        if (Test-Path -LiteralPath $healthStatePath -PathType Leaf) {
            try {
                $state = Get-Content -LiteralPath $healthStatePath -Raw | ConvertFrom-Json
                if (
                    [string]$state.status -eq 'ready' -and
                    $state.agent.ready -eq $true -and
                    $state.browserWorker.ready -eq $true -and
                    [int]$state.agent.restartAttempt -ge 1
                ) {
                    $readyState = $state
                    break
                }
            }
            catch {
            }
        }
        Start-Sleep -Milliseconds 250
    }
    if ($null -eq $readyState) {
        throw 'McpHost supervisor did not reach ready after the bounded Agent restart.'
    }

    $agentPid = [int]$readyState.agent.pid
    $browserPid = [int]$readyState.browserWorker.pid
    if (-not (Test-ProcessAlive -Id $agentPid) -or -not (Test-ProcessAlive -Id $browserPid)) {
        throw 'McpHost ready state referenced a non-live child process.'
    }

    Stop-Process -Id $hostProcess.Id -Force
    $hostProcess.WaitForExit(10000) | Out-Null
    $cleanupDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
    while (
        [DateTimeOffset]::UtcNow -lt $cleanupDeadline -and
        ((Test-ProcessAlive -Id $agentPid) -or (Test-ProcessAlive -Id $browserPid))
    ) {
        Start-Sleep -Milliseconds 200
    }
    if ((Test-ProcessAlive -Id $agentPid) -or (Test-ProcessAlive -Id $browserPid)) {
        throw 'McpHost Job Object did not clean up the supervised child processes.'
    }

    Write-Output 'McpHost supervisor runtime smoke passed readiness, restart and Job Object cleanup.'
}
finally {
    if ($hostProcess -and -not $hostProcess.HasExited) {
        Stop-Process -Id $hostProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
