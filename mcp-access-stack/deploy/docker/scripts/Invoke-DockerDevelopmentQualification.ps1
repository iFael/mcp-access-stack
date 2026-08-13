[CmdletBinding()]
param(
    [ValidateSet('Candidate', 'Stability')]
    [string]$Gate = 'Candidate',
    [switch]$DescribePlan
)

$ErrorActionPreference = 'Stop'
$soakPath = Join-Path $PSScriptRoot 'Invoke-DockerDevelopmentSoak.ps1'
$defaults = @{
    Candidate = 1
    Stability = 2
}
$resolvedRepetitions = [int]$defaults[$Gate]
$qualifiesFor = if ($Gate -eq 'Candidate') {
    'beta-candidate'
} else {
    'stable-release'
}

$plan = [ordered]@{
    gate = $Gate.ToLowerInvariant()
    repetitions = $resolvedRepetitions
    independentRuns = $true
    stopOnFirstFailure = $true
    qualifiesFor = $qualifiesFor
}
if ($DescribePlan) {
    $plan | ConvertTo-Json -Depth 4
    return
}

for ($run = 1; $run -le $resolvedRepetitions; $run += 1) {
    Write-Output ('Starting independent {0} development environment run {1}/{2}.' -f $plan.gate, $run, $resolvedRepetitions)
    & $soakPath -Gate $Gate
}

Write-Output ('Development environment {0} qualification passed in {1} independent runs; qualifiesFor={2}.' -f $plan.gate, $resolvedRepetitions, $qualifiesFor)
