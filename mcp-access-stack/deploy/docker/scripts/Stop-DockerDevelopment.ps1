[CmdletBinding()]
param(
    [switch]$KeepContainers
)

. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Get-McpProjectRoot
$runtimeDirectory = Join-Path $root 'runtime\docker-development'
$statePath = Join-Path $runtimeDirectory 'agent-process.json'

if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try {
        $state = Read-McpJsonFile -Path $statePath
        $processId = [int]$state.pid
        if (Test-McpProcessAlive -ProcessId $processId) {
            Stop-Process -Id $processId -ErrorAction Stop
            try {
                Wait-Process -Id $processId -Timeout 15 -ErrorAction Stop
            }
            catch {
                Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
            }
        }
    }
    finally {
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    }
}

if (-not $KeepContainers) {
    $composeArguments = Get-McpComposeArguments -Environment 'development'
    Push-Location $root
    try {
        & docker compose @composeArguments --profile tunnel down --remove-orphans
        if ($LASTEXITCODE -ne 0) {
            throw 'Unable to stop the Docker development environment.'
        }
    }
    finally {
        Pop-Location
    }
}

Write-Output 'Docker development environment stopped.'
