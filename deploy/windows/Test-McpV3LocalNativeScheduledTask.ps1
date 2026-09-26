[CmdletBinding()]
param(
    [string]$LauncherPath,
    [string]$NodePath,
    [switch]$DirectFirst,
    [switch]$UseLauncherInPlace
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'MCP V3 native Scheduled Task smoke test requires Windows.'
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskName = 'MCP V3 native launcher smoke'
$tempBase = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    [IO.Path]::GetTempPath()
}
else {
    [IO.Path]::GetFullPath($env:RUNNER_TEMP)
}
$testRoot = Join-Path $tempBase 'MCP V3 native launcher smoke'
$nativeOutput = Join-Path $testRoot 'native'
$workingDirectory = Join-Path $testRoot 'release root with spaces'
$logsRoot = Join-Path $testRoot 'logs'
$stdoutLog = Join-Path $logsRoot 'launcher.stdout.log'
$stderrLog = Join-Path $logsRoot 'launcher.stderr.log'
$markerPath = Join-Path $testRoot 'child-started.txt'
$scriptPath = Join-Path $workingDirectory 'child smoke.js'
$buildScript = Join-Path $root 'deploy\windows\New-McpWindowsExecutionNodeArtifacts.ps1'

function Quote-TestArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) {
        throw 'Native Scheduled Task smoke paths cannot contain quotes.'
    }
    return '"' + $Value + '"'
}

function Get-TaskFailureEvidence {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
        Write-Output ('TASK_STATE={0}' -f [string]$task.State)
        if ($info) {
            Write-Output ('TASK_LAST_RESULT={0}' -f [string]$info.LastTaskResult)
            Write-Output ('TASK_LAST_RUN={0:o}' -f $info.LastRunTime)
        }
        foreach ($action in @($task.Actions)) {
            Write-Output ('TASK_EXECUTE={0}' -f [string]$action.Execute)
            Write-Output ('TASK_ARGUMENTS={0}' -f [string]$action.Arguments)
            Write-Output ('TASK_WORKING_DIRECTORY={0}' -f [string]$action.WorkingDirectory)
        }
    }

    $start = [DateTime]::Now.AddMinutes(-5)
    try {
        Get-WinEvent -FilterHashtable @{
            LogName = 'Microsoft-Windows-TaskScheduler/Operational'
            StartTime = $start
            Id = 101, 102, 110, 129, 200, 201, 203
        } -ErrorAction Stop |
            Where-Object { $_.Message -like "*$taskName*" } |
            Select-Object -First 30 |
            ForEach-Object {
                Write-Output ('TASK_EVENT={0:o}|{1}|{2}' -f $_.TimeCreated, $_.Id, ($_.Message -replace '[\r\n]+', ' '))
            }
    }
    catch {
        Write-Output ('TASK_EVENT_READ_ERROR={0}' -f $_.Exception.Message)
    }

    foreach ($log in @($stdoutLog, $stderrLog)) {
        if (Test-Path -LiteralPath $log -PathType Leaf) {
            Write-Output ('LOG_BEGIN={0}' -f $log)
            Get-Content -LiteralPath $log -Tail 80
            Write-Output ('LOG_END={0}' -f $log)
        }
    }
}

