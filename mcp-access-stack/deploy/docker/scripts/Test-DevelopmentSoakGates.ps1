[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$soakPath = Join-Path $PSScriptRoot 'Invoke-DockerDevelopmentSoak.ps1'
$qualificationPath = Join-Path $PSScriptRoot 'Invoke-DockerDevelopmentQualification.ps1'

function Read-SoakGate {
    param(
        [Parameter(Mandatory)]
        [string]$Name,
        [hashtable]$Overrides = @{}
    )

    $arguments = @{
        Gate = $Name
        DescribeGate = $true
    }
    foreach ($entry in $Overrides.GetEnumerator()) {
        $arguments[$entry.Key] = $entry.Value
    }
    $json = (& $soakPath @arguments) -join [Environment]::NewLine
    return $json | ConvertFrom-Json
}

$quick = Read-SoakGate -Name 'Quick'
if (
    [int]$quick.minimumDurationMinutes -ne 2 -or
    [int]$quick.minimumActions -ne 35 -or
    [int]$quick.timeoutMinutes -ne 6 -or
    [double]$quick.requiredSuccessRate -ne 1 -or
    [bool]$quick.injectFailures -or
    [int]$quick.maxRestartAttempts -ne 0 -or
    [string]$quick.qualifiesFor -ne 'change-validation'
) {
    throw 'Quick soak gate no longer matches the bounded change-validation contract.'
}

$candidate = Read-SoakGate -Name 'Candidate'
if (
    [int]$candidate.minimumDurationMinutes -ne 5 -or
    [int]$candidate.minimumActions -ne 100 -or
    [int]$candidate.timeoutMinutes -ne 12 -or
    [double]$candidate.requiredSuccessRate -ne 1 -or
    -not [bool]$candidate.injectFailures -or
    [int]$candidate.restartEveryIterations -ne 5 -or
    [int]$candidate.maxRestartAttempts -ne 2 -or
    [string]$candidate.qualifiesFor -ne 'candidate-repetition'
) {
    throw 'Candidate soak gate no longer matches the adaptive 5-minute/100-action/two-restart contract.'
}

$stability = Read-SoakGate -Name 'Stability'
if (
    [int]$stability.minimumDurationMinutes -ne 20 -or
    [int]$stability.minimumActions -ne 250 -or
    [int]$stability.timeoutMinutes -ne 30 -or
    [double]$stability.requiredSuccessRate -ne 1 -or
    -not [bool]$stability.injectFailures -or
    [int]$stability.restartEveryIterations -ne 10 -or
    [int]$stability.maxRestartAttempts -ne 4 -or
    [string]$stability.qualifiesFor -ne 'stability-repetition'
) {
    throw 'Stability soak gate no longer matches the adaptive 20-minute/250-action/four-restart contract.'
}


function Read-QualificationPlan {
    param([Parameter(Mandatory)][string]$Name)
    $json = (& $qualificationPath -Gate $Name -DescribePlan) -join [Environment]::NewLine
    return $json | ConvertFrom-Json
}

$candidatePlan = Read-QualificationPlan -Name 'Candidate'
$stabilityPlan = Read-QualificationPlan -Name 'Stability'
if (
    [int]$candidatePlan.repetitions -ne 1 -or
    [int]$stabilityPlan.repetitions -ne 2 -or
    -not [bool]$candidatePlan.independentRuns -or
    -not [bool]$stabilityPlan.independentRuns -or
    -not [bool]$candidatePlan.stopOnFirstFailure -or
    -not [bool]$stabilityPlan.stopOnFirstFailure -or
    [string]$candidatePlan.qualifiesFor -ne 'beta-candidate' -or
    [string]$stabilityPlan.qualifiesFor -ne 'stable-release'
) {
    throw 'Development environment qualification must use one candidate run and two stability runs independently.'
}

$overridden = Read-SoakGate -Name 'Quick' -Overrides @{
    MinimumDurationMinutes = 7
    MinimumActions = 321
    TimeoutMinutes = 9
    IntervalSeconds = 6
    RestartEveryIterations = 4
    MaxRestartAttempts = 3
    InjectFailures = $true
}
if (
    [int]$overridden.minimumDurationMinutes -ne 7 -or
    [int]$overridden.minimumActions -ne 321 -or
    [int]$overridden.timeoutMinutes -ne 9 -or
    [int]$overridden.intervalSeconds -ne 6 -or
    [int]$overridden.restartEveryIterations -ne 4 -or
    [int]$overridden.maxRestartAttempts -ne 3 -or
    -not [bool]$overridden.injectFailures
) {
    throw 'Explicit soak gate overrides were not preserved.'
}

$source = Get-Content -LiteralPath $soakPath -Raw
if (
    -not $source.Contains("recordType = 'action'") -or
    -not $source.Contains('$durationSatisfied -and $actionsSatisfied') -or
    -not $source.Contains('$sourceDirty') -or
    -not $source.Contains('$restartAttempts -lt $resolved.maxRestartAttempts') -or
    $source.Contains('$ActionsPerIteration') -or
    $source.Contains('Endurance')
) {
    throw 'Soak runner must use real per-action evidence, bounded gates and no endurance residue.'
}
$qualificationSource = Get-Content -LiteralPath $qualificationPath -Raw
if (
    -not $qualificationSource.Contains('independentRuns = $true') -or
    -not $qualificationSource.Contains('& $soakPath -Gate $Gate')
) {
    throw 'Qualification runner must execute independent soak reports for every repetition.'
}

Write-Output 'Development environment soak gates passed: adaptive quick, candidate and stability contracts are separated.'
