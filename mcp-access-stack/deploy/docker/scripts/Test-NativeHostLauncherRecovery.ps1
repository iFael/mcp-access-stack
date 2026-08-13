[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'Native host launcher recovery test is supported only on Windows.'
}

function Quote-NativeArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"')) {
        throw 'Test argument contains an unsupported quote.'
    }
    return '"' + $Value + '"'
}

$projectRoot = Get-McpProjectRoot
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'mcp-native-host-launcher-recovery-' + [guid]::NewGuid().ToString('N')
)
$fixturePath = Join-Path $tempRoot 'fixture.mjs'
$countPath = Join-Path $tempRoot 'run-count.txt'
$stdoutPath = Join-Path $tempRoot 'stdout.log'
$stderrPath = Join-Path $tempRoot 'stderr.log'
$launcherProcess = $null

try {
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    $launcherPath = Get-McpNodeHostLauncherExecutable `
        -ProjectRoot $tempRoot `
        -ReleaseRoot $projectRoot
    $nodePath = Get-McpNodeExecutable

    $fixtureSource = @'
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const countPath = process.argv[2];
const count = existsSync(countPath)
  ? Number(readFileSync(countPath, "utf8")) + 1
  : 1;
writeFileSync(countPath, String(count), "utf8");
process.exit(count === 1 ? 23 : 0);
'@
    [System.IO.File]::WriteAllText(
        $fixturePath,
        $fixtureSource,
        [System.Text.UTF8Encoding]::new($false)
    )

    $arguments = @(
        '--node',
        (Quote-NativeArgument $nodePath),
        '--stdout-log',
        (Quote-NativeArgument $stdoutPath),
        '--stderr-log',
        (Quote-NativeArgument $stderrPath),
        '--runner-restart-count',
        '1',
        '--runner-restart-interval-seconds',
        '1',
        '--',
        (Quote-NativeArgument $fixturePath),
        (Quote-NativeArgument $countPath)
    ) -join ' '

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $launcherPath
    $startInfo.Arguments = $arguments
    $startInfo.WorkingDirectory = $tempRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

    $launcherProcess = [System.Diagnostics.Process]::new()
    $launcherProcess.StartInfo = $startInfo
    if (-not $launcherProcess.Start()) {
        throw 'Native launcher recovery test process did not start.'
    }
    if (-not $launcherProcess.WaitForExit(20000)) {
        throw 'Native launcher did not finish the recovery fixture within 20 seconds.'
    }
    if ($launcherProcess.ExitCode -ne 0) {
        $stderr = if (Test-Path -LiteralPath $stderrPath) {
            Get-Content -Raw -LiteralPath $stderrPath
        }
        else {
            ''
        }
        throw "Native launcher recovery fixture exited with $($launcherProcess.ExitCode). stderr=$stderr"
    }

    $runCount = [int](Get-Content -Raw -LiteralPath $countPath)
    if ($runCount -ne 2) {
        throw "Native launcher did not restart the runner exactly once. count=$runCount"
    }

    $log = Get-Content -Raw -LiteralPath $stderrPath
    if ($log -notmatch 'native_launcher_child_restart_scheduled') {
        throw 'Native launcher did not log the scheduled runner restart.'
    }
    if (($log | Select-String -Pattern 'native_launcher_child_started' -AllMatches).Matches.Count -ne 2) {
        throw 'Native launcher did not start exactly two runner processes.'
    }
    if ($log -notmatch 'native_launcher_child_exited 23 restartAttempt=0') {
        throw 'Native launcher did not record the failed first runner.'
    }
    if ($log -notmatch 'native_launcher_child_exited 0 restartAttempt=1') {
        throw 'Native launcher did not record the successful recovered runner.'
    }
}
finally {
    if ($launcherProcess -and -not $launcherProcess.HasExited) {
        Stop-Process -Id $launcherProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output 'Native host launcher recovery test passed: failed runners are restarted without leaving task ownership.'
