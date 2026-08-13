[CmdletBinding()]
param(
    [switch]$Execute,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$ExpectedReleaseId,

    [ValidateRange(30, 900)]
    [int]$TimeoutSeconds = 180,

    [switch]$RequireBrowserReady,

    [ValidateRange(0, 100)]
    [int]$ExpectedPreviousBrowserRegistrySchemaVersion = 0,

    [string]$LifecycleResultPath,

    [string]$TaskPrefix = 'MCP Access Stack Docker'
)

. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'ProductionLifecycle.Common.ps1')

if (-not $Execute) {
    throw 'Production promotion is intentionally gated. Re-run with -Execute.'
}

# PREFLIGHT_STEP: administrator
Assert-McpAdministrator -Operation 'Production promotion'

$root = Get-McpProjectRoot
$agentTaskName = "$TaskPrefix production agent"
$browserTaskName = "$TaskPrefix production browser-worker"
$nodeRuntimeUpdateTaskName = "$TaskPrefix production node-runtime-update"
$taskNames = @($agentTaskName, $browserTaskName, $nodeRuntimeUpdateTaskName)
$composeFile = Join-Path $root 'deploy\docker\compose.production.yml'
$composeEnv = Join-Path $root '.runtime-private\docker\production\compose.env'
$productionConfigPath = Join-Path $root '.runtime-private\gpt-only-production.json'
$activePointerPath = Get-McpReleasePointerPath -Name 'active' -Root $root
$candidatePointerPath = Get-McpReleasePointerPath -Name 'candidate' -Root $root
$timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
$backupDirectory = Join-Path $root "runtime\production-promotion\$timestamp"
$promotionReportPath = Join-Path $backupDirectory 'promotion-report.json'
$rollbackReportPath = Join-Path $backupDirectory 'rollback-report.json'
$gatewayLiveUri = 'http://127.0.0.1:3310/health/live'
$gatewayReadyUri = 'http://127.0.0.1:3310/health/ready'
$proxyLiveUri = 'http://127.0.0.1:3300/health/live'
$browserLiveUri = 'http://127.0.0.1:3350/health/live'
$browserReadyUri = 'http://127.0.0.1:3350/health/ready'
$lifecycleResultResolvedPath = $null
if (-not [string]::IsNullOrWhiteSpace($LifecycleResultPath)) {
    $runtimeRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'runtime\production-promotion'))
    $runtimePrefix = $runtimeRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $lifecycleResultResolvedPath = [System.IO.Path]::GetFullPath($LifecycleResultPath)
    if (-not $lifecycleResultResolvedPath.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Lifecycle result path must be inside runtime\production-promotion.'
    }
}

function Write-LifecycleResult {
    param([Parameter(Mandatory = $true)][object]$Value)

    if ($lifecycleResultResolvedPath) {
        Write-McpJsonFile -Path $lifecycleResultResolvedPath -Value $Value
    }
}

function Write-PromotionReport {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    Write-McpJsonFile -Path $Path -Value $Value
}

function Wait-Http200 {
    param([Parameter(Mandatory = $true)][string]$Uri)

    Wait-McpHttpEndpoint -Uri $Uri -TimeoutSeconds $TimeoutSeconds | Out-Null
}

