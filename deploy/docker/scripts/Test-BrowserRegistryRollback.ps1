[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'ProductionLifecycle.Common.ps1')

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'mcp-browser-registry-rollback-test-' + [guid]::NewGuid().ToString('N')
)

function Write-TestRegistry {
    param(
        [Parameter(Mandatory = $true)][string]$RegistryDirectory,
        [Parameter(Mandatory = $true)][ValidateSet(5, 6)][int]$SchemaVersion,
        [Parameter(Mandatory = $true)][string]$Marker,
        [switch]$AddCandidateArtifact
    )

    New-Item -ItemType Directory -Force -Path $RegistryDirectory | Out-Null
    $session = [ordered]@{
        schemaVersion = $SchemaVersion
        browser = 'chrome'
        tabGroup = 'MCP'
        updatedAt = '2026-08-02T00:00:00.000Z'
        sessions = @()
        tabs = @()
        bindings = @()
    }
    if ($SchemaVersion -ge 5) {
        $session.tasks = @()
    }
    Write-McpJsonFile -Path (Join-Path $RegistryDirectory 'browser-session.json') -Value $session
    Set-Content `
        -LiteralPath (Join-Path $RegistryDirectory 'navigation-cache.json') `
        -Value ('{"schemaVersion":1,"marker":"' + $Marker + '"}') `
        -Encoding UTF8
    if ($AddCandidateArtifact) {
        Set-Content `
            -LiteralPath (Join-Path $RegistryDirectory 'candidate-only.txt') `
            -Value 'candidate-state' `
            -Encoding UTF8
    }
}

function New-TestEnvironment {
    param([Parameter(Mandatory = $true)][string]$Name)

    $root = Join-Path $tempRoot $Name
    $runtimeDirectory = Join-Path $root 'runtime\browser'
    $registryDirectory = Join-Path $runtimeDirectory 'registry'
    $backupDirectory = Join-Path $root 'runtime\promotion'
    $configPath = Join-Path $root 'browser.json'
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Write-McpJsonFile -Path $configPath -Value ([ordered]@{
        browser = [ordered]@{
            runtimeDirectory = $runtimeDirectory
        }
    })
    return [pscustomobject]@{
        root = $root
        runtimeDirectory = $runtimeDirectory
        registryDirectory = $registryDirectory
        backupDirectory = $backupDirectory
        configPath = $configPath
    }
}

