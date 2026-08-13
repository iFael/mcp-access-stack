[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'Native host launcher test is supported only on Windows.'
}

function Quote-NativeArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"')) {
        throw 'Test argument contains an unsupported quote.'
    }
    return '"' + $Value + '"'
}

function Get-PeSubsystem {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $reader = [System.IO.BinaryReader]::new($stream)
    try {
        $stream.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            throw 'Native launcher does not contain a valid PE signature.'
        }
        $stream.Position = $peOffset + 24
        $magic = $reader.ReadUInt16()
        if ($magic -ne 0x010b -and $magic -ne 0x020b) {
            throw "Unsupported PE optional-header magic: $magic"
        }
        $stream.Position = $peOffset + 24 + 68
        return $reader.ReadUInt16()
    }
    finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

$projectRoot = Get-McpProjectRoot
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'mcp-native-host-launcher-' + [guid]::NewGuid().ToString('N')
)
$statePath = Join-Path $tempRoot 'state.json'
$stopPath = Join-Path $tempRoot 'stop.signal'
$scriptPath = Join-Path $tempRoot 'fixture.mjs'
$stdoutPath = Join-Path $tempRoot 'stdout.log'
$stderrPath = Join-Path $tempRoot 'stderr.log'
$launcherProcess = $null
$childPid = 0

try {
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    $launcherPath = Get-McpNodeHostLauncherExecutable `
        -ProjectRoot $tempRoot `
        -ReleaseRoot $projectRoot
    $nodePath = Get-McpNodeExecutable

    if ((Get-PeSubsystem -Path $launcherPath) -ne 2) {
        throw 'Native launcher must use the Windows GUI subsystem instead of the console subsystem.'
    }

    $fixtureSource = @'
import { existsSync, writeFileSync } from "node:fs";
import process from "node:process";

writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }), "utf8");
while (!existsSync(process.argv[3])) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
'@
    [System.IO.File]::WriteAllText(
        $scriptPath,
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
        '--',
        (Quote-NativeArgument $scriptPath),
        (Quote-NativeArgument $statePath),
        (Quote-NativeArgument $stopPath)
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
        throw 'Native launcher test process did not start.'
    }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
    while (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        if ($launcherProcess.HasExited) {
            $stderr = if (Test-Path -LiteralPath $stderrPath) {
                Get-Content -Raw -LiteralPath $stderrPath
            }
            else {
                ''
            }
            throw "Native launcher exited before the fixture started. stderr=$stderr"
        }
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            throw 'Native launcher fixture did not create its state file.'
        }
        Start-Sleep -Milliseconds 100
    }

    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $childPid = [int]$state.pid
    $childProcess = Get-Process -Id $childPid -ErrorAction Stop
    $childCim = Get-CimInstance Win32_Process -Filter "ProcessId=$childPid" -ErrorAction Stop
    if ([int]$childCim.ParentProcessId -ne $launcherProcess.Id) {
        throw 'Native launcher did not directly own the Node.js fixture process.'
    }
    if ([int64]$launcherProcess.MainWindowHandle -ne 0) {
        throw 'Native launcher exposed a visible window.'
    }
    if ([int64]$childProcess.MainWindowHandle -ne 0) {
        throw 'Node.js child exposed a visible window.'
    }

    $visibleConhosts = @(
        Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                [int]$_.ParentProcessId -eq $launcherProcess.Id -or
                [int]$_.ParentProcessId -eq $childPid
            } |
            Where-Object {
                $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
                $process -and [int64]$process.MainWindowHandle -ne 0
            }
    )
    if ($visibleConhosts.Count -ne 0) {
        throw 'Native launcher process tree exposed a visible console host.'
    }

    Stop-Process -Id $launcherProcess.Id -Force
    $launcherProcess.WaitForExit(5000) | Out-Null
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
    while (Get-Process -Id $childPid -ErrorAction SilentlyContinue) {
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            throw 'Closing the native launcher left the Node.js child process orphaned.'
        }
        Start-Sleep -Milliseconds 100
    }

    $log = Get-Content -Raw -LiteralPath $stderrPath
    if (
        $log -notmatch 'native_launcher_starting' -or
        $log -notmatch 'native_launcher_child_started'
    ) {
        throw 'Native launcher lifecycle events were not written to the diagnostic log.'
    }
}
finally {
    if ($launcherProcess -and -not $launcherProcess.HasExited) {
        Stop-Process -Id $launcherProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($childPid -gt 0) {
        Get-Process -Id $childPid -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output 'Native host launcher test passed: GUI subsystem, hidden Node process and Job Object cleanup are enforced.'
