[CmdletBinding()]
param(
    [ValidateSet('Quick', 'Candidate', 'Stability')]
    [string]$Gate = 'Quick',
    [Nullable[int]]$MinimumDurationMinutes,
    [Nullable[int]]$MinimumActions,
    [Nullable[int]]$TimeoutMinutes,
    [Nullable[int]]$IntervalSeconds,
    [switch]$InjectFailures,
    [Nullable[int]]$RestartEveryIterations,
    [Nullable[int]]$MaxRestartAttempts,
    [switch]$DescribeGate
)

. (Join-Path $PSScriptRoot 'Common.ps1')

$profiles = @{
    Quick = [ordered]@{
        minimumDurationMinutes = 2
        minimumActions = 35
        timeoutMinutes = 6
        intervalSeconds = 5
        injectFailures = $false
        restartEveryIterations = 10
        maxRestartAttempts = 0
        qualifiesFor = 'change-validation'
    }
    Candidate = [ordered]@{
        minimumDurationMinutes = 5
        minimumActions = 100
        timeoutMinutes = 12
        intervalSeconds = 5
        injectFailures = $true
        restartEveryIterations = 5
        maxRestartAttempts = 2
        qualifiesFor = 'candidate-repetition'
    }
    Stability = [ordered]@{
        minimumDurationMinutes = 20
        minimumActions = 250
        timeoutMinutes = 30
        intervalSeconds = 5
        injectFailures = $true
        restartEveryIterations = 10
        maxRestartAttempts = 4
        qualifiesFor = 'stability-repetition'
    }
}

$selected = $profiles[$Gate]
$resolved = [ordered]@{
    gate = $Gate.ToLowerInvariant()
    minimumDurationMinutes = if ($null -ne $MinimumDurationMinutes) {
        [int]$MinimumDurationMinutes
    } else {
        [int]$selected.minimumDurationMinutes
    }
    minimumActions = if ($null -ne $MinimumActions) {
        [int]$MinimumActions
    } else {
        [int]$selected.minimumActions
    }
    timeoutMinutes = if ($null -ne $TimeoutMinutes) {
        [int]$TimeoutMinutes
    } else {
        [int]$selected.timeoutMinutes
    }
    intervalSeconds = if ($null -ne $IntervalSeconds) {
        [int]$IntervalSeconds
    } else {
        [int]$selected.intervalSeconds
    }
    injectFailures = [bool]($selected.injectFailures -or $InjectFailures.IsPresent)
    restartEveryIterations = if ($null -ne $RestartEveryIterations) {
        [int]$RestartEveryIterations
    } else {
        [int]$selected.restartEveryIterations
    }
    maxRestartAttempts = if ($null -ne $MaxRestartAttempts) {
        [int]$MaxRestartAttempts
    } else {
        [int]$selected.maxRestartAttempts
    }
    requiredSuccessRate = 1.0
    qualifiesFor = [string]$selected.qualifiesFor
}

if ($resolved.minimumDurationMinutes -lt 0) {
    throw 'MinimumDurationMinutes cannot be negative.'
}
if ($resolved.minimumActions -lt 1) {
    throw 'MinimumActions must be at least 1.'
}
if ($resolved.timeoutMinutes -lt 1) {
    throw 'TimeoutMinutes must be at least 1.'
}
if (
    $resolved.minimumDurationMinutes -gt 0 -and
    $resolved.timeoutMinutes -le $resolved.minimumDurationMinutes
) {
    throw 'TimeoutMinutes must be greater than MinimumDurationMinutes.'
}
if ($resolved.intervalSeconds -lt 5) {
    throw 'IntervalSeconds must be at least 5.'
}
if ($resolved.restartEveryIterations -lt 1) {
    throw 'RestartEveryIterations must be at least 1.'
}
if ($resolved.maxRestartAttempts -lt 0) {
    throw 'MaxRestartAttempts cannot be negative.'
}
if ($resolved.injectFailures -and $resolved.maxRestartAttempts -lt 1) {
    throw 'MaxRestartAttempts must be at least 1 when failure injection is enabled.'
}

