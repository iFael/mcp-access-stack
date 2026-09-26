[CmdletBinding()]
param(
    [string]$LauncherPath,
    [string]$NodePath,
    [switch]$DirectFirst,
    [switch]$UseLauncherInPlace,
    [switch]$DiagnosticMatrix,
    [switch]$RelocationMatrix
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
$testRoot = Join-Path $tempBase ("MCP V3 native launcher smoke {0}" -f $PID)
Write-Output ('TEST_ROOT={0}' -f $testRoot)
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

function Invoke-DiagnosticScheduledCase {
    param(
        [Parameter(Mandatory = $true)][string]$CaseName,
        [Parameter(Mandatory = $true)][string]$Execute,
        [AllowEmptyString()][string]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$PrincipalUserId,
        [string]$ExpectedMarker
    )

    $caseTaskName = "MCP V3 diagnostic $CaseName"
    $startedAt = [DateTime]::Now
    $result = [ordered]@{
        Case = $CaseName
        Pass = $false
        LastTaskResult = $null
        State = $null
    }

    try {
        Unregister-ScheduledTask -TaskName $caseTaskName -Confirm:$false -ErrorAction SilentlyContinue
        if (-not [string]::IsNullOrWhiteSpace($ExpectedMarker)) {
            Remove-Item -LiteralPath $ExpectedMarker -Force -ErrorAction SilentlyContinue
        }

        $caseAction = New-ScheduledTaskAction `
            -Execute $Execute `
            -Argument $Arguments `
            -WorkingDirectory $WorkingDirectory
        $casePrincipal = New-ScheduledTaskPrincipal `
            -UserId $PrincipalUserId `
            -LogonType Interactive `
            -RunLevel Limited
        $caseSettings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -StartWhenAvailable `
            -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit ([TimeSpan]::Zero)
        $caseTask = New-ScheduledTask `
            -Action $caseAction `
            -Principal $casePrincipal `
            -Settings $caseSettings `
            -Description "MCP V3 diagnostic case $CaseName"

        Register-ScheduledTask -TaskName $caseTaskName -InputObject $caseTask -Force | Out-Null

        Write-Host ("MATRIX_CASE={0}" -f $CaseName)
        Write-Host ("MATRIX_PRINCIPAL={0}" -f $PrincipalUserId)
        Write-Host ("MATRIX_EXECUTE={0}" -f $Execute)
        Write-Host ("MATRIX_ARGUMENTS={0}" -f $Arguments)
        Write-Host ("MATRIX_WORKING_DIRECTORY={0}" -f $WorkingDirectory)

        Start-ScheduledTask -TaskName $caseTaskName
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (-not [string]::IsNullOrWhiteSpace($ExpectedMarker) -and
                (Test-Path -LiteralPath $ExpectedMarker -PathType Leaf)) {
                $result.Pass = $true
                break
            }

            $caseInfo = Get-ScheduledTaskInfo -TaskName $caseTaskName -ErrorAction SilentlyContinue
            $caseTaskState = Get-ScheduledTask -TaskName $caseTaskName -ErrorAction SilentlyContinue
            if ($caseInfo -and $caseTaskState -and
                $caseInfo.LastRunTime -ge $startedAt.AddSeconds(-2) -and
                $caseTaskState.State -eq 'Ready' -and
                [int64]$caseInfo.LastTaskResult -ne 267009) {
                if ([string]::IsNullOrWhiteSpace($ExpectedMarker) -and
                    [int64]$caseInfo.LastTaskResult -eq 0) {
                    $result.Pass = $true
                }
                break
            }
            Start-Sleep -Milliseconds 250
        }

        $finalTask = Get-ScheduledTask -TaskName $caseTaskName -ErrorAction SilentlyContinue
        $finalInfo = Get-ScheduledTaskInfo -TaskName $caseTaskName -ErrorAction SilentlyContinue
        if ($finalTask) {
            $result.State = [string]$finalTask.State
        }
        if ($finalInfo) {
            $result.LastTaskResult = [int64]$finalInfo.LastTaskResult
        }
        if (-not [string]::IsNullOrWhiteSpace($ExpectedMarker) -and
            (Test-Path -LiteralPath $ExpectedMarker -PathType Leaf)) {
            $result.Pass = $true
        }

        Write-Host ("MATRIX_RESULT={0}|{1}|LastTaskResult={2}|State={3}" -f
            $CaseName,
            $(if ($result.Pass) { 'PASS' } else { 'FAIL' }),
            [string]$result.LastTaskResult,
            [string]$result.State)

        if (-not $result.Pass) {
            try {
                Get-WinEvent -FilterHashtable @{
                    LogName = 'Microsoft-Windows-TaskScheduler/Operational'
                    StartTime = $startedAt.AddSeconds(-2)
                    Id = 101, 102, 110, 129, 200, 201, 203
                } -ErrorAction Stop |
                    Where-Object { $_.Message -like "*$caseTaskName*" } |
                    Select-Object -First 20 |
                    ForEach-Object {
                        Write-Host ("MATRIX_EVENT={0}|{1:o}|{2}|{3}" -f
                            $CaseName,
                            $_.TimeCreated,
                            $_.Id,
                            ($_.Message -replace '[\r\n]+', ' '))
                    }
            }
            catch {
                Write-Host ("MATRIX_EVENT_READ_ERROR={0}|{1}" -f $CaseName, $_.Exception.Message)
            }
        }

        return [pscustomobject]$result
    }
    catch {
        Write-Host ("MATRIX_EXCEPTION={0}|{1}" -f $CaseName, $_.Exception.Message)
        return [pscustomobject]$result
    }
    finally {
        Stop-ScheduledTask -TaskName $caseTaskName -ErrorAction SilentlyContinue
        $stopDeadline = [DateTime]::UtcNow.AddSeconds(5)
        while ([DateTime]::UtcNow -lt $stopDeadline) {
            $stoppingTask = Get-ScheduledTask -TaskName $caseTaskName -ErrorAction SilentlyContinue
            if (-not $stoppingTask -or $stoppingTask.State -ne 'Running') {
                break
            }
            Start-Sleep -Milliseconds 100
        }
        Unregister-ScheduledTask -TaskName $caseTaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}

function Write-DiagnosticLogs {
    param(
        [Parameter(Mandatory = $true)][string]$CaseName,
        [Parameter(Mandatory = $true)][string[]]$Paths
    )

    foreach ($path in $Paths) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Write-Host ("MATRIX_LOG_BEGIN={0}|{1}" -f $CaseName, $path)
            Get-Content -LiteralPath $path -Tail 80 | ForEach-Object { Write-Host $_ }
            Write-Host ("MATRIX_LOG_END={0}|{1}" -f $CaseName, $path)
        }
    }
}

function Stop-TestRootProcesses {
    $rootPath = [IO.Path]::GetFullPath($testRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $rootPrefix = $rootPath + [IO.Path]::DirectorySeparatorChar
    $deadline = [DateTime]::UtcNow.AddSeconds(10)

    while ([DateTime]::UtcNow -lt $deadline) {
        $matching = [System.Collections.Generic.List[object]]::new()
        foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
            $processPath = $null
            try {
                $processPath = [string]$process.Path
            }
            catch {
                continue
            }
            if (-not [string]::IsNullOrWhiteSpace($processPath) -and
                $processPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                $matching.Add($process)
            }
        }

        if ($matching.Count -eq 0) {
            return
        }

        foreach ($process in $matching) {
            Write-Host ("CLEANUP_PROCESS_STOP={0}|{1}|{2}" -f $process.Id, $process.ProcessName, $process.Path)
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 200
    }

    $remaining = @(
        Get-Process -ErrorAction SilentlyContinue | Where-Object {
            try {
                $path = [string]$_.Path
                -not [string]::IsNullOrWhiteSpace($path) -and
                    $path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
            }
            catch {
                $false
            }
        }
    )
    if ($remaining.Count -gt 0) {
        throw ('Temporary smoke processes did not terminate: ' + (($remaining | ForEach-Object { "{0}:{1}" -f $_.Id, $_.ProcessName }) -join ', '))
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
        'const marker = process.env.MCP_V3_NATIVE_TASK_MARKER || process.argv[2];',
        'if (!marker) {',
        '  process.exitCode = 41;',
        '} else {',
        '  fs.writeFileSync(marker, "started\\n", "utf8");',
        '  setTimeout(() => process.exit(0), 2000);',
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

    if ($RelocationMatrix) {
        $relocationResults = [System.Collections.Generic.List[object]]::new()
        $userName = [string][Security.Principal.WindowsIdentity]::GetCurrent().Name

        $nodeCopy = Join-Path $nativeOutput 'relocation node copy\node.exe'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $nodeCopy) | Out-Null
        Copy-Item -LiteralPath $nodeUnderTest -Destination $nodeCopy -Force
        $nodeSourceHash = (Get-FileHash -LiteralPath $nodeUnderTest -Algorithm SHA256).Hash
        $nodeCopyHash = (Get-FileHash -LiteralPath $nodeCopy -Algorithm SHA256).Hash
        Write-Host ("RELOCATION_HASH=node-source|{0}|{1}" -f $nodeSourceHash, $nodeUnderTest)
        Write-Host ("RELOCATION_HASH=node-copy|{0}|{1}" -f $nodeCopyHash, $nodeCopy)
        if ($nodeSourceHash -ne $nodeCopyHash) {
            throw 'Node relocation copy hash mismatch.'
        }

        $nodeCopyMarker = Join-Path $testRoot 'relocation-node-copy-marker.txt'
        $nodeCopyArgs = (Quote-TestArgument $scriptPath) + ' ' + (Quote-TestArgument $nodeCopyMarker)
        $nodeCopyResult = Invoke-DiagnosticScheduledCase `
            -CaseName 'node-temp-copy' `
            -Execute $nodeCopy `
            -Arguments $nodeCopyArgs `
            -WorkingDirectory $workingDirectory `
            -PrincipalUserId $userName `
            -ExpectedMarker $nodeCopyMarker
        $relocationResults.Add($nodeCopyResult)

        $copiedLauncher = Join-Path $nativeOutput 'relocation launcher copy\McpNodeHostLauncher.exe'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copiedLauncher) | Out-Null
        Copy-Item -LiteralPath $launcherUnderTest -Destination $copiedLauncher -Force
        $launcherSourceHash = (Get-FileHash -LiteralPath $launcherUnderTest -Algorithm SHA256).Hash
        $launcherCopyHash = (Get-FileHash -LiteralPath $copiedLauncher -Algorithm SHA256).Hash
        Write-Host ("RELOCATION_HASH=launcher-source|{0}|{1}" -f $launcherSourceHash, $launcherUnderTest)
        Write-Host ("RELOCATION_HASH=launcher-copy|{0}|{1}" -f $launcherCopyHash, $copiedLauncher)
        if ($launcherSourceHash -ne $launcherCopyHash) {
            throw 'Launcher relocation copy hash mismatch.'
        }

        $bothCopyMarker = Join-Path $testRoot 'relocation-both-copy-marker.txt'
        $bothCopyStdout = Join-Path $logsRoot 'relocation-both-copy.stdout.log'
        $bothCopyStderr = Join-Path $logsRoot 'relocation-both-copy.stderr.log'
        $bothCopyArgs = @(
            '--node', (Quote-TestArgument $nodeCopy),
            '--stdout-log', (Quote-TestArgument $bothCopyStdout),
            '--stderr-log', (Quote-TestArgument $bothCopyStderr),
            '--runner-restart-count', '0',
            '--runner-restart-interval-seconds', '60',
            '--env', (Quote-TestArgument ("MCP_V3_NATIVE_TASK_MARKER=$bothCopyMarker")),
            '--', (Quote-TestArgument $scriptPath)
        ) -join ' '
        $bothCopyResult = Invoke-DiagnosticScheduledCase `
            -CaseName 'launcher-temp-copy-node-temp-copy' `
            -Execute $copiedLauncher `
            -Arguments $bothCopyArgs `
            -WorkingDirectory $workingDirectory `
            -PrincipalUserId $userName `
            -ExpectedMarker $bothCopyMarker
        $relocationResults.Add($bothCopyResult)
        if (-not $bothCopyResult.Pass) {
            Write-DiagnosticLogs -CaseName 'launcher-temp-copy-node-temp-copy' -Paths @($bothCopyStdout, $bothCopyStderr)
        }

        $testRootDrive = [IO.Path]::GetPathRoot($testRoot)
        $nodeDrive = [IO.Path]::GetPathRoot($nodeUnderTest)
        if ([string]::Equals($testRootDrive, $nodeDrive, [StringComparison]::OrdinalIgnoreCase)) {
            $nodeHardLink = Join-Path $nativeOutput 'relocation node hardlink\node.exe'
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $nodeHardLink) | Out-Null
            try {
                New-Item -ItemType HardLink -Path $nodeHardLink -Target $nodeUnderTest -ErrorAction Stop | Out-Null
                $nodeHardLinkHash = (Get-FileHash -LiteralPath $nodeHardLink -Algorithm SHA256).Hash
                Write-Host ("RELOCATION_HASH=node-hardlink|{0}|{1}" -f $nodeHardLinkHash, $nodeHardLink)
                $nodeHardLinkMarker = Join-Path $testRoot 'relocation-node-hardlink-marker.txt'
                $nodeHardLinkArgs = (Quote-TestArgument $scriptPath) + ' ' + (Quote-TestArgument $nodeHardLinkMarker)
                $nodeHardLinkResult = Invoke-DiagnosticScheduledCase `
                    -CaseName 'node-temp-hardlink' `
                    -Execute $nodeHardLink `
                    -Arguments $nodeHardLinkArgs `
                    -WorkingDirectory $workingDirectory `
                    -PrincipalUserId $userName `
                    -ExpectedMarker $nodeHardLinkMarker
                $relocationResults.Add($nodeHardLinkResult)
            }
            catch {
                Write-Host ("MATRIX_SKIP=node-temp-hardlink|{0}" -f $_.Exception.Message)
            }
        }
        else {
            Write-Host ("MATRIX_SKIP=node-temp-hardlink|cross-volume source={0} temp={1}" -f $nodeDrive, $testRootDrive)
        }

        $launcherDrive = [IO.Path]::GetPathRoot($launcherUnderTest)
        if ([string]::Equals($testRootDrive, $launcherDrive, [StringComparison]::OrdinalIgnoreCase)) {
            $launcherHardLink = Join-Path $nativeOutput 'relocation launcher hardlink\McpNodeHostLauncher.exe'
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcherHardLink) | Out-Null
            try {
                New-Item -ItemType HardLink -Path $launcherHardLink -Target $launcherUnderTest -ErrorAction Stop | Out-Null
                $launcherHardLinkHash = (Get-FileHash -LiteralPath $launcherHardLink -Algorithm SHA256).Hash
                Write-Host ("RELOCATION_HASH=launcher-hardlink|{0}|{1}" -f $launcherHardLinkHash, $launcherHardLink)
                $launcherHardMarker = Join-Path $testRoot 'relocation-launcher-hardlink-marker.txt'
                $launcherHardStdout = Join-Path $logsRoot 'relocation-launcher-hardlink.stdout.log'
                $launcherHardStderr = Join-Path $logsRoot 'relocation-launcher-hardlink.stderr.log'
                $launcherHardArgs = @(
                    '--node', (Quote-TestArgument $nodeCopy),
                    '--stdout-log', (Quote-TestArgument $launcherHardStdout),
                    '--stderr-log', (Quote-TestArgument $launcherHardStderr),
                    '--runner-restart-count', '0',
                    '--runner-restart-interval-seconds', '60',
                    '--env', (Quote-TestArgument ("MCP_V3_NATIVE_TASK_MARKER=$launcherHardMarker")),
                    '--', (Quote-TestArgument $scriptPath)
                ) -join ' '
                $launcherHardResult = Invoke-DiagnosticScheduledCase `
                    -CaseName 'launcher-temp-hardlink-node-temp-copy' `
                    -Execute $launcherHardLink `
                    -Arguments $launcherHardArgs `
                    -WorkingDirectory $workingDirectory `
                    -PrincipalUserId $userName `
                    -ExpectedMarker $launcherHardMarker
                $relocationResults.Add($launcherHardResult)
                if (-not $launcherHardResult.Pass) {
                    Write-DiagnosticLogs -CaseName 'launcher-temp-hardlink-node-temp-copy' -Paths @($launcherHardStdout, $launcherHardStderr)
                }
            }
            catch {
                Write-Host ("MATRIX_SKIP=launcher-temp-hardlink-node-temp-copy|{0}" -f $_.Exception.Message)
            }
        }
        else {
            Write-Host ("MATRIX_SKIP=launcher-temp-hardlink-node-temp-copy|cross-volume source={0} temp={1}" -f $launcherDrive, $testRootDrive)
        }

        $relocationSummary = $relocationResults | ForEach-Object {
            "{0}:{1}:{2}" -f $_.Case, $(if ($_.Pass) { 'PASS' } else { 'FAIL' }), [string]$_.LastTaskResult
        }
        Write-Output ('RELOCATION_SUMMARY=' + ($relocationSummary -join ','))
        return
    }
    if ($DiagnosticMatrix) {
        $matrixResults = [System.Collections.Generic.List[object]]::new()
        $userIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $userName = [string]$userIdentity.Name
        $userSid = [string]$userIdentity.User.Value
        $comSpec = [Environment]::ExpandEnvironmentVariables('%SystemRoot%\System32\cmd.exe')
        if (-not (Test-Path -LiteralPath $comSpec -PathType Leaf)) {
            throw "cmd.exe was not found: $comSpec"
        }

        $matrixResults.Add((Invoke-DiagnosticScheduledCase `
            -CaseName 'cmd-baseline' `
            -Execute $comSpec `
            -Arguments '/d /s /c exit 0' `
            -WorkingDirectory $workingDirectory `
            -PrincipalUserId $userName))

        $nodeMarker = Join-Path $testRoot 'matrix-node-marker.txt'
        $nodeArgs = (Quote-TestArgument $scriptPath) + ' ' + (Quote-TestArgument $nodeMarker)
        $matrixResults.Add((Invoke-DiagnosticScheduledCase `
            -CaseName 'node-release-path' `
            -Execute $nodeUnderTest `
            -Arguments $nodeArgs `
            -WorkingDirectory $workingDirectory `
            -PrincipalUserId $userName `
            -ExpectedMarker $nodeMarker))

        $copiedLauncher = Join-Path $nativeOutput 'matrix copied launcher\McpNodeHostLauncher.exe'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copiedLauncher) | Out-Null
        Copy-Item -LiteralPath $launcherUnderTest -Destination $copiedLauncher -Force

        $copyMarker = Join-Path $testRoot 'matrix-launcher-copy-marker.txt'
        $copyStdout = Join-Path $logsRoot 'matrix-launcher-copy.stdout.log'
        $copyStderr = Join-Path $logsRoot 'matrix-launcher-copy.stderr.log'
        $copyArgs = @(
            '--node', (Quote-TestArgument $nodeUnderTest),
            '--stdout-log', (Quote-TestArgument $copyStdout),
            '--stderr-log', (Quote-TestArgument $copyStderr),
            '--runner-restart-count', '0',
            '--runner-restart-interval-seconds', '60',
            '--env', (Quote-TestArgument ("MCP_V3_NATIVE_TASK_MARKER=$copyMarker")),
            '--', (Quote-TestArgument $scriptPath)
        ) -join ' '
        $matrixResults.Add((Invoke-DiagnosticScheduledCase `
            -CaseName 'launcher-temp-copy' `
            -Execute $copiedLauncher `
            -Arguments $copyArgs `
            -WorkingDirectory $workingDirectory `
            -PrincipalUserId $userName `
            -ExpectedMarker $copyMarker))

        $inPlaceMarker = Join-Path $testRoot 'matrix-launcher-inplace-marker.txt'
        $inPlaceStdout = Join-Path $logsRoot 'matrix-launcher-inplace.stdout.log'
        $inPlaceStderr = Join-Path $logsRoot 'matrix-launcher-inplace.stderr.log'
        $inPlaceArgs = @(
            '--node', (Quote-TestArgument $nodeUnderTest),
            '--stdout-log', (Quote-TestArgument $inPlaceStdout),
            '--stderr-log', (Quote-TestArgument $inPlaceStderr),
            '--runner-restart-count', '0',
            '--runner-restart-interval-seconds', '60',
            '--env', (Quote-TestArgument ("MCP_V3_NATIVE_TASK_MARKER=$inPlaceMarker")),
            '--', (Quote-TestArgument $scriptPath)
        ) -join ' '
        $matrixResults.Add((Invoke-DiagnosticScheduledCase `
            -CaseName 'launcher-inplace-name-principal' `
            -Execute $launcherUnderTest `
            -Arguments $inPlaceArgs `
            -WorkingDirectory $workingDirectory `
            -PrincipalUserId $userName `
            -ExpectedMarker $inPlaceMarker))

        $sidMarker = Join-Path $testRoot 'matrix-launcher-sid-marker.txt'
        $sidStdout = Join-Path $logsRoot 'matrix-launcher-sid.stdout.log'
        $sidStderr = Join-Path $logsRoot 'matrix-launcher-sid.stderr.log'
        $sidArgs = @(
            '--node', (Quote-TestArgument $nodeUnderTest),
            '--stdout-log', (Quote-TestArgument $sidStdout),
            '--stderr-log', (Quote-TestArgument $sidStderr),
            '--runner-restart-count', '0',
            '--runner-restart-interval-seconds', '60',
            '--env', (Quote-TestArgument ("MCP_V3_NATIVE_TASK_MARKER=$sidMarker")),
            '--', (Quote-TestArgument $scriptPath)
        ) -join ' '
        $matrixResults.Add((Invoke-DiagnosticScheduledCase `
            -CaseName 'launcher-inplace-sid-principal' `
            -Execute $launcherUnderTest `
            -Arguments $sidArgs `
            -WorkingDirectory $workingDirectory `
            -PrincipalUserId $userSid `
            -ExpectedMarker $sidMarker))

        $wrapperMarker = Join-Path $testRoot 'matrix-cmd-wrapper-marker.txt'
        $wrapperStdout = Join-Path $logsRoot 'matrix-cmd-wrapper.stdout.log'
        $wrapperStderr = Join-Path $logsRoot 'matrix-cmd-wrapper.stderr.log'
        $wrapperArgs = @(
            '--node', (Quote-TestArgument $nodeUnderTest),
            '--stdout-log', (Quote-TestArgument $wrapperStdout),
            '--stderr-log', (Quote-TestArgument $wrapperStderr),
            '--runner-restart-count', '0',
            '--runner-restart-interval-seconds', '60',
            '--env', (Quote-TestArgument ("MCP_V3_NATIVE_TASK_MARKER=$wrapperMarker")),
            '--', (Quote-TestArgument $scriptPath)
        ) -join ' '
        $wrapperPath = Join-Path $testRoot 'launch-wrapper.cmd'
        $wrapperContent = @(
            '@echo off',
            ('"' + $launcherUnderTest + '" ' + $wrapperArgs),
            'exit /b %ERRORLEVEL%'
        ) -join [Environment]::NewLine
        [IO.File]::WriteAllText($wrapperPath, $wrapperContent, [Text.Encoding]::ASCII)
        $cmdWrapperArgs = '/d /s /c ""' + $wrapperPath + '""'
        $matrixResults.Add((Invoke-DiagnosticScheduledCase `
            -CaseName 'cmd-wrapper-launcher' `
            -Execute $comSpec `
            -Arguments $cmdWrapperArgs `
            -WorkingDirectory $workingDirectory `
            -PrincipalUserId $userName `
            -ExpectedMarker $wrapperMarker))

        $summary = $matrixResults | ForEach-Object {
            "{0}:{1}:{2}" -f $_.Case, $(if ($_.Pass) { 'PASS' } else { 'FAIL' }), [string]$_.LastTaskResult
        }
        Write-Output ('MATRIX_SUMMARY=' + ($summary -join ','))
        return
    }
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
    $mainStopDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $mainStopDeadline) {
        $mainStoppingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (-not $mainStoppingTask -or $mainStoppingTask.State -ne 'Running') {
            break
        }
        Start-Sleep -Milliseconds 100
    }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Stop-TestRootProcesses
    for ($cleanupAttempt = 0; $cleanupAttempt -lt 20; $cleanupAttempt++) {
        try {
            Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction Stop
            break
        }
        catch {
            if ($cleanupAttempt -eq 19) {
                throw
            }
            Start-Sleep -Milliseconds 250
        }
    }
}