try {
    # Exact rollback: preserve v6 in quarantine and restore v5 byte-for-byte.
    $normal = New-TestEnvironment -Name 'normal'
    Write-TestRegistry -RegistryDirectory $normal.registryDirectory -SchemaVersion 5 -Marker 'v5-before'
    $v5Before = Get-McpBrowserRegistryManifest -Directory $normal.registryDirectory
    $snapshot = New-McpBrowserRegistrySnapshot `
        -ProductionConfigPath $normal.configPath `
        -ProjectRoot $normal.root `
        -BackupDirectory $normal.backupDirectory `
        -ExpectedRegistrySchemaVersion 5
    if (
        [int]$snapshot.metadataSchemaVersion -ne 2 -or
        [int]$snapshot.registrySchemaVersion -ne 5 -or
        [string]$snapshot.manifestSha256 -ne [string]$v5Before.contentSha256
    ) {
        throw 'Browser registry v5 snapshot metadata is invalid.'
    }

    Remove-Item -LiteralPath $normal.registryDirectory -Recurse -Force
    Write-TestRegistry `
        -RegistryDirectory $normal.registryDirectory `
        -SchemaVersion 6 `
        -Marker 'v6-candidate' `
        -AddCandidateArtifact
    $v6BeforeRollback = Get-McpBrowserRegistryManifest -Directory $normal.registryDirectory
    $restored = Restore-McpBrowserRegistrySnapshot -Snapshot $snapshot
    if ([string]$restored.status -ne 'restored') {
        throw "Unexpected Browser registry rollback status: $($restored.status)"
    }
    $v5After = Get-McpBrowserRegistryManifest -Directory $normal.registryDirectory
    Assert-McpBrowserRegistryManifestMatch `
        -Expected $v5Before `
        -Actual $v5After `
        -Label 'Exact v5 registry restoration'
    $quarantine = Get-McpBrowserRegistryManifest -Directory $snapshot.quarantineDirectory
    Assert-McpBrowserRegistryManifestMatch `
        -Expected $v6BeforeRollback `
        -Actual $quarantine `
        -Label 'Candidate v6 registry quarantine'
    $quarantineMetadata = Read-McpJsonFile -Path $snapshot.quarantineMetadataPath
    if (
        [int]$quarantineMetadata.registrySchemaVersion -ne 6 -or
        [string]$quarantineMetadata.manifestSha256 -ne [string]$v6BeforeRollback.contentSha256
    ) {
        throw 'Candidate v6 quarantine metadata is invalid.'
    }
    $journal = Read-McpJsonFile -Path $snapshot.rollbackJournalPath
    if ([string]$journal.phase -ne 'completed') {
        throw 'Browser registry rollback journal did not reach completed.'
    }
    $secondRestore = Restore-McpBrowserRegistrySnapshot -Snapshot $snapshot
    if ([string]$secondRestore.status -ne 'already-restored') {
        throw 'Browser registry rollback is not idempotent after completion.'
    }

    # Snapshot tampering must fail before the current v6 registry is touched.
    $tampered = New-TestEnvironment -Name 'tampered'
    Write-TestRegistry -RegistryDirectory $tampered.registryDirectory -SchemaVersion 5 -Marker 'v5-snapshot'
    $tamperedSnapshot = New-McpBrowserRegistrySnapshot `
        -ProductionConfigPath $tampered.configPath `
        -ProjectRoot $tampered.root `
        -BackupDirectory $tampered.backupDirectory `
        -ExpectedRegistrySchemaVersion 5
    Remove-Item -LiteralPath $tampered.registryDirectory -Recurse -Force
    Write-TestRegistry `
        -RegistryDirectory $tampered.registryDirectory `
        -SchemaVersion 6 `
        -Marker 'v6-must-remain' `
        -AddCandidateArtifact
    $currentBeforeTamperFailure = Get-McpBrowserRegistryManifest -Directory $tampered.registryDirectory
    Add-Content `
        -LiteralPath (Join-Path $tamperedSnapshot.snapshotDirectory 'navigation-cache.json') `
        -Value 'tampered'
    $tamperRejected = $false
    try {
        Restore-McpBrowserRegistrySnapshot -Snapshot $tamperedSnapshot | Out-Null
    }
    catch {
        $tamperRejected = $_.Exception.Message -match 'manifest mismatch'
    }
    if (-not $tamperRejected) {
        throw 'Tampered Browser registry snapshot was not rejected.'
    }
    $currentAfterTamperFailure = Get-McpBrowserRegistryManifest -Directory $tampered.registryDirectory
    Assert-McpBrowserRegistryManifestMatch `
        -Expected $currentBeforeTamperFailure `
        -Actual $currentAfterTamperFailure `
        -Label 'Current registry after snapshot validation failure'
    if (Test-Path -LiteralPath $tamperedSnapshot.quarantineDirectory) {
        throw 'Snapshot validation failure must not quarantine or remove the current registry.'
    }

    # Resume after a crash between quarantine and the final atomic stage move.
    $resume = New-TestEnvironment -Name 'resume'
    Write-TestRegistry -RegistryDirectory $resume.registryDirectory -SchemaVersion 5 -Marker 'v5-resume'
    $resumeSnapshot = New-McpBrowserRegistrySnapshot `
        -ProductionConfigPath $resume.configPath `
        -ProjectRoot $resume.root `
        -BackupDirectory $resume.backupDirectory `
        -ExpectedRegistrySchemaVersion 5
    $resumeExpected = Get-McpBrowserRegistryManifest -Directory $resumeSnapshot.snapshotDirectory
    Remove-Item -LiteralPath $resume.registryDirectory -Recurse -Force
    Write-TestRegistry `
        -RegistryDirectory $resume.registryDirectory `
        -SchemaVersion 6 `
        -Marker 'v6-interrupted' `
        -AddCandidateArtifact
    $resumeCandidate = Get-McpBrowserRegistryManifest -Directory $resume.registryDirectory
    $stageDirectory = Join-Path `
        (Split-Path -Parent $resume.registryDirectory) `
        ('.browser-registry-restore-' + [string]$resumeSnapshot.snapshotId)
    Copy-McpBrowserRegistryVerified `
        -Source $resumeSnapshot.snapshotDirectory `
        -Destination $stageDirectory `
        -ExpectedManifest $resumeExpected | Out-Null
    Copy-McpBrowserRegistryVerified `
        -Source $resume.registryDirectory `
        -Destination $resumeSnapshot.quarantineDirectory `
        -ExpectedManifest $resumeCandidate | Out-Null
    Remove-Item -LiteralPath $resume.registryDirectory -Recurse -Force
    Write-McpJsonFile -Path $resumeSnapshot.rollbackJournalPath -Value ([ordered]@{
        schemaVersion = 1
        snapshotId = [string]$resumeSnapshot.snapshotId
        snapshotManifestSha256 = [string]$resumeSnapshot.manifestSha256
        registryDirectory = [string]$resumeSnapshot.registryDirectory
        stageDirectory = $stageDirectory
        quarantineDirectory = [string]$resumeSnapshot.quarantineDirectory
        phase = 'current-quarantined'
        updatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    })
    $resumed = Restore-McpBrowserRegistrySnapshot -Snapshot $resumeSnapshot
    if ([string]$resumed.status -ne 'restored') {
        throw 'Interrupted Browser registry rollback did not resume.'
    }
    $resumeActual = Get-McpBrowserRegistryManifest -Directory $resume.registryDirectory
    Assert-McpBrowserRegistryManifestMatch `
        -Expected $resumeExpected `
        -Actual $resumeActual `
        -Label 'Resumed v5 registry restoration'
    if (-not (Test-Path -LiteralPath $resumeSnapshot.quarantineMetadataPath -PathType Leaf)) {
        throw 'Crash resume did not reconstruct Browser registry quarantine metadata.'
    }
    $resumeQuarantineMetadata = Read-McpJsonFile -Path $resumeSnapshot.quarantineMetadataPath
    if ([string]$resumeQuarantineMetadata.manifestSha256 -ne [string]$resumeCandidate.contentSha256) {
        throw 'Crash resume reconstructed invalid quarantine metadata.'
    }

    Write-Output 'Browser registry rollback test passed: exact v5 restore, v6 quarantine, tamper rejection and crash resume are enforced.'
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
