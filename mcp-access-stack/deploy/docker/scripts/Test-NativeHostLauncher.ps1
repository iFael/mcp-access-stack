[CmdletBinding()]
param(
    [switch]$ScheduledTaskQualification
)

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
$secretPath = Join-Path $tempRoot 'secret.txt'
$secretValue = 'fixture-secret-value'
$launcherProcess = $null
$childPid = 0
$scheduledTaskName = 'MCP Access Stack native launcher qualification ' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$scheduledLauncherPid = 0
$scheduledChildPid = 0

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

writeFileSync(
  process.argv[2],
  JSON.stringify({
    pid: process.pid,
    literal: process.env.MCP_TEST_LITERAL,
    secret: process.env.MCP_TEST_SECRET,
  }),
  "utf8",
);
while (!existsSync(process.argv[3])) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
'@
    [System.IO.File]::WriteAllText(
        $scriptPath,
        $fixtureSource,
        [System.Text.UTF8Encoding]::new($false)
    )

    [System.IO.File]::WriteAllText($secretPath, $secretValue + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

    $arguments = @(
        '--node',
        (Quote-NativeArgument $nodePath),
        '--stdout-log',
        (Quote-NativeArgument $stdoutPath),
        '--stderr-log',
        (Quote-NativeArgument $stderrPath),
        '--env',
        (Quote-NativeArgument 'MCP_TEST_LITERAL=literal-value'),
        '--env-file',
        (Quote-NativeArgument ('MCP_TEST_SECRET=' + $secretPath)),
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
    if ([string]$state.literal -ne 'literal-value' -or [string]$state.secret -ne $secretValue) {
        throw 'Native launcher did not inject literal/file-backed environment values into the Node.js child.'
    }
    $childProcess = Get-Process -Id $childPid -ErrorAction Stop
    $childCim = Get-CimInstance Win32_Process -Filter "ProcessId=$childPid" -ErrorAction Stop
    $launcherCim = Get-CimInstance Win32_Process -Filter "ProcessId=$($launcherProcess.Id)" -ErrorAction Stop
    if ([string]$launcherCim.CommandLine -match [regex]::Escape($secretValue)) {
        throw 'Native launcher exposed a file-backed secret in its command line.'
    }
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
    if ($log.Contains($secretValue)) {
        throw 'Native launcher diagnostic log exposed a file-backed secret.'
    }

    if (
        $log -notmatch 'native_launcher_starting' -or
        $log -notmatch 'native_launcher_child_started'
    ) {
        throw 'Native launcher lifecycle events were not written to the diagnostic log.'
    }

    if ($ScheduledTaskQualification) {
        $scheduledStatePath = Join-Path $tempRoot 'scheduled-state.json'
        $scheduledStopPath = Join-Path $tempRoot 'scheduled-stop.signal'
        $scheduledStdoutPath = Join-Path $tempRoot 'scheduled-stdout.log'
        $scheduledStderrPath = Join-Path $tempRoot 'scheduled-stderr.log'
        $scheduledArguments = @(
            '--node',
            (Quote-NativeArgument $nodePath),
            '--stdout-log',
            (Quote-NativeArgument $scheduledStdoutPath),
            '--stderr-log',
            (Quote-NativeArgument $scheduledStderrPath),
            '--',
            (Quote-NativeArgument $scriptPath),
            (Quote-NativeArgument $scheduledStatePath),
            (Quote-NativeArgument $scheduledStopPath)
        ) -join ' '

        $terminalBaseline = @(
            Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -in @('conhost.exe', 'OpenConsole.exe', 'WindowsTerminal.exe', 'wt.exe') } |
                ForEach-Object { [int]$_.ProcessId }
        )

        $principal = New-ScheduledTaskPrincipal `
            -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
            -LogonType Interactive `
            -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
            -Hidden
        $action = New-ScheduledTaskAction `
            -Execute $launcherPath `
            -Argument $scheduledArguments `
            -WorkingDirectory $tempRoot
        $scheduledTask = New-ScheduledTask `
            -Action $action `
            -Principal $principal `
            -Settings $settings `
            -Description 'Temporary qualification of native MCP launcher terminal independence.'
        Register-ScheduledTask -TaskName $scheduledTaskName -InputObject $scheduledTask | Out-Null
        Start-ScheduledTask -TaskName $scheduledTaskName

        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
        while (-not (Test-Path -LiteralPath $scheduledStatePath -PathType Leaf)) {
            $task = Get-ScheduledTask -TaskName $scheduledTaskName -ErrorAction Stop
            if ([string]$task.State -ne 'Running') {
                $stderr = if (Test-Path -LiteralPath $scheduledStderrPath) {
                    Get-Content -Raw -LiteralPath $scheduledStderrPath
                }
                else {
                    ''
                }
                throw "Scheduled launcher qualification exited before fixture readiness. state=$($task.State) stderr=$stderr"
            }
            if ([DateTimeOffset]::UtcNow -ge $deadline) {
                throw 'Scheduled launcher qualification did not create its state file.'
            }
            Start-Sleep -Milliseconds 100
        }

        $scheduledState = Get-Content -Raw -LiteralPath $scheduledStatePath | ConvertFrom-Json
        $scheduledChildPid = [int]$scheduledState.pid
        $scheduledChildCim = Get-CimInstance Win32_Process -Filter "ProcessId=$scheduledChildPid" -ErrorAction Stop
        $scheduledLauncherPid = [int]$scheduledChildCim.ParentProcessId
        $scheduledLauncherCim = Get-CimInstance Win32_Process -Filter "ProcessId=$scheduledLauncherPid" -ErrorAction Stop
        if ([string]$scheduledLauncherCim.Name -ne 'McpNodeHostLauncher.exe') {
            throw "Scheduled qualification owner is not the native launcher: $($scheduledLauncherCim.Name)"
        }
        $scheduledLauncherProcess = Get-Process -Id $scheduledLauncherPid -ErrorAction Stop
        $scheduledChildProcess = Get-Process -Id $scheduledChildPid -ErrorAction Stop
        if ([int64]$scheduledLauncherProcess.MainWindowHandle -ne 0 -or
            [int64]$scheduledChildProcess.MainWindowHandle -ne 0) {
            throw 'Scheduled native launcher or Node.js child exposed a window.'
        }

        $consoleChildren = @(
            Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.Name -in @('conhost.exe', 'OpenConsole.exe') -and
                    ([int]$_.ParentProcessId -eq $scheduledLauncherPid -or
                     [int]$_.ParentProcessId -eq $scheduledChildPid)
                } |
                ForEach-Object {
                    $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
                    [pscustomobject]@{
                        processId = [int]$_.ProcessId
                        parentProcessId = [int]$_.ParentProcessId
                        name = [string]$_.Name
                        mainWindowHandle = if ($process) { [int64]$process.MainWindowHandle } else { -1 }
                    }
                }
        )
        $visibleConsoleChildren = @($consoleChildren | Where-Object { [int64]$_.mainWindowHandle -ne 0 })
        if ($visibleConsoleChildren.Count -ne 0) {
            throw 'Scheduled native launcher process tree exposed a visible console window.'
        }

        $launcherCreated = [DateTime]$scheduledLauncherCim.CreationDate
        $newTerminalWindows = @(
            Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.Name -in @('OpenConsole.exe', 'WindowsTerminal.exe', 'wt.exe') -and
                    [int]$_.ProcessId -notin $terminalBaseline
                } |
                Where-Object {
                    [Math]::Abs((([DateTime]$_.CreationDate) - $launcherCreated).TotalSeconds) -le 3
                } |
                Where-Object {
                    $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
                    $process -and [int64]$process.MainWindowHandle -ne 0
                }
        )
        if ($newTerminalWindows.Count -ne 0) {
            throw 'Scheduled native launcher created a visible terminal window.'
        }

        $originalTaskInfo = Get-ScheduledTaskInfo -TaskName $scheduledTaskName -ErrorAction Stop
        Start-Sleep -Seconds 5
        if (-not (Get-Process -Id $scheduledLauncherPid -ErrorAction SilentlyContinue)) {
            throw 'Scheduled native launcher PID did not survive the observation window.'
        }
        if (-not (Get-Process -Id $scheduledChildPid -ErrorAction SilentlyContinue)) {
            throw 'Scheduled Node.js PID did not survive the observation window.'
        }
        $taskAfterObservation = Get-ScheduledTask -TaskName $scheduledTaskName -ErrorAction Stop
        $taskInfoAfterObservation = Get-ScheduledTaskInfo -TaskName $scheduledTaskName -ErrorAction Stop
        if ([string]$taskAfterObservation.State -ne 'Running') {
            throw "Scheduled native launcher is not Running after observation: $($taskAfterObservation.State)"
        }
        if ($taskInfoAfterObservation.LastRunTime -ne $originalTaskInfo.LastRunTime) {
            throw 'Scheduled native launcher restarted during the observation window.'
        }

        [IO.File]::WriteAllText($scheduledStopPath, 'stop', [Text.UTF8Encoding]::new($false))
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
        do {
            $taskAfterStop = Get-ScheduledTask -TaskName $scheduledTaskName -ErrorAction Stop
            if ([string]$taskAfterStop.State -ne 'Running') {
                break
            }
            if ([DateTimeOffset]::UtcNow -ge $deadline) {
                throw 'Scheduled native launcher did not exit after fixture stop signal.'
            }
            Start-Sleep -Milliseconds 100
        } while ($true)

        if (Get-Process -Id $scheduledChildPid -ErrorAction SilentlyContinue) {
            throw 'Scheduled Node.js fixture remained alive after the stop signal.'
        }
        Write-Output 'Scheduled Task qualification passed: native launcher owns Node.js without a visible console or terminal window and preserves the same PIDs.'
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
    if ($scheduledChildPid -gt 0) {
        Get-Process -Id $scheduledChildPid -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
    }
    if ($scheduledLauncherPid -gt 0) {
        Get-Process -Id $scheduledLauncherPid -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
    }
    $scheduledTask = Get-ScheduledTask -TaskName $scheduledTaskName -ErrorAction SilentlyContinue
    if ($scheduledTask) {
        if ([string]$scheduledTask.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $scheduledTaskName -ErrorAction SilentlyContinue
        }
        Unregister-ScheduledTask -TaskName $scheduledTaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output 'Native host launcher test passed: GUI subsystem, hidden Node process, environment injection and Job Object cleanup are enforced.'
