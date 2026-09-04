[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'Host runner lease resilience test is supported only on Windows.'
}

function Quote-NativeArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"')) {
        throw 'Test argument contains an unsupported quote.'
    }
    return '"' + $Value + '"'
}

function Wait-ForFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$TimeoutSeconds = 15
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            throw "Timed out waiting for file: $Path"
        }
        Start-Sleep -Milliseconds 100
    }
}

$actualRoot = Get-McpProjectRoot
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'mcp-host-runner-lease-resilience-' + [guid]::NewGuid().ToString('N')
)
$projectRoot = Join-Path $tempRoot 'project root'
$releaseRoot = Join-Path $tempRoot 'release root'
$configDirectory = Join-Path $projectRoot '.runtime-private\docker\production'
$targetDirectory = Join-Path $releaseRoot 'services\workspace-agent\dist'
$targetPath = Join-Path $targetDirectory 'cli.js'
$gitleaksPath = Join-Path $projectRoot '.runtime-tools\gitleaks\gitleaks.exe'
$readyPath = Join-Path $tempRoot 'ready.json'
$stopPath = Join-Path $tempRoot 'stop.signal'
$runtimeDirectory = Join-Path $projectRoot 'runtime\windows-services\production\agent'
$leasePath = Join-Path $runtimeDirectory 'runner-lease.json'
$stderrPath = Join-Path $runtimeDirectory 'stderr.log'
$runnerPath = Join-Path $actualRoot 'deploy\docker\scripts\Run-DockerHostComponent.mjs'
$nodePath = Get-McpNodeExecutable
$runnerProcess = $null
$leaseLock = $null

try {
    New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
    New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $gitleaksPath) | Out-Null
    [System.IO.File]::WriteAllText($gitleaksPath, 'test-gitleaks', [System.Text.UTF8Encoding]::new($false))

    $configuration = [ordered]@{
        gatewayUrl = 'ws://127.0.0.1:65534/agent'
        agentId = 'lease-resilience-test'
        token = 'test-token'
        policyPath = (Join-Path $tempRoot 'policy.json')
        dataDirectory = (Join-Path $tempRoot 'data')
        maxPayloadBytes = 1024
        gitleaksPath = $gitleaksPath
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $configDirectory 'agent.json'),
        ($configuration | ConvertTo-Json -Depth 5),
        [System.Text.UTF8Encoding]::new($false)
    )

    $fixtureSource = @'
import { existsSync, writeFileSync } from "node:fs";
import process from "node:process";

