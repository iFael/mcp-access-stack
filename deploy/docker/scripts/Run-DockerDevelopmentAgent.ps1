[CmdletBinding()]
param(
    [string]$ReleaseRoot,
    [string]$ConfigurationPath
)

$runner = Join-Path $PSScriptRoot 'Run-DockerHostAgent.ps1'
& $runner -Environment development -ReleaseRoot $ReleaseRoot -ConfigurationPath $ConfigurationPath
exit $LASTEXITCODE
