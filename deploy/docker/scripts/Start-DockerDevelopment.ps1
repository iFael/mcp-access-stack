[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$EnableTunnel,
    [switch]$SkipAgent,
    [int]$ReadyTimeoutSeconds = 120
)

. (Join-Path $PSScriptRoot 'Common.ps1')

Assert-McpCommand -Name 'docker'
Assert-McpCommand -Name 'node'
Assert-McpCommand -Name 'npm'

$root = Get-McpProjectRoot
$privateDirectory = Join-Path $root '.runtime-private\docker\development'
$gatewayEnvPath = Join-Path $privateDirectory 'gateway.env'
$agentConfigPath = Join-Path $privateDirectory 'agent.json'
$composeEnvPath = Join-Path $privateDirectory 'compose.env'
$runtimeDirectory = Join-Path $root 'runtime\docker-development'
$statePath = Join-Path $runtimeDirectory 'agent-process.json'
$stdoutPath = Join-Path $runtimeDirectory 'workspace-agent.stdout.log'
$stderrPath = Join-Path $runtimeDirectory 'workspace-agent.stderr.log'

foreach ($requiredPath in @($gatewayEnvPath, $agentConfigPath, $composeEnvPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Development environment configuration is incomplete. Missing: $requiredPath. Run npm run docker:development:init first."
    }
}

New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$composeArguments = Get-McpComposeArguments -Environment 'development'

Push-Location $root
try {
    & docker compose @composeArguments config --quiet
    if ($LASTEXITCODE -ne 0) {
        throw 'Development environment Compose configuration is invalid.'
    }

    if (-not $SkipBuild) {
        & npm run build -w '@vs-code-gpt/shared'
        if ($LASTEXITCODE -ne 0) { throw 'Shared package build failed.' }
        & npm run build -w '@vs-code-gpt/local-agent'
        if ($LASTEXITCODE -ne 0) { throw 'Local agent build failed.' }
    }

    $upArguments = @('up', '-d', '--build', 'gateway', 'proxy')
    if ($EnableTunnel) {
        $upArguments = @('--profile', 'tunnel', 'up', '-d', '--build', 'gateway', 'proxy', 'tunnel')
    }
    & docker compose @composeArguments @upArguments
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to start the Docker development environment.'
    }
}
finally {
    Pop-Location
}

Wait-McpHttpEndpoint -Uri 'http://127.0.0.1:4310/health/live' -TimeoutSeconds $ReadyTimeoutSeconds | Out-Null
Wait-McpHttpEndpoint -Uri 'http://127.0.0.1:4300/health/live' -TimeoutSeconds $ReadyTimeoutSeconds | Out-Null

if (-not $SkipAgent) {
    $agentRunning = $false
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try {
            $existingState = Read-McpJsonFile -Path $statePath
            $existingPid = [int]$existingState.pid
            $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
            $agentRunning = $null -ne $existingProcess -and
                [string]$existingProcess.CommandLine -match 'Run-DockerDevelopmentAgent|Run-DockerHostAgent'
        }
        catch {
            $agentRunning = $false
        }
    }

    if (-not $agentRunning) {
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
        $runnerPath = Join-Path $PSScriptRoot 'Run-DockerDevelopmentAgent.ps1'
        $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
        $quotedRunner = '"{0}"' -f $runnerPath
        $startParameters = @{
            FilePath = $pwsh
            ArgumentList = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $quotedRunner)
            WorkingDirectory = $root
            RedirectStandardOutput = $stdoutPath
            RedirectStandardError = $stderrPath
            WindowStyle = 'Hidden'
            PassThru = $true
        }
        $process = Start-Process @startParameters

        Write-McpJsonFile -Path $statePath -Value ([ordered]@{
            version = 1
            pid = $process.Id
            startedAt = [DateTimeOffset]::UtcNow.ToString('O')
            configurationPath = $agentConfigPath
            stdoutPath = $stdoutPath
            stderrPath = $stderrPath
        })
    }

    try {
        Wait-McpHttpEndpoint -Uri 'http://127.0.0.1:4310/health/ready' -TimeoutSeconds $ReadyTimeoutSeconds | Out-Null
    }
    catch {
        if (Test-Path -LiteralPath $stderrPath) {
            Write-Warning ((Get-Content -LiteralPath $stderrPath -Tail 20) -join [Environment]::NewLine)
        }
        throw
    }
}

Write-Output 'Docker development environment is running.'
Write-Output 'Gateway live: http://127.0.0.1:4310/health/live'
Write-Output 'Gateway ready: http://127.0.0.1:4310/health/ready'
Write-Output 'Proxy live: http://127.0.0.1:4300/health/live'