if ($DescribeGate) {
    $resolved | ConvertTo-Json -Depth 4
    return
}

function Write-SoakRecord {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [object]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 16 -Compress
    [System.IO.File]::AppendAllText(
        $Path,
        $json + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Get-SoakPercentile {
    param(
        [Parameter(Mandatory)]
        [System.Collections.Generic.List[double]]$Values,
        [Parameter(Mandatory)]
        [double]$Ratio
    )

    if ($Values.Count -eq 0) {
        return 0
    }
    $sorted = @($Values | Sort-Object)
    $index = [Math]::Min(
        $sorted.Count - 1,
        [Math]::Max(0, [Math]::Ceiling($sorted.Count * $Ratio) - 1)
    )
    return [Math]::Round([double]$sorted[$index], 3)
}

$root = Get-McpProjectRoot
$composeArguments = Get-McpComposeArguments -Environment 'development'
$runtimeDirectory = Join-Path $root 'runtime\docker-development'
$startedAt = [DateTimeOffset]::UtcNow
$reportPath = Join-Path $runtimeDirectory (
    'soak-{0}-{1}.ndjson' -f $resolved.gate, $startedAt.ToString('yyyyMMdd-HHmmss')
)
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null

Push-Location $root
try {
    $sourceCommit = (& git rev-parse --verify 'HEAD^{commit}').Trim()
    if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[a-f0-9]{40}$') {
        throw 'Unable to resolve the source commit for soak evidence.'
    }
    $sourceDirty = @(& git status --porcelain -- .).Count -gt 0
}
finally {
    Pop-Location
}

if ($Gate -ne 'Quick' -and $sourceDirty) {
    throw "$Gate gate requires a clean committed source tree so its evidence identifies an immutable candidate."
}

$deadline = $startedAt.AddMinutes($resolved.timeoutMinutes)
$iteration = 0
$iterationFailures = 0
$totalActions = 0
$passedActions = 0
$failedActions = 0
$restartAttempts = 0
$successfulRestarts = 0
$recoveryFailures = 0
$actionDurations = [System.Collections.Generic.List[double]]::new()

Write-SoakRecord -Path $reportPath -Value ([ordered]@{
    schemaVersion = 2
    recordType = 'start'
    timestamp = $startedAt.ToString('O')
    profile = $resolved
    source = [ordered]@{
        commit = $sourceCommit
        dirty = $sourceDirty
    }
})

while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $elapsedBeforeIteration = [DateTimeOffset]::UtcNow - $startedAt
    $durationSatisfied = $elapsedBeforeIteration.TotalMinutes -ge $resolved.minimumDurationMinutes
    $actionsSatisfied = $totalActions -ge $resolved.minimumActions
    $recoverySatisfied = -not $resolved.injectFailures -or $restartAttempts -ge $resolved.maxRestartAttempts
    if ($durationSatisfied -and $actionsSatisfied -and $recoverySatisfied) {
        break
    }

    $iteration += 1
    $iterationStartedAt = [DateTimeOffset]::UtcNow
    $iterationStatus = 'passed'
    $iterationReason = $null
    $reportedActionCount = 0
    $reportedFailedActionCount = 0
    $restartAttemptedThisIteration = $false
    $composeState = $null
    $resourceStats = $null

    try {
        Push-Location $root
        try {
            $smokeOutput = @(& node 'deploy/docker/scripts/smoke-development.mjs')
            $smokeExitCode = $LASTEXITCODE
            $reportLine = @($smokeOutput | Where-Object {
                -not [string]::IsNullOrWhiteSpace([string]$_)
            } | Select-Object -Last 1)
            if ($reportLine.Count -ne 1) {
                throw 'Development environment smoke returned no structured action report.'
            }
            try {
                $smokeReport = $reportLine[0] | ConvertFrom-Json -Depth 32
            }
            catch {
                throw "Development environment smoke returned invalid JSON: $($_.Exception.Message)"
            }
            if ([int]$smokeReport.schemaVersion -ne 2) {
                throw "Unsupported development environment smoke report version: $($smokeReport.schemaVersion)"
            }

            foreach ($action in @($smokeReport.actions)) {
                $reportedActionCount += 1
                $totalActions += 1
                $durationMs = [Math]::Max(0, [double]$action.durationMs)
                $actionDurations.Add($durationMs)
                if ([string]$action.status -eq 'passed') {
                    $passedActions += 1
                }
                else {
                    $failedActions += 1
                    $reportedFailedActionCount += 1
                }
                Write-SoakRecord -Path $reportPath -Value ([ordered]@{
                    schemaVersion = 2
                    recordType = 'action'
                    timestamp = [DateTimeOffset]::UtcNow.ToString('O')
                    gate = $resolved.gate
                    iteration = $iteration
                    actionIndex = [int]$action.index
                    name = [string]$action.name
                    status = [string]$action.status
                    durationMs = $durationMs
                    reason = if ($null -eq $action.reason) { $null } else { [string]$action.reason }
                })
            }

            if ($reportedActionCount -eq 0) {
                throw 'Development environment smoke reported zero MCP actions.'
            }
            if ($smokeExitCode -ne 0 -or [string]$smokeReport.status -ne 'passed') {
                if ($reportedFailedActionCount -eq 0) {
                    $totalActions += 1
                    $failedActions += 1
                    $reportedActionCount += 1
                    $reportedFailedActionCount += 1
                    Write-SoakRecord -Path $reportPath -Value ([ordered]@{
                        schemaVersion = 2
                        recordType = 'action'
                        timestamp = [DateTimeOffset]::UtcNow.ToString('O')
                        gate = $resolved.gate
                        iteration = $iteration
                        actionIndex = $reportedActionCount
                        name = 'smoke/lifecycle'
                        status = 'failed'
                        durationMs = 0
                        reason = [string]$smokeReport.error
                    })
                }
                throw "Development environment smoke failed: $($smokeReport.error)"
            }

            if (
                $resolved.injectFailures -and
                $restartAttempts -lt $resolved.maxRestartAttempts -and
                ($iteration % $resolved.restartEveryIterations -eq 0)
            ) {
                $restartAttemptedThisIteration = $true
                $restartAttempts += 1
                $service = if (($restartAttempts % 2) -eq 0) { 'proxy' } else { 'gateway' }
                & docker compose @composeArguments restart $service | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    throw "Unable to restart $service."
                }
                $successfulRestarts += 1
            }

            $composeState = & docker compose @composeArguments ps --format json
            if ($LASTEXITCODE -ne 0) {
                throw 'Unable to read Compose state.'
            }
            $resourceStats = & docker stats --no-stream --format '{{json .}}'
            if ($LASTEXITCODE -ne 0) {
                throw 'Unable to read container resource statistics.'
            }
        }
        finally {
            Pop-Location
        }

        Wait-McpHttpEndpoint -Uri 'http://127.0.0.1:4310/health/ready' -TimeoutSeconds 120 | Out-Null
        Wait-McpHttpEndpoint -Uri 'http://127.0.0.1:4300/health/live' -TimeoutSeconds 120 | Out-Null
    }
    catch {
        $iterationFailures += 1
        $iterationStatus = 'failed'
        $iterationReason = $_.Exception.Message
        if ($restartAttemptedThisIteration) {
            $recoveryFailures += 1
        }
        if ($reportedFailedActionCount -eq 0) {
            $syntheticDurationMs = [int]((
                [DateTimeOffset]::UtcNow - $iterationStartedAt
            ).TotalMilliseconds)
            $totalActions += 1
            $failedActions += 1
            $reportedActionCount += 1
            $reportedFailedActionCount += 1
            $actionDurations.Add([double]$syntheticDurationMs)
            Write-SoakRecord -Path $reportPath -Value ([ordered]@{
                schemaVersion = 2
                recordType = 'action'
                timestamp = [DateTimeOffset]::UtcNow.ToString('O')
                gate = $resolved.gate
                iteration = $iteration
                actionIndex = $reportedActionCount
                name = if ($restartAttemptedThisIteration) {
                    'recovery/infrastructure'
                } else {
                    'smoke/infrastructure'
                }
                status = 'failed'
                durationMs = $syntheticDurationMs
                reason = $iterationReason
            })
        }
    }

    Write-SoakRecord -Path $reportPath -Value ([ordered]@{
        schemaVersion = 2
        recordType = 'iteration'
        timestamp = $iterationStartedAt.ToString('O')
        gate = $resolved.gate
        iteration = $iteration
        status = $iterationStatus
        durationMs = [int]([DateTimeOffset]::UtcNow - $iterationStartedAt).TotalMilliseconds
        reason = $iterationReason
        actions = $reportedActionCount
        totalActions = $totalActions
        restartAttempted = $restartAttemptedThisIteration
        compose = $composeState
        resources = $resourceStats
    })

    $elapsedAfterIteration = [DateTimeOffset]::UtcNow - $startedAt
    $requirementsSatisfied = (
        $elapsedAfterIteration.TotalMinutes -ge $resolved.minimumDurationMinutes -and
        $totalActions -ge $resolved.minimumActions -and
        (-not $resolved.injectFailures -or $restartAttempts -ge $resolved.maxRestartAttempts)
    )
    if (-not $requirementsSatisfied -and [DateTimeOffset]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds $resolved.intervalSeconds
    }
}

