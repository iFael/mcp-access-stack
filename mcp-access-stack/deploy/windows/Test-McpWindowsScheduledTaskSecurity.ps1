[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
. $commonPath

$userSid = 'S-1-5-21-111-222-333-1001'
$currentSddl = "O:BAG:BAD:(A;;FA;;;BA)(A;;FA;;;SY)(A;;FR;;;$userSid)"
$updatedSddl = Get-McpWindowsScheduledTaskOwnerSddl `
    -CurrentSddl $currentSddl `
    -UserId $userSid

if (-not $updatedSddl.StartsWith('D:', [StringComparison]::Ordinal) -or
    $updatedSddl.Contains('O:', [StringComparison]::Ordinal) -or
    $updatedSddl.Contains('G:', [StringComparison]::Ordinal)) {
    throw "Task owner ACL normalization must return DACL-only SDDL so a non-elevated owner can persist it. sddl=$updatedSddl"
}

$descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($updatedSddl)
$userAces = [System.Collections.Generic.List[object]]::new()
for ($index = 0; $index -lt $descriptor.DiscretionaryAcl.Count; $index++) {
    $ace = $descriptor.DiscretionaryAcl[$index]
    if ($ace -is [Security.AccessControl.KnownAce] -and
        [string]$ace.SecurityIdentifier.Value -eq $userSid) {
        $userAces.Add($ace)
    }
}
if ($userAces.Count -ne 1) {
    throw "Task owner ACL must contain exactly one explicit owner ACE. count=$($userAces.Count)"
}
if ([int]$userAces[0].AccessMask -ne 0x1f01ff) {
    throw ('Task owner ACL must grant Full Access. mask=0x{0:x}' -f [int]$userAces[0].AccessMask)
}

foreach ($installerName in @('Install-McpEdgeConnectorTask.ps1', 'Install-McpBrowserWorkerTask.ps1')) {
    $installerPath = Join-Path $PSScriptRoot $installerName
    $source = Get-Content -LiteralPath $installerPath -Raw
    if (-not $source.Contains('Set-McpWindowsScheduledTaskOwnerAccess')) {
        throw "$installerName must normalize Scheduled Task owner access after registration."
    }
}

Write-Output 'Windows Scheduled Task owner ACL contract passed.'
