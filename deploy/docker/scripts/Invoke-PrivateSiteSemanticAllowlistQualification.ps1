[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'LegacySite semantic allowlist qualification is supported only on Windows.'
}

. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Get-McpProjectRoot
$qualifierPath = Join-Path $root 'tooling\qualification\browser\qualify-private-site-semantic-allowlist.ts'
if (-not (Test-Path -LiteralPath $qualifierPath -PathType Leaf)) {
    throw "LegacySite semantic allowlist qualifier is missing: $qualifierPath"
}

$broker = Get-McpCredentialBrokerExecutable -ProjectRoot $root -ReleaseRoot $root
$previousBrokerPath = [Environment]::GetEnvironmentVariable('MCP_QUALIFICATION_BROKER_PATH', 'Process')
try {
    [Environment]::SetEnvironmentVariable('MCP_QUALIFICATION_BROKER_PATH', $broker, 'Process')
    $global:LASTEXITCODE = 0
    & npx tsx $qualifierPath
    $exitCode = [int]$global:LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "LegacySite semantic allowlist qualification failed with exit code $exitCode."
    }
}
finally {
    [Environment]::SetEnvironmentVariable(
        'MCP_QUALIFICATION_BROKER_PATH',
        $previousBrokerPath,
        'Process'
    )
}