try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $nativeOutput, $workingDirectory, $logsRoot | Out-Null

    if ([string]::IsNullOrWhiteSpace($LauncherPath)) {
        $commit = (git -C $root rev-parse --verify HEAD).Trim()
        & $buildScript `
            -ReleaseId '0.0.0-ci.native-task-smoke' `
            -SourceCommit $commit `
            -OutputDirectory $nativeOutput | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'Native artifact build failed.'
        }
        $launcherUnderTest = Join-Path $nativeOutput 'McpNodeHostLauncher.exe'
    }
    else {
        $sourceLauncher = [IO.Path]::GetFullPath($LauncherPath)
        if (-not (Test-Path -LiteralPath $sourceLauncher -PathType Leaf)) {
            throw "Provided native launcher was not found: $sourceLauncher"
        }
        if ($UseLauncherInPlace) {
            $launcherUnderTest = $sourceLauncher
        }
        else {
            $signedTarget = Join-Path $nativeOutput 'signed launcher with spaces\McpNodeHostLauncher.exe'
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $signedTarget) | Out-Null
            Copy-Item -LiteralPath $sourceLauncher -Destination $signedTarget -Force
            $launcherUnderTest = $signedTarget
        }
    }
    if ($UseLauncherInPlace -and [string]::IsNullOrWhiteSpace($LauncherPath)) {
        throw '-UseLauncherInPlace requires -LauncherPath.'
    }
    if (-not (Test-Path -LiteralPath $launcherUnderTest -PathType Leaf)) {
        throw "Native launcher was not materialized: $launcherUnderTest"
    }
    Write-Output ('LAUNCHER_UNDER_TEST={0}' -f $launcherUnderTest)

    if ([string]::IsNullOrWhiteSpace($NodePath)) {
        $nodeUnderTest = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    }
    else {
        $nodeUnderTest = [IO.Path]::GetFullPath($NodePath)
    }
    if (-not (Test-Path -LiteralPath $nodeUnderTest -PathType Leaf)) {
        throw "Node.js executable was not found: $nodeUnderTest"
    }

    $childScript = @(
        'const fs = require("node:fs");',
        'const marker = process.env.MCP_V3_NATIVE_TASK_MARKER;',
        'if (!marker) {',
        '  process.exitCode = 41;',
        '} else {',
        '  fs.writeFileSync(marker, "started\\n", "utf8");',
        '  setTimeout(() => process.exit(0), 20000);',
        '}'
    ) -join [Environment]::NewLine
    [IO.File]::WriteAllText($scriptPath, $childScript, [Text.UTF8Encoding]::new($false))

    $arguments = @(
        '--node', (Quote-TestArgument $nodeUnderTest),
        '--stdout-log', (Quote-TestArgument $stdoutLog),
        '--stderr-log', (Quote-TestArgument $stderrLog),
        '--runner-restart-count', '0',
        '--runner-restart-interval-seconds', '60',
        '--env', (Quote-TestArgument ("MCP_V3_NATIVE_TASK_MARKER=$markerPath")),
        '--', (Quote-TestArgument $scriptPath)
    ) -join ' '

    if ($DirectFirst) {
        $directMarkerPath = Join-Path $testRoot 'direct-child-started.txt'
        $directStdoutLog = Join-Path $logsRoot 'direct-launcher.stdout.log'
        $directStderrLog = Join-Path $logsRoot 'direct-launcher.stderr.log'
        $directArguments = @(
            '--node', (Quote-TestArgument $nodeUnderTest),
            '--stdout-log', (Quote-TestArgument $directStdoutLog),
            '--stderr-log', (Quote-TestArgument $directStderrLog),
            '--runner-restart-count', '0',
            '--runner-restart-interval-seconds', '60',
            '--env', (Quote-TestArgument ("MCP_V3_NATIVE_TASK_MARKER=$directMarkerPath")),
            '--', (Quote-TestArgument $scriptPath)
        ) -join ' '

        $directProcess = Start-Process             -FilePath $launcherUnderTest             -ArgumentList $directArguments             -WorkingDirectory $workingDirectory             -PassThru
        $directDeadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $directDeadline) {
            if (Test-Path -LiteralPath $directMarkerPath -PathType Leaf) {
                break
            }
            if ($directProcess.HasExited) {
                break
            }
            Start-Sleep -Milliseconds 250
        }

        if (-not (Test-Path -LiteralPath $directMarkerPath -PathType Leaf)) {
            foreach ($log in @($directStdoutLog, $directStderrLog)) {
                if (Test-Path -LiteralPath $log -PathType Leaf) {
                    Write-Output ('DIRECT_LOG_BEGIN={0}' -f $log)
                    Get-Content -LiteralPath $log -Tail 80
                    Write-Output ('DIRECT_LOG_END={0}' -f $log)
                }
            }
            $directExit = if ($directProcess.HasExited) { [string]$directProcess.ExitCode } else { 'running' }
            throw "Direct McpNodeHostLauncher smoke did not start its child process. exit=$directExit"
        }

        $directStderr = if (Test-Path -LiteralPath $directStderrLog -PathType Leaf) {
            Get-Content -LiteralPath $directStderrLog -Raw
        }
        else {
            ''
        }
        if (-not $directStderr.Contains('native_launcher_starting') -or
            -not $directStderr.Contains('native_launcher_child_started')) {
            throw 'Direct native launcher did not write the expected startup evidence.'
        }

        Write-Output 'MCP V3 direct native launcher smoke passed.'
        if (-not $directProcess.HasExited) {
            Stop-Process -Id $directProcess.Id -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $directProcess.Id -ErrorAction SilentlyContinue
        }
    }

    $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ([string]::IsNullOrWhiteSpace($userId)) {
        throw 'Current Windows user identity could not be resolved.'
    }

    $action = New-ScheduledTaskAction `
        -Execute $launcherUnderTest `
        -Argument $arguments `
        -WorkingDirectory $workingDirectory
    $principal = New-ScheduledTaskPrincipal `
        -UserId $userId `
        -LogonType Interactive `
        -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    $task = New-ScheduledTask `
        -Action $action `
        -Principal $principal `
        -Settings $settings `
        -Description 'MCP V3 CI smoke test for the real native launcher through Task Scheduler.'

    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

    $registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $registeredAction = @($registered.Actions)
    if ($registeredAction.Count -ne 1 -or
        [IO.Path]::GetFullPath([string]$registeredAction[0].Execute) -ne [IO.Path]::GetFullPath($launcherUnderTest) -or
        [IO.Path]::GetFullPath([string]$registeredAction[0].WorkingDirectory) -ne [IO.Path]::GetFullPath($workingDirectory) -or
        [string]$registeredAction[0].Arguments -ne $arguments) {
        throw 'Registered Scheduled Task action does not match the native launcher smoke contract.'
    }

    Start-ScheduledTask -TaskName $taskName

    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
            break
        }
        Start-Sleep -Milliseconds 500
    }

    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        Get-TaskFailureEvidence
        throw 'Real McpNodeHostLauncher Scheduled Task did not start its child process.'
    }

    $stderr = if (Test-Path -LiteralPath $stderrLog -PathType Leaf) {
        Get-Content -LiteralPath $stderrLog -Raw
    }
    else {
        ''
    }
    if (-not $stderr.Contains('native_launcher_starting') -or
        -not $stderr.Contains('native_launcher_child_started')) {
        Get-TaskFailureEvidence
        throw 'Real native launcher did not write the expected startup evidence.'
    }

    Write-Output 'MCP V3 real native launcher Scheduled Task smoke passed.'
}
finally {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
