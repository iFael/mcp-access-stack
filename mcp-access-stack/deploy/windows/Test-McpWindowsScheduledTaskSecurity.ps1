[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
. $commonPath

function Get-TestUserAces {
    param(
        [Parameter(Mandatory = $true)][string]$Sddl,
        [Parameter(Mandatory = $true)][string]$UserSid
    )

    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
    $result = [System.Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $descriptor.DiscretionaryAcl.Count; $index++) {
        $ace = $descriptor.DiscretionaryAcl[$index]
        if ($ace -is [Security.AccessControl.KnownAce] -and
            [string]$ace.SecurityIdentifier.Value -eq $UserSid) {
            $result.Add($ace)
        }
    }
    return @($result)
}

function Assert-DaclOnly {
    param([Parameter(Mandatory = $true)][string]$Sddl)

    if (-not $Sddl.StartsWith('D:', [StringComparison]::Ordinal) -or
        $Sddl.Contains('O:', [StringComparison]::Ordinal) -or
        $Sddl.Contains('G:', [StringComparison]::Ordinal)) {
        throw "Task owner ACL normalization must return DACL-only SDDL. sddl=$Sddl"
    }
}

$userSid = 'S-1-5-21-111-222-333-1001'
$fullAccessMask = 0x1f01ff
$readMask = 0x120089

# Elevated-created task: there is no inherited Full Access for the user.
# Normalize the principal's explicit read ACE into exactly one explicit Full Access ACE.
$explicitOnlyCurrent = "O:BAG:BAD:(A;;FA;;;BA)(A;;FA;;;SY)(A;;FR;;;$userSid)"
$explicitOnlyTarget = Get-McpWindowsScheduledTaskOwnerSddl `
    -CurrentSddl $explicitOnlyCurrent `
    -UserId $userSid
Assert-DaclOnly -Sddl $explicitOnlyTarget
$explicitOnlyUserAces = @(Get-TestUserAces -Sddl $explicitOnlyTarget -UserSid $userSid)
if ($explicitOnlyUserAces.Count -ne 1) {
    throw "Task without inherited Full Access must contain exactly one user ACE. count=$($explicitOnlyUserAces.Count)"
}
if ([int]$explicitOnlyUserAces[0].AccessMask -ne $fullAccessMask -or
    ($explicitOnlyUserAces[0].AceFlags -band [Security.AccessControl.AceFlags]::Inherited)) {
    throw 'Task without inherited Full Access must normalize to one explicit Full Access ACE.'
}

# Non-elevated-created task: CREATOR OWNER already materialized an inherited Full Access ACE.
# Do not add another explicit Full Access ACE; preserve the standard explicit principal read ACE.
$inheritedCurrent = "O:$userSid" + "G:BAD:(A;ID;FA;;;$userSid)(A;;FA;;;$userSid)(A;;FR;;;$userSid)(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)"
$inheritedTarget = Get-McpWindowsScheduledTaskOwnerSddl `
    -CurrentSddl $inheritedCurrent `
    -UserId $userSid
Assert-DaclOnly -Sddl $inheritedTarget
$inheritedUserAces = @(Get-TestUserAces -Sddl $inheritedTarget -UserSid $userSid)
$inheritedFull = @($inheritedUserAces | Where-Object {
    ($_.AceFlags -band [Security.AccessControl.AceFlags]::Inherited) -and
    [string]$_.AceQualifier -eq 'AccessAllowed' -and
    [int]$_.AccessMask -eq $fullAccessMask
})
$explicitFull = @($inheritedUserAces | Where-Object {
    -not ($_.AceFlags -band [Security.AccessControl.AceFlags]::Inherited) -and
    [string]$_.AceQualifier -eq 'AccessAllowed' -and
    [int]$_.AccessMask -eq $fullAccessMask
})
$explicitRead = @($inheritedUserAces | Where-Object {
    -not ($_.AceFlags -band [Security.AccessControl.AceFlags]::Inherited) -and
    [string]$_.AceQualifier -eq 'AccessAllowed' -and
    [int]$_.AccessMask -eq $readMask
})
if ($inheritedFull.Count -ne 1) {
    throw "Inherited Full Access must be preserved. count=$($inheritedFull.Count)"
}
if ($explicitFull.Count -ne 0) {
    throw "Inherited Full Access makes explicit Full Access redundant. explicitFull=$($explicitFull.Count)"
}
if ($explicitRead.Count -ne 1) {
    throw "Standard explicit principal read ACE must be preserved. explicitRead=$($explicitRead.Count)"
}

$inheritedSecondPass = Get-McpWindowsScheduledTaskOwnerSddl `
    -CurrentSddl $inheritedTarget `
    -UserId $userSid
if (-not $inheritedSecondPass.Equals($inheritedTarget, [StringComparison]::Ordinal)) {
    throw "Task owner ACL normalization must be idempotent. first=$inheritedTarget second=$inheritedSecondPass"
}

foreach ($installerName in @('Install-McpEdgeConnectorTask.ps1', 'Install-McpBrowserWorkerTask.ps1')) {
    $installerPath = Join-Path $PSScriptRoot $installerName
    $source = Get-Content -LiteralPath $installerPath -Raw
    if (-not $source.Contains('Set-McpWindowsScheduledTaskOwnerAccess')) {
        throw "$installerName must normalize Scheduled Task owner access after registration."
    }
    if ($source.Contains('Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false')) {
        throw "$installerName must replace an existing task in place instead of unregistering it."
    }
    if ($source -notmatch 'Register-ScheduledTask\s+-TaskName \$TaskName\s+-InputObject \$task\s+-Force') {
        throw "$installerName must use Register-ScheduledTask -Force for in-place replacement."
    }
}

$brokerPath = Join-Path $PSScriptRoot 'Invoke-McpAccessStackCutoverBroker.ps1'
$brokerSource = Get-Content -LiteralPath $brokerPath -Raw
if ($brokerSource -notmatch 'userId\s*=\s*\[string\]\$task\.Principal\.UserId') {
    throw 'Cutover rollback snapshot must retain the Scheduled Task owner identity.'
}
if ($brokerSource -notmatch 'Register-ScheduledTask\s+-TaskName \$TaskName\s+-Xml \(\[string\]\$Snapshot\.xml\)\s+-Force') {
    throw 'Cutover rollback must restore an existing task in place with Register-ScheduledTask -Force.'
}
if ($brokerSource -notmatch 'Set-McpWindowsScheduledTaskOwnerAccess\s+-TaskName \$TaskName\s+-UserId \(\[string\]\$Snapshot\.userId\)') {
    throw 'Cutover rollback must reapply the owner ACL after restoring the task snapshot.'
}

Write-Output 'Windows Scheduled Task owner ACL and in-place replacement contracts passed.'