function Test-Http200 {
    param([Parameter(Mandatory = $true)][string]$Uri)

    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 5
        return [int]$response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Initialize-ProductionBrowser {
    if (-not (Test-Path -LiteralPath $productionConfigPath -PathType Leaf)) {
        throw "Production configuration is missing: $productionConfigPath"
    }

    $productionConfig = Read-McpJsonFile -Path $productionConfigPath
    $browserToken = [string]$productionConfig.browser.token
    $browserPort = [int]$productionConfig.ports.browser
    if ($browserPort -lt 1 -or $browserPort -gt 65535) {
        throw 'Production Browser Worker port is invalid.'
    }

    Invoke-McpBrowserBootstrap `
        -Uri "http://127.0.0.1:$browserPort/operations" `
        -Token $browserToken `
        -TimeoutSeconds $TimeoutSeconds | Out-Null
}

function Get-ComponentProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('agent', 'browser-worker')]
        [string]$Component,

        [string]$ReleaseId
    )

    return @(
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $commandLine = [string]$_.CommandLine
                $matchesComponent = $commandLine.Contains('Run-DockerHostComponent.mjs') -and
                    $commandLine.Contains("--component $Component") -and
                    $commandLine.Contains('--environment production')
                $matchesRelease = -not $ReleaseId -or $commandLine.Contains("releases\$ReleaseId")
                $matchesComponent -and $matchesRelease
            }
    )
}

function Wait-ComponentRelease {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('agent', 'browser-worker')]
        [string]$Component,

        [Parameter(Mandatory = $true)]
        [string]$ReleaseId
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $processes = @(Get-ComponentProcesses -Component $Component -ReleaseId $ReleaseId)
        if ($processes.Count -eq 1) {
            return $processes[0]
        }
        Start-Sleep -Seconds 2
    }

    $allProcesses = @(Get-ComponentProcesses -Component $Component)
    throw "Component did not converge to exactly one process on release ${ReleaseId}: $Component; count=$($allProcesses.Count)"
}

function Wait-NoReleaseProcesses {
    param([Parameter(Mandatory = $true)][string]$ReleaseId)

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $processes = @(
            Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { ([string]$_.CommandLine).Contains("releases\$ReleaseId") }
        )
        if ($processes.Count -eq 0) {
            return
        }
        Start-Sleep -Seconds 2
    }

    $remaining = @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { ([string]$_.CommandLine).Contains("releases\$ReleaseId") }
    )
    foreach ($process in $remaining) {
        $global:LASTEXITCODE = 0
        & taskkill.exe /PID ([string]$process.ProcessId) /T /F *> $null
    }

    Start-Sleep -Seconds 2
    $remainingAfterKill = @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { ([string]$_.CommandLine).Contains("releases\$ReleaseId") }
    )
    if ($remainingAfterKill.Count -gt 0) {
        throw "Unable to terminate release processes: $ReleaseId"
    }
}

function Wait-TaskNotRunning {
    param([Parameter(Mandatory = $true)][string]$TaskName)

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not $task -or [string]$task.State -ne 'Running') {
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "Scheduled task remained running: $TaskName"
}

function Stop-TaskIfRunning {
    param([Parameter(Mandatory = $true)][string]$TaskName)

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and [string]$task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Wait-TaskNotRunning -TaskName $TaskName
    }
}

function Set-ProductionImageTag {
    param([Parameter(Mandatory = $true)][string]$ReleaseId)

    $lines = @(Get-Content -LiteralPath $composeEnv)
    $found = $false
    $updated = foreach ($line in $lines) {
        if ($line -match '^MCP_IMAGE_TAG=') {
            $found = $true
            "MCP_IMAGE_TAG=$ReleaseId"
        }
        else {
            $line
        }
    }
    if (-not $found) {
        $updated = @("MCP_IMAGE_TAG=$ReleaseId") + $updated
    }

    Write-McpUtf8NoBom -Path $composeEnv -Content (
        ($updated -join [Environment]::NewLine) + [Environment]::NewLine
    )
}

function Invoke-ProductionComposeUp {
    Invoke-McpNativeCommand -FilePath 'docker' -WorkingDirectory $root -Arguments @(
        'compose',
        '--env-file', $composeEnv,
        '-f', $composeFile,
        'up',
        '-d',
        '--no-build',
        'gateway',
        'proxy'
    )
}

function Install-ProductionHostTasks {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot)

    $installerPath = Join-Path $root 'deploy\docker\scripts\Install-McpHostTasks.ps1'
    Invoke-McpNativeCommand -FilePath 'pwsh' -WorkingDirectory $root -Arguments @(
        '-NoLogo',
        '-NoProfile',
        '-File', $installerPath,
        '-Environment', 'production',
        '-ReleaseRoot', $ReleaseRoot,
        '-Force',
        '-Activate'
    )
}

function Activate-CandidatePointer {
    $activationPath = Join-Path $root 'deploy\docker\scripts\Activate-McpCandidateRelease.ps1'
    Invoke-McpNativeCommand -FilePath 'pwsh' -WorkingDirectory $root -Arguments @(
        '-NoLogo',
        '-NoProfile',
        '-File', $activationPath,
        '-Execute',
        '-ExpectedReleaseId', $ExpectedReleaseId
    )
}

function Restore-TaskDefinition {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$XmlPath,
        [Parameter(Mandatory = $true)][bool]$WasEnabled
    )

    Stop-TaskIfRunning -TaskName $TaskName
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    $xml = Get-Content -LiteralPath $XmlPath -Raw
    Register-ScheduledTask -TaskName $TaskName -Xml $xml | Out-Null
    if ($WasEnabled) {
        Enable-ScheduledTask -TaskName $TaskName | Out-Null
    }
    else {
        Disable-ScheduledTask -TaskName $TaskName | Out-Null
    }
}

function Get-ContainerInspection {
    param([Parameter(Mandatory = $true)][string]$ContainerName)

    $jsonLines = @(
        Invoke-McpNativeCommandCapture -FilePath 'docker' -WorkingDirectory $root -Arguments @(
            'inspect', $ContainerName
        )
    )
    $json = $jsonLines -join [Environment]::NewLine
    return @($json | ConvertFrom-Json)[0]
}

function Assert-TaskRelease {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$ReleaseId
    )

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $actualReleaseId = Get-McpScheduledTaskReleaseId -Task $task
    if ($actualReleaseId -ne $ReleaseId) {
        throw "Scheduled task release mismatch for ${TaskName}: expected=$ReleaseId actual=$actualReleaseId"
    }
}

$candidate = Read-McpReleasePointer -Name 'candidate' -Root $root
$candidateEligible = Assert-McpReleasePointerEligible -Pointer $candidate -Root $root
if ([string]$candidateEligible.releaseId -ne $ExpectedReleaseId) {
    throw "Candidate mismatch. Expected $ExpectedReleaseId, got $($candidateEligible.releaseId)."
}

$previousActive = Read-McpReleasePointer -Name 'active' -Root $root
$previousEligible = Assert-McpReleasePointerEligible -Pointer $previousActive -Root $root
$previousReleaseId = [string]$previousEligible.releaseId
if ($previousReleaseId -eq $ExpectedReleaseId) {
    throw "Release is already active: $ExpectedReleaseId"
}
$candidateReleaseRoot = [string]$candidateEligible.path

foreach ($requiredPath in @($composeFile, $composeEnv, $productionConfigPath, $activePointerPath, $candidatePointerPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required production file is missing: $requiredPath"
    }
}

Wait-Http200 -Uri $gatewayLiveUri
Wait-Http200 -Uri $gatewayReadyUri
Wait-Http200 -Uri $proxyLiveUri
Wait-Http200 -Uri $browserLiveUri
if ($RequireBrowserReady) {
    Wait-Http200 -Uri $browserReadyUri
}

New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
Copy-Item -LiteralPath $activePointerPath -Destination (Join-Path $backupDirectory 'active.before.json')
Copy-Item -LiteralPath $candidatePointerPath -Destination (Join-Path $backupDirectory 'candidate.before.json')
Copy-Item -LiteralPath $composeEnv -Destination (Join-Path $backupDirectory 'compose.before.env')

$taskBackup = @{}
foreach ($taskName in $taskNames) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) {
        $taskBackup[$taskName] = [pscustomobject]@{
            existed = $false
            xmlPath = $null
            wasRunning = $false
            wasEnabled = $false
        }
        continue
    }
    $xmlPath = Join-Path $backupDirectory (($taskName -replace '[^A-Za-z0-9._-]', '_') + '.xml')
    Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath $xmlPath -Encoding Unicode
    $taskBackup[$taskName] = [pscustomobject]@{
        existed = $true
        xmlPath = $xmlPath
        wasRunning = ([string]$task.State -eq 'Running')
        wasEnabled = ([string]$task.State -ne 'Disabled')
    }
}

$startedAt = [DateTimeOffset]::UtcNow.ToString('O')
$promotionSucceeded = $false
$rollbackSucceeded = $false
$browserRegistrySnapshot = $null
$browserRegistryRestore = $null

try {
    # PROMOTION_STEP: compose-candidate
    Set-ProductionImageTag -ReleaseId $ExpectedReleaseId
    Invoke-ProductionComposeUp

    # PROMOTION_STEP: gateway-live
    Wait-Http200 -Uri $gatewayLiveUri

    # PROMOTION_STEP: stop-previous-hosts
    Stop-TaskIfRunning -TaskName $browserTaskName
    Stop-TaskIfRunning -TaskName $agentTaskName
    Wait-NoReleaseProcesses -ReleaseId $previousReleaseId

    # PROMOTION_STEP: snapshot-browser-registry
    $browserRegistrySnapshotParameters = @{
        ProductionConfigPath = $productionConfigPath
        ProjectRoot = $root
        BackupDirectory = $backupDirectory
    }
    if ($ExpectedPreviousBrowserRegistrySchemaVersion -gt 0) {
        $browserRegistrySnapshotParameters.ExpectedRegistrySchemaVersion =
            $ExpectedPreviousBrowserRegistrySchemaVersion
    }
    $browserRegistrySnapshot = New-McpBrowserRegistrySnapshot `
        @browserRegistrySnapshotParameters

    # PROMOTION_STEP: install-candidate-hosts
    Install-ProductionHostTasks -ReleaseRoot $candidateReleaseRoot

    # PROMOTION_STEP: start-candidate-agent
    Start-ScheduledTask -TaskName $agentTaskName
    $agentProcess = Wait-ComponentRelease -Component 'agent' -ReleaseId $ExpectedReleaseId

    # PROMOTION_STEP: gateway-ready
    Wait-Http200 -Uri $gatewayReadyUri
    Wait-Http200 -Uri $proxyLiveUri

    # PROMOTION_STEP: start-candidate-browser
    Start-ScheduledTask -TaskName $browserTaskName
    $browserProcess = Wait-ComponentRelease -Component 'browser-worker' -ReleaseId $ExpectedReleaseId

    # PROMOTION_STEP: browser-live
    Wait-Http200 -Uri $browserLiveUri

    # PROMOTION_STEP: browser-bootstrap
    Initialize-ProductionBrowser
    if ($RequireBrowserReady) {
        Wait-Http200 -Uri $browserReadyUri
    }

    Assert-TaskRelease -TaskName $agentTaskName -ReleaseId $ExpectedReleaseId
    Assert-TaskRelease -TaskName $browserTaskName -ReleaseId $ExpectedReleaseId

    $gatewayContainer = Get-ContainerInspection -ContainerName 'mcp-access-stack-production-gateway-1'
    $proxyContainer = Get-ContainerInspection -ContainerName 'mcp-access-stack-production-proxy-1'
    if ([string]$gatewayContainer.Config.Image -ne "mcp-access-stack/gateway:$ExpectedReleaseId") {
        throw "Gateway image mismatch: $($gatewayContainer.Config.Image)"
    }
    if ([string]$proxyContainer.Config.Image -ne "mcp-access-stack/proxy:$ExpectedReleaseId") {
        throw "Proxy image mismatch: $($proxyContainer.Config.Image)"
    }
    if (
        [string]$gatewayContainer.State.Health.Status -ne 'healthy' -or
        [string]$proxyContainer.State.Health.Status -ne 'healthy'
    ) {
        throw 'Production containers are not healthy after promotion.'
    }

    $powershellWrappers = @(
        Get-McpPowerShellAncestorProcesses -ProcessIds @(
            [int]$agentProcess.ProcessId,
            [int]$browserProcess.ProcessId
        )
    )
    if ($powershellWrappers.Count -ne 0) {
        throw "Unexpected PowerShell wrappers detected: $($powershellWrappers.Count)"
    }

    # PROMOTION_STEP: activate-pointer
    Activate-CandidatePointer
    $activeAfter = Read-McpReleasePointer -Name 'active' -Root $root
    if ([string]$activeAfter.releaseId -ne $ExpectedReleaseId) {
        throw 'Active release pointer did not converge to the candidate.'
    }

    $promotionSucceeded = $true
    Write-PromotionReport -Path $promotionReportPath -Value ([ordered]@{
        status = 'passed'
        startedAt = $startedAt
        completedAt = [DateTimeOffset]::UtcNow.ToString('O')
        previousReleaseId = $previousReleaseId
        activeReleaseId = $ExpectedReleaseId
        candidateReleaseId = [string]$candidateEligible.releaseId
        backupDirectory = $backupDirectory
        agentPid = [int]$agentProcess.ProcessId
        browserPid = [int]$browserProcess.ProcessId
        browserReady = (Test-Http200 -Uri $browserReadyUri)
        browserReadyRequired = [bool]$RequireBrowserReady
        gatewayImage = [string]$gatewayContainer.Config.Image
        proxyImage = [string]$proxyContainer.Config.Image
        gatewayHealth = [string]$gatewayContainer.State.Health.Status
        proxyHealth = [string]$proxyContainer.State.Health.Status
        containerRestarts = [int]$gatewayContainer.RestartCount + [int]$proxyContainer.RestartCount
        powershellWrappers = $powershellWrappers.Count
        browserRegistrySnapshotSchemaVersion = $browserRegistrySnapshot.registrySchemaVersion
        browserRegistrySnapshotManifestSha256 = [string]$browserRegistrySnapshot.manifestSha256
        browserRegistrySnapshotFileCount = [int]$browserRegistrySnapshot.fileCount
        browserRegistryRollbackJournalPath = [string]$browserRegistrySnapshot.rollbackJournalPath
        rollbackAvailable = $true
    })

    Write-LifecycleResult -Value ([ordered]@{
        releaseId = $ExpectedReleaseId
        status = 'passed'
        startedAt = $startedAt
        completedAt = [DateTimeOffset]::UtcNow.ToString('O')
        exitCode = 0
        reportPath = $promotionReportPath
    })

    Get-Content -LiteralPath $promotionReportPath -Raw
}
catch {
    $promotionError = $_.Exception.Message
    try {
        # ROLLBACK_STEP: stop-candidate-hosts
        Stop-TaskIfRunning -TaskName $browserTaskName
        Stop-TaskIfRunning -TaskName $agentTaskName
        Wait-NoReleaseProcesses -ReleaseId $ExpectedReleaseId

        # ROLLBACK_STEP: restore-browser-registry
        if ($browserRegistrySnapshot) {
            $browserRegistryRestore = Restore-McpBrowserRegistrySnapshot `
                -Snapshot $browserRegistrySnapshot
        }

        # ROLLBACK_STEP: restore-files-and-tasks
        Copy-Item -LiteralPath (Join-Path $backupDirectory 'compose.before.env') -Destination $composeEnv -Force
        Copy-Item -LiteralPath (Join-Path $backupDirectory 'active.before.json') -Destination $activePointerPath -Force
        Copy-Item -LiteralPath (Join-Path $backupDirectory 'candidate.before.json') -Destination $candidatePointerPath -Force
        foreach ($taskName in $taskNames) {
            $backup = $taskBackup[$taskName]
            if ([bool]$backup.existed) {
                Restore-TaskDefinition `
                    -TaskName $taskName `
                    -XmlPath $backup.xmlPath `
                    -WasEnabled ([bool]$backup.wasEnabled)
            }
            else {
                Stop-TaskIfRunning -TaskName $taskName
                $candidateTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
                if ($candidateTask) {
                    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
                }
            }
        }

        # ROLLBACK_STEP: compose-previous
        Invoke-ProductionComposeUp
        Wait-Http200 -Uri $gatewayLiveUri

        # ROLLBACK_STEP: start-previous-agent
        if ([bool]$taskBackup[$agentTaskName].wasRunning) {
            Start-ScheduledTask -TaskName $agentTaskName
            Wait-ComponentRelease -Component 'agent' -ReleaseId $previousReleaseId | Out-Null
            Wait-Http200 -Uri $gatewayReadyUri
        }
        Wait-Http200 -Uri $proxyLiveUri

        # ROLLBACK_STEP: start-previous-browser
        if ([bool]$taskBackup[$browserTaskName].wasRunning) {
            Start-ScheduledTask -TaskName $browserTaskName
            Wait-ComponentRelease -Component 'browser-worker' -ReleaseId $previousReleaseId | Out-Null
            Wait-Http200 -Uri $browserLiveUri

            # ROLLBACK_STEP: browser-bootstrap
            Initialize-ProductionBrowser
            if ($RequireBrowserReady) {
                Wait-Http200 -Uri $browserReadyUri
            }
        }

        Assert-TaskRelease -TaskName $agentTaskName -ReleaseId $previousReleaseId
        Assert-TaskRelease -TaskName $browserTaskName -ReleaseId $previousReleaseId
        $rollbackSucceeded = $true
    }
    catch {
        $rollbackError = $_.Exception.Message
        Write-PromotionReport -Path $rollbackReportPath -Value ([ordered]@{
            status = 'failed'
            promotionError = $promotionError
            rollbackError = $rollbackError
            completedAt = [DateTimeOffset]::UtcNow.ToString('O')
            backupDirectory = $backupDirectory
        })
        Write-LifecycleResult -Value ([ordered]@{
            releaseId = $ExpectedReleaseId
            status = 'rollback-failed'
            startedAt = $startedAt
            completedAt = [DateTimeOffset]::UtcNow.ToString('O')
            exitCode = 1
            promotionError = $promotionError
            rollbackError = $rollbackError
            rollbackReportPath = $rollbackReportPath
        })
        throw "Production promotion failed and rollback also failed. Promotion: $promotionError. Rollback: $rollbackError."
    }

    Write-PromotionReport -Path $rollbackReportPath -Value ([ordered]@{
        status = 'passed'
        promotionError = $promotionError
        restoredReleaseId = $previousReleaseId
        browserReady = (Test-Http200 -Uri $browserReadyUri)
        completedAt = [DateTimeOffset]::UtcNow.ToString('O')
        backupDirectory = $backupDirectory
        browserRegistryRestoredManifestSha256 = if ($browserRegistryRestore) {
            [string]$browserRegistryRestore.restoredManifestSha256
        }
        else { $null }
        browserRegistryQuarantineDirectory = if ($browserRegistryRestore) {
            [string]$browserRegistryRestore.quarantineDirectory
        }
        else { $null }
        browserRegistryRollbackJournalPath = if ($browserRegistryRestore) {
            [string]$browserRegistryRestore.journalPath
        }
        else { $null }
    })
    Write-LifecycleResult -Value ([ordered]@{
        releaseId = $ExpectedReleaseId
        status = 'rolled-back'
        startedAt = $startedAt
        completedAt = [DateTimeOffset]::UtcNow.ToString('O')
        exitCode = 1
        promotionError = $promotionError
        restoredReleaseId = $previousReleaseId
        rollbackReportPath = $rollbackReportPath
    })
    throw "Production promotion failed and was rolled back successfully: $promotionError"
}
finally {
    if (-not $promotionSucceeded -and -not $rollbackSucceeded) {
        Write-Warning "Promotion did not complete. Inspect: $backupDirectory"
    }
}
