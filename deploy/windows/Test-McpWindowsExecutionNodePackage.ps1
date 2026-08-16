[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot
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
    [string]$verification.executionManifest.integrityRoot -ne 'signed-distribution-manifest') {
    throw 'Execution-node package validation returned an unexpected runtime or integrity mode.'
}

Write-Output 'Signed Windows execution-node package passed manifest, hash, signature and runtime smoke validation.'
