[CmdletBinding()]
param(
    [string]$TaskName = 'MCP Access Stack production edge-connector',
    [string]$HealthUri = 'https://mcp-access-stack.rafaeldamasio77.workers.dev/health',
    [string]$EvidencePath,
    [string]$ProbeTaskName,
    [ValidateRange(2, 60)][int]$ObservationSeconds = 8,
    [switch]$Execute,
    [switch]$Probe,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Quote-McpTerminalProbeArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) { throw 'Terminal-independence probe arguments cannot contain quotes.' }
    return '"' + $Value + '"'
}

function Write-McpTerminalProbeEvidence {
    param([Parameter(Mandatory = $true)][string]$Path,[Parameter(Mandatory = $true)][object]$Value)
    $resolved=[IO.Path]::GetFullPath($Path)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolved)|Out-Null
    $temporary=$resolved+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    try {
        [IO.File]::WriteAllText($temporary,(($Value|ConvertTo-Json -Depth 12)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $resolved -Force
    }
    finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function Get-McpTerminalProbeHealth {
    param([Parameter(Mandatory = $true)][string]$Uri)
    try {
        $health=Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 10
        [pscustomobject]@{reachable=$true;status=[string]$health.status;edgeEnabled=[bool]$health.edgeEnabled;connectorReady=[bool]$health.connectorReady;error=$null}
    }
    catch { [pscustomobject]@{reachable=$false;status=$null;edgeEnabled=$false;connectorReady=$false;error=$_.Exception.Message} }
}

function Get-McpEdgeProcessSnapshot {
    $all=@(Get-CimInstance Win32_Process)
    $nodes=@($all|Where-Object{$_.Name -eq 'node.exe' -and [string]$_.CommandLine -match 'edge-connector-cli\.js'})
    if($nodes.Count -ne 1){throw "Expected exactly one Edge Connector Node.js process, found $($nodes.Count)."}
    $node=$nodes[0]
    $launchers=@($all|Where-Object{[int]$_.ProcessId -eq [int]$node.ParentProcessId})
    if($launchers.Count -ne 1){throw 'Edge Connector launcher process could not be resolved from the Node.js parent.'}
    $launcher=$launchers[0]
    [pscustomobject]@{
        launcherPid=[int]$launcher.ProcessId
        launcherName=[string]$launcher.Name
        launcherExecutablePath=[string]$launcher.ExecutablePath
        launcherCommandLine=[string]$launcher.CommandLine
        launcherCreationDate=$launcher.CreationDate
        launcherSessionId=[int]$launcher.SessionId
        nodePid=[int]$node.ProcessId
        nodeCommandLine=[string]$node.CommandLine
        nodeCreationDate=$node.CreationDate
    }
}

function Get-McpEdgeConsoleSnapshot {
    param([Parameter(Mandatory = $true)][object]$Process)
    $all=@(Get-CimInstance Win32_Process)
    $consoleHosts=@(
        $all|Where-Object{
            [int]$_.ParentProcessId -in @([int]$Process.launcherPid,[int]$Process.nodePid) -and
            $_.Name -in @('conhost.exe','OpenConsole.exe')
        }|ForEach-Object{
            $native=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            [pscustomobject]@{processId=[int]$_.ProcessId;parentProcessId=[int]$_.ParentProcessId;sessionId=[int]$_.SessionId;name=[string]$_.Name;creationDate=$_.CreationDate;mainWindowHandle=if($native){[int64]$native.MainWindowHandle}else{-1};mainWindowTitle=if($native){[string]$native.MainWindowTitle}else{''}}
        }
    )
    $terminalWindows=@()
    foreach($candidate in @($all|Where-Object{[int]$_.SessionId -eq [int]$Process.launcherSessionId -and $_.Name -in @('WindowsTerminal.exe','wt.exe')})){
        $native=Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
        if(-not $native -or [int64]$native.MainWindowHandle -eq 0){continue}
        if([string]::IsNullOrWhiteSpace([string]$Process.launcherExecutablePath)){continue}
        if(-not [string]::Equals([string]$native.MainWindowTitle,[string]$Process.launcherExecutablePath,[StringComparison]::OrdinalIgnoreCase)){continue}
        $terminalWindows += [pscustomobject]@{
            processId=[int]$candidate.ProcessId
            parentProcessId=[int]$candidate.ParentProcessId
            sessionId=[int]$candidate.SessionId
            name=[string]$candidate.Name
            creationDate=$candidate.CreationDate
            mainWindowHandle=[int64]$native.MainWindowHandle
            mainWindowTitle=[string]$native.MainWindowTitle
            matchStrategy='launcher_executable_title'
        }
    }
    $visibleConsoleHosts=@($consoleHosts|Where-Object{[int64]$_.mainWindowHandle -ne 0})
    [pscustomobject]@{
        hasConsoleHost=($consoleHosts.Count -gt 0)
        hasVisibleWindow=($visibleConsoleHosts.Count -gt 0 -or $terminalWindows.Count -gt 0)
        consoleHosts=@($consoleHosts)
        visibleConsoleHosts=@($visibleConsoleHosts)
        terminalWindows=@($terminalWindows)
    }
}

function Close-McpEdgeTerminalWindow {
    param([Parameter(Mandatory = $true)][object]$Console)
    $windows=@($Console.terminalWindows)
    if($windows.Count -eq 0){$windows=@($Console.visibleConsoleHosts)}
    if($windows.Count -eq 0){return [pscustomobject]@{attempted=$false;succeeded=$true;reason='no_visible_terminal_window'}}
    if($windows.Count -ne 1){return [pscustomobject]@{attempted=$false;succeeded=$false;reason='ambiguous_terminal_windows';candidateCount=$windows.Count}}
    $window=$windows[0]
    $process=Get-Process -Id ([int]$window.processId) -ErrorAction Stop
    $succeeded=$process.CloseMainWindow()
    [pscustomobject]@{attempted=$true;succeeded=[bool]$succeeded;reason=if($succeeded){$null}else{'close_main_window_returned_false'};processId=[int]$window.processId;mainWindowHandle=[int64]$window.mainWindowHandle}
}

function Get-McpTaskSnapshot {
    param([Parameter(Mandatory = $true)][string]$Name)
    $task=Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    $info=Get-ScheduledTaskInfo -TaskName $Name -ErrorAction Stop
    $action=@($task.Actions)[0]
    [pscustomobject]@{state=[string]$task.State;lastRunTime=$info.LastRunTime;lastTaskResult=[long]$info.LastTaskResult;execute=[string]$action.Execute;arguments=[string]$action.Arguments;workingDirectory=[string]$action.WorkingDirectory;logonType=[string]$task.Principal.LogonType;runLevel=[string]$task.Principal.RunLevel}
}

function Wait-McpTerminalProbeRecovery {
    param([Parameter(Mandatory = $true)][string]$Name,[Parameter(Mandatory = $true)][string]$Uri)
    $deadline=[DateTimeOffset]::UtcNow.AddSeconds(45)
    do {
        $task=Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        $health=Get-McpTerminalProbeHealth -Uri $Uri
        if($task -and [string]$task.State -eq 'Running' -and $health.connectorReady){return $true}
        if($task -and [string]$task.State -ne 'Running'){try{Start-ScheduledTask -TaskName $Name}catch{}}
        Start-Sleep -Seconds 2
    }while([DateTimeOffset]::UtcNow -lt $deadline)
    return $false
}

if(-not $Execute){throw 'Terminal-independence qualification is intentionally gated. Re-run with -Execute.'}
if([string]::IsNullOrWhiteSpace([string]$PSCommandPath)){throw 'Terminal-independence qualification must run as a script file.'}

if(-not $Probe){
    $scriptPath=[IO.Path]::GetFullPath([string]$PSCommandPath)
    $signature=Get-AuthenticodeSignature -LiteralPath $scriptPath
    if($signature.Status -ne 'Valid' -and -not($AllowUnsignedDevelopment -and $signature.Status -eq 'NotSigned')){throw "Terminal-independence qualification script signature is invalid. Status=$($signature.Status)"}
    if([string]::IsNullOrWhiteSpace($EvidencePath)){$EvidencePath=Join-Path (Join-Path $env:LOCALAPPDATA 'McpAccessStack\diagnostics\terminal-independence') ('edge-terminal-independence-'+[DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'.json')}
    $EvidencePath=[IO.Path]::GetFullPath($EvidencePath)
    if([string]::IsNullOrWhiteSpace($ProbeTaskName)){$ProbeTaskName='MCP Access Stack terminal-independence probe '+[guid]::NewGuid().ToString('N').Substring(0,12)}
    if(Get-ScheduledTask -TaskName $ProbeTaskName -ErrorAction SilentlyContinue){throw "Terminal-independence probe task already exists: $ProbeTaskName"}
    $pwsh=[IO.Path]::GetFullPath((Get-Command pwsh.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source)
    $executionPolicy=if($AllowUnsignedDevelopment){'Bypass'}else{'AllSigned'}
    $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy',$executionPolicy,'-File',(Quote-McpTerminalProbeArgument $scriptPath),'-TaskName',(Quote-McpTerminalProbeArgument $TaskName),'-HealthUri',(Quote-McpTerminalProbeArgument $HealthUri),'-EvidencePath',(Quote-McpTerminalProbeArgument $EvidencePath),'-ProbeTaskName',(Quote-McpTerminalProbeArgument $ProbeTaskName),'-ObservationSeconds',[string]$ObservationSeconds,'-Execute','-Probe')
    if($AllowUnsignedDevelopment){$arguments+='-AllowUnsignedDevelopment'}
    $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -Hidden
    $action=New-ScheduledTaskAction -Execute $pwsh -Argument ($arguments -join ' ') -WorkingDirectory (Split-Path -Parent $scriptPath)
    Register-ScheduledTask -TaskName $ProbeTaskName -InputObject (New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description 'Detached qualification of MCP Edge Connector terminal independence.')|Out-Null
    Start-ScheduledTask -TaskName $ProbeTaskName
    [pscustomobject]@{status='started';detached=$true;taskName=$TaskName;probeTaskName=$ProbeTaskName;evidencePath=$EvidencePath}|ConvertTo-Json -Compress
    return
}

if([string]::IsNullOrWhiteSpace($EvidencePath)-or[string]::IsNullOrWhiteSpace($ProbeTaskName)){throw 'Probe mode requires EvidencePath and ProbeTaskName.'}
$preTask=Get-McpTaskSnapshot -Name $TaskName
$preProcess=Get-McpEdgeProcessSnapshot
$preHealth=Get-McpTerminalProbeHealth -Uri $HealthUri
$preConsole=Get-McpEdgeConsoleSnapshot -Process $preProcess
$evidence=[ordered]@{schemaVersion=2;startedAt=[DateTimeOffset]::UtcNow.ToString('O');completedAt=$null;taskName=$TaskName;probeTaskName=$ProbeTaskName;healthUri=$HealthUri;observationSeconds=$ObservationSeconds;pre=[ordered]@{task=$preTask;process=$preProcess;health=$preHealth;console=$preConsole};close=$null;post=$null;terminalIndependent=$false;recovery=$null;failureReason=$null}
Write-McpTerminalProbeEvidence -Path $EvidencePath -Value $evidence

try{
    if($preConsole.hasVisibleWindow){$evidence.close=Close-McpEdgeTerminalWindow -Console $preConsole}else{$evidence.close=[pscustomobject]@{attempted=$false;succeeded=$true;reason='no_visible_terminal_window'}}
    Write-McpTerminalProbeEvidence -Path $EvidencePath -Value $evidence
    Start-Sleep -Seconds $ObservationSeconds
    $postTask=Get-McpTaskSnapshot -Name $TaskName
    $postHealth=Get-McpTerminalProbeHealth -Uri $HealthUri
    $launcherAlive=$null-ne(Get-Process -Id $preProcess.launcherPid -ErrorAction SilentlyContinue)
    $nodeAlive=$null-ne(Get-Process -Id $preProcess.nodePid -ErrorAction SilentlyContinue)
    $sameProcessTree=$launcherAlive -and $nodeAlive
    $taskRunning=[string]$postTask.state -eq 'Running'
    $healthReady=$postHealth.reachable -and $postHealth.connectorReady
    $noVisibleWindow=-not [bool]$preConsole.hasVisibleWindow
    $passed=$noVisibleWindow -and $sameProcessTree -and $taskRunning -and $healthReady
    $evidence.post=[ordered]@{task=$postTask;health=$postHealth;originalLauncherAlive=[bool]$launcherAlive;originalNodeAlive=[bool]$nodeAlive;sameProcessTree=[bool]$sameProcessTree}
    $evidence.terminalIndependent=[bool]$passed
    if(-not $passed){
        $reasons=[Collections.Generic.List[string]]::new()
        if(-not $noVisibleWindow){$reasons.Add('launcher_has_terminal_window')};if($preConsole.hasVisibleWindow -and -not $evidence.close.succeeded){$reasons.Add('terminal_close_failed')};if(-not $launcherAlive){$reasons.Add('launcher_pid_changed_or_exited')};if(-not $nodeAlive){$reasons.Add('node_pid_changed_or_exited')};if(-not $taskRunning){$reasons.Add('task_not_running')};if(-not $healthReady){$reasons.Add('connector_not_ready')}
        $evidence.failureReason=$reasons -join ','
        $recovered=Wait-McpTerminalProbeRecovery -Name $TaskName -Uri $HealthUri
        $evidence.recovery=[ordered]@{attempted=$true;connectorReady=[bool]$recovered;task=if($recovered){Get-McpTaskSnapshot -Name $TaskName}else{$null};health=Get-McpTerminalProbeHealth -Uri $HealthUri}
    }else{$evidence.recovery=[ordered]@{attempted=$false;connectorReady=$true}}
}catch{
    $evidence.failureReason='probe_exception:'+ $_.Exception.Message
    try{$recovered=Wait-McpTerminalProbeRecovery -Name $TaskName -Uri $HealthUri;$evidence.recovery=[ordered]@{attempted=$true;connectorReady=[bool]$recovered;health=Get-McpTerminalProbeHealth -Uri $HealthUri}}catch{$evidence.recovery=[ordered]@{attempted=$true;connectorReady=$false;error=$_.Exception.Message}}
}finally{
    $evidence.completedAt=[DateTimeOffset]::UtcNow.ToString('O')
    Write-McpTerminalProbeEvidence -Path $EvidencePath -Value $evidence
    try{Unregister-ScheduledTask -TaskName $ProbeTaskName -Confirm:$false -ErrorAction Stop}catch{}
}
if($evidence.terminalIndependent){exit 0};exit 1
