[CmdletBinding()]
param(
    [ValidateRange(1, 100)]
    [int]$Samples = 10,

    [ValidateRange(0, 20)]
    [int]$Warmups = 2,

    [string]$ReleaseRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Get-McpProjectRoot
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = $root
}
$resolvedReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
$benchmarkPath = Join-Path $resolvedReleaseRoot 'tooling\benchmarks\browser\benchmark-browser-auth-cold-path.mjs'
$browserWorkerEntry = Join-Path $resolvedReleaseRoot 'services\browser-worker\dist\server.js'
if (-not (Test-Path -LiteralPath $benchmarkPath -PathType Leaf)) {
    throw "Browser authentication cold-path benchmark is missing: $benchmarkPath"
}
if (-not (Test-Path -LiteralPath $browserWorkerEntry -PathType Leaf)) {
    throw 'Browser Worker must be built before the authentication cold-path benchmark.'
}

$broker = Get-McpCredentialBrokerExecutable `
    -ProjectRoot $root `
    -ReleaseRoot $resolvedReleaseRoot
$node = Get-McpNodeExecutable -ReleaseRoot $resolvedReleaseRoot

$global:LASTEXITCODE = 0
& $node $benchmarkPath `
    '--candidate-root' $resolvedReleaseRoot `
    '--broker-path' $broker `
    '--samples' ([string]$Samples) `
    '--warmups' ([string]$Warmups)
$exitCode = [int]$global:LASTEXITCODE
if ($exitCode -ne 0) {
    throw "Browser authentication cold-path benchmark failed with exit code $exitCode."
}