writeFileSync(
  process.env.MCP_TEST_READY_PATH,
  JSON.stringify({ pid: process.pid }),
  "utf8",
);
while (!existsSync(process.env.MCP_TEST_STOP_PATH)) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
'@
    [System.IO.File]::WriteAllText(
        $targetPath,
        $fixtureSource,
        [System.Text.UTF8Encoding]::new($false)
    )

    $arguments = @(
        (Quote-NativeArgument $runnerPath),
        '--component',
        'agent',
        '--environment',
        'production',
        '--release-root',
        (Quote-NativeArgument $releaseRoot),
        '--project-root',
        (Quote-NativeArgument $projectRoot),
        '--task-owned',
        'true',
        '--restart-count',
        '0',
        '--restart-interval-seconds',
        '1'
    ) -join ' '

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $nodePath
    $startInfo.Arguments = $arguments
    $startInfo.WorkingDirectory = $releaseRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables['MCP_TEST_READY_PATH'] = $readyPath
    $startInfo.EnvironmentVariables['MCP_TEST_STOP_PATH'] = $stopPath

    $runnerProcess = [System.Diagnostics.Process]::new()
    $runnerProcess.StartInfo = $startInfo
    if (-not $runnerProcess.Start()) {
        throw 'Host runner lease resilience process did not start.'
    }

    Wait-ForFile -Path $readyPath
    Wait-ForFile -Path $leasePath
    $initialLease = Get-Content -Raw -LiteralPath $leasePath | ConvertFrom-Json

    $lockDeadline = [DateTimeOffset]::UtcNow.AddSeconds(5)
    while (-not $leaseLock) {
        try {
            $leaseLock = [System.IO.File]::Open(
                $leasePath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::None
            )
        }
        catch [System.IO.IOException] {
            if ([DateTimeOffset]::UtcNow -ge $lockDeadline) {
                throw 'Could not acquire an exclusive runner lease lock.'
            }
            Start-Sleep -Milliseconds 50
        }
    }

    $failureDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
    $transientFailureObserved = $false
    while (-not $transientFailureObserved) {
        if ($runnerProcess.HasExited) {
            $stderr = $runnerProcess.StandardError.ReadToEnd()
            throw "Host runner exited before a heartbeat encountered the transient lease lock. stderr=$stderr"
        }
        if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
            $lockedLog = Get-Content -Raw -LiteralPath $stderrPath -ErrorAction SilentlyContinue
            $transientFailureObserved = (
                $lockedLog -match 'host_runner_lease_write_failed' -and
                $lockedLog -match '"source":"heartbeat"'
            )
        }
        if (-not $transientFailureObserved) {
            if ([DateTimeOffset]::UtcNow -ge $failureDeadline) {
                throw 'Timed out waiting for a heartbeat to encounter the transient runner lease lock.'
            }
            Start-Sleep -Milliseconds 100
        }
    }

    $leaseLock.Dispose()
    $leaseLock = $null

    if ($runnerProcess.HasExited) {
        $stderr = $runnerProcess.StandardError.ReadToEnd()
        throw "Host runner exited during the transient lease lock. stderr=$stderr"
    }

    $recoveryDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
    $recoveredLease = $null
    $lastLeaseReadError = $null
    while (-not $recoveredLease) {
        try {
            $candidate = Get-Content -Raw -LiteralPath $leasePath | ConvertFrom-Json
            if ([DateTimeOffset]$candidate.updatedAtUtc -gt [DateTimeOffset]$initialLease.updatedAtUtc) {
                $recoveredLease = $candidate
                break
            }
        }
        catch {
            $lastLeaseReadError = $_.Exception.Message
        }
        if ([DateTimeOffset]::UtcNow -ge $recoveryDeadline) {
            $diagnostic = [ordered]@{
                capturedAt = [DateTimeOffset]::UtcNow.ToString('o')
                runnerPid = if ($runnerProcess) { $runnerProcess.Id } else { 0 }
                runnerHasExited = if ($runnerProcess) { $runnerProcess.HasExited } else { $true }
                runnerExitCode = if ($runnerProcess -and $runnerProcess.HasExited) { $runnerProcess.ExitCode } else { $null }
                initialLease = $initialLease
                leaseExists = Test-Path -LiteralPath $leasePath -PathType Leaf
                leaseContent = if (Test-Path -LiteralPath $leasePath -PathType Leaf) { Get-Content -Raw -LiteralPath $leasePath -ErrorAction SilentlyContinue } else { $null }
                lastLeaseReadError = $lastLeaseReadError
                runtimeFiles = @(Get-ChildItem -LiteralPath $runtimeDirectory -Force -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWriteTimeUtc)
                stderr = if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { Get-Content -Raw -LiteralPath $stderrPath } else { $null }
            }
            $diagnosticPath = Join-Path $actualRoot 'runtime\operational-gates\host-runner-lease-resilience-failure.json'
            [System.IO.File]::WriteAllText(
                $diagnosticPath,
                ($diagnostic | ConvertTo-Json -Depth 10),
                [System.Text.UTF8Encoding]::new($false)
            )
            throw "Runner lease heartbeat did not recover after the exclusive lock was released. diagnostics=$diagnosticPath"
        }
        Start-Sleep -Milliseconds 100
    }

    $log = Get-Content -Raw -LiteralPath $stderrPath
    if ($log -notmatch 'host_runner_lease_write_failed') {
        throw 'Runner did not record the transient lease write failure.'
    }
    if ($log -notmatch '"source":"heartbeat"') {
        throw 'Runner did not attribute the transient lease failure to the heartbeat.'
    }

    [System.IO.File]::WriteAllText($stopPath, 'stop', [System.Text.UTF8Encoding]::new($false))
    if (-not $runnerProcess.WaitForExit(15000)) {
        throw 'Host runner did not exit after the fixture stop signal.'
    }
    if ($runnerProcess.ExitCode -ne 1) {
        throw "Unexpected host runner exit code: $($runnerProcess.ExitCode)"
    }
    if (Test-Path -LiteralPath $leasePath) {
        throw 'Host runner left a lease file after shutdown.'
    }
}
finally {
    if ($leaseLock) {
        $leaseLock.Dispose()
    }
    if ($runnerProcess -and -not $runnerProcess.HasExited) {
        Stop-Process -Id $runnerProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output 'Host runner lease resilience test passed: transient Windows file locks do not terminate the task-owned runner.'
