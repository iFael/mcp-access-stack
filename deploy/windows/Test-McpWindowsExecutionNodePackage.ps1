[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [switch]$CheckManifestOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $root 'deploy\windows\PublicDistribution.Common.ps1')
. (Join-Path $root 'deploy\windows\WindowsExecutionNode.Common.ps1')

$verification = Assert-McpWindowsExecutionNodeRelease `
    -ReleaseRoot $ReleaseRoot `
    -RuntimeSmoke

if ([string]$verification.executionManifest.runtimeMode -ne 'bundled-node' -or
    [string]$verification.executionManifest.integrityRoot -ne 'sha256-distribution-manifest') {
    throw 'Execution-node package validation returned an unexpected runtime or integrity mode.'
}

Write-Output 'Windows execution-node package passed manifest, SHA-256 and runtime smoke validation.'