$completedAt = [DateTimeOffset]::UtcNow
$elapsed = $completedAt - $startedAt
$successRate = if ($totalActions -eq 0) {
    0
}
else {
    $passedActions / $totalActions
}
$checks = [ordered]@{
    minimumDuration = $elapsed.TotalMinutes -ge $resolved.minimumDurationMinutes
    minimumActions = $totalActions -ge $resolved.minimumActions
    successRate = $successRate -ge $resolved.requiredSuccessRate
    recoveryExercise = -not $resolved.injectFailures -or $restartAttempts -eq $resolved.maxRestartAttempts
    recovery = (
        $recoveryFailures -eq 0 -and
        $successfulRestarts -eq $restartAttempts
    )
    immutableSource = $Gate -eq 'Quick' -or -not $sourceDirty
}
$passed = -not @($checks.Values | Where-Object { $_ -ne $true }).Count
$summary = [ordered]@{
    schemaVersion = 2
    recordType = 'summary'
    gate = $resolved.gate
    passed = $passed
    qualifiesFor = if ($passed) { $resolved.qualifiesFor } else { 'none' }
    startedAt = $startedAt.ToString('O')
    completedAt = $completedAt.ToString('O')
    elapsedMinutes = [Math]::Round($elapsed.TotalMinutes, 3)
    source = [ordered]@{
        commit = $sourceCommit
        dirty = $sourceDirty
    }
    requirements = $resolved
    observed = [ordered]@{
        iterations = $iteration
        iterationFailures = $iterationFailures
        actions = $totalActions
        passedActions = $passedActions
        failedActions = $failedActions
        successRate = [Math]::Round($successRate, 6)
        restartAttempts = $restartAttempts
        successfulRestarts = $successfulRestarts
        recoveryFailures = $recoveryFailures
        actionTimingMs = [ordered]@{
            p50 = Get-SoakPercentile -Values $actionDurations -Ratio 0.50
            p95 = Get-SoakPercentile -Values $actionDurations -Ratio 0.95
            p99 = Get-SoakPercentile -Values $actionDurations -Ratio 0.99
        }
    }
    checks = $checks
    report = $reportPath
}
Write-SoakRecord -Path $reportPath -Value $summary

if (-not $passed) {
    throw "Development environment $($resolved.gate) gate failed: actions=$totalActions successRate=$successRate elapsedMinutes=$($elapsed.TotalMinutes) report=$reportPath"
}
Write-Output (
    'Development environment {0} gate passed: actions={1} successRate={2} elapsedMinutes={3} qualifiesFor={4} report={5}' -f
    $resolved.gate,
    $totalActions,
    [Math]::Round($successRate, 6),
    [Math]::Round($elapsed.TotalMinutes, 3),
    $resolved.qualifiesFor,
    $reportPath
)
