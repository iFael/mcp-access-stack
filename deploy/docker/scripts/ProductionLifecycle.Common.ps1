Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-McpPowerShellAncestorProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$ProcessIds,

        [object[]]$Processes
    )

    $processList = if ($PSBoundParameters.ContainsKey('Processes')) {
        @($Processes)
    }
    else {
        @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    }

    $processesById = @{}
    foreach ($process in $processList) {
        $currentProcessId = [int]$process.ProcessId
        if ($currentProcessId -gt 0) {
            $processesById[$currentProcessId] = $process
        }
    }

    $powerShellAncestors = @{}
    foreach ($targetProcessId in $ProcessIds) {
        $currentProcessId = [int]$targetProcessId
        $visited = @{}
        while ($currentProcessId -gt 0 -and $processesById.ContainsKey($currentProcessId)) {
            if ($visited.ContainsKey($currentProcessId)) {
                break
            }
            $visited[$currentProcessId] = $true

            $current = $processesById[$currentProcessId]
            $parentId = [int]$current.ParentProcessId
            if ($parentId -le 0 -or -not $processesById.ContainsKey($parentId)) {
                break
            }

            $parent = $processesById[$parentId]
            if ([string]$parent.Name -match '^(powershell|pwsh)(\.exe)?$') {
                $powerShellAncestors[$parentId] = [pscustomobject]@{
                    ProcessId = $parentId
                    ParentProcessId = [int]$parent.ParentProcessId
                    Name = [string]$parent.Name
                    CommandLine = [string]$parent.CommandLine
                }
            }
            $currentProcessId = $parentId
        }
    }

    return @($powerShellAncestors.Values | Sort-Object ProcessId)
}

function Get-McpBrowserRegistryDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProductionConfigPath,

        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot
    )

    $configuration = Read-McpJsonFile -Path $ProductionConfigPath
    $runtimeDirectoryValue = [string]$configuration.browser.runtimeDirectory
    if ([string]::IsNullOrWhiteSpace($runtimeDirectoryValue)) {
        throw 'Production Browser Worker runtime directory is unavailable.'
    }

    $resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
    $allowedRuntimeRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedProjectRoot 'runtime'))
    $allowedRuntimePrefix = $allowedRuntimeRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $runtimeDirectory = [System.IO.Path]::GetFullPath($runtimeDirectoryValue)
    if (
        $runtimeDirectory -ne $allowedRuntimeRoot -and
        -not $runtimeDirectory.StartsWith($allowedRuntimePrefix, [StringComparison]::OrdinalIgnoreCase)
    ) {
        throw 'Production Browser Worker runtime directory must be inside the project runtime directory.'
    }

    return Join-Path $runtimeDirectory 'registry'
}

function Get-McpSha256Text {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Value
    )

    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Value)
        $hash = $algorithm.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
    }
}

function Get-McpBrowserRegistryManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory,

        [switch]$AllowMissing
    )

    $resolvedDirectory = [System.IO.Path]::GetFullPath($Directory)
    if (-not (Test-Path -LiteralPath $resolvedDirectory -PathType Container)) {
        if (-not $AllowMissing) {
            throw "Browser registry directory is missing: $resolvedDirectory"
        }
        return [pscustomobject]@{
            exists = $false
            directory = $resolvedDirectory
            registrySchemaVersion = $null
            fileCount = 0
            totalBytes = 0L
            contentSha256 = Get-McpSha256Text -Value ''
            files = @()
        }
    }

    $prefix = $resolvedDirectory.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $files = @(
        Get-ChildItem -LiteralPath $resolvedDirectory -Recurse -File |
            Sort-Object FullName |
            ForEach-Object {
                $fullPath = [System.IO.Path]::GetFullPath($_.FullName)
                if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Browser registry file escaped the registry directory: $fullPath"
                }
                [pscustomobject]@{
                    path = $fullPath.Substring($prefix.Length).Replace('\', '/')
                    sizeBytes = [long]$_.Length
                    sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
    )

    $schemaVersion = $null
    $sessionPath = Join-Path $resolvedDirectory 'browser-session.json'
    if (Test-Path -LiteralPath $sessionPath -PathType Leaf) {
        try {
            $session = Get-Content -Raw -LiteralPath $sessionPath | ConvertFrom-Json
            if ($null -ne $session.schemaVersion) {
                $schemaVersion = [int]$session.schemaVersion
            }
        }
        catch {
            throw "Browser registry session file is not valid JSON: $sessionPath"
        }
    }

    $canonicalLines = @(
        $files | ForEach-Object {
            '{0}`t{1}`t{2}' -f $_.path, $_.sizeBytes, $_.sha256
        }
    )
    $canonical = $canonicalLines -join "`n"
    $totalBytesMeasure = $files | Measure-Object -Property sizeBytes -Sum
    $totalBytes = if ($null -eq $totalBytesMeasure.Sum) { 0L } else { [long]$totalBytesMeasure.Sum }
    return [pscustomobject]@{
        exists = $true
        directory = $resolvedDirectory
        registrySchemaVersion = $schemaVersion
        fileCount = $files.Count
        totalBytes = $totalBytes
        contentSha256 = Get-McpSha256Text -Value $canonical
        files = $files
    }
}

function Assert-McpBrowserRegistryManifestMatch {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Expected,

        [Parameter(Mandatory = $true)]
        [object]$Actual,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if ([bool]$Expected.exists -ne [bool]$Actual.exists) {
        throw "$Label existence mismatch."
    }
    if (
        [string]$Expected.contentSha256 -ne [string]$Actual.contentSha256 -or
        [int]$Expected.fileCount -ne [int]$Actual.fileCount -or
        [long]$Expected.totalBytes -ne [long]$Actual.totalBytes
    ) {
        throw "$Label manifest mismatch."
    }
    if (
        $null -ne $Expected.registrySchemaVersion -and
        [int]$Expected.registrySchemaVersion -ne [int]$Actual.registrySchemaVersion
    ) {
        throw "$Label registry schema mismatch."
    }
}

function Copy-McpBrowserRegistryVerified {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,

        [Parameter(Mandatory = $true)]
        [string]$Destination,

        [Parameter(Mandatory = $true)]
        [object]$ExpectedManifest
    )

    if (Test-Path -LiteralPath $Destination) {
        throw "Verified registry copy destination already exists: $Destination"
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse
    $actual = Get-McpBrowserRegistryManifest -Directory $Destination
    Assert-McpBrowserRegistryManifestMatch `
        -Expected $ExpectedManifest `
        -Actual $actual `
        -Label 'Browser registry verified copy'
    return $actual
}

function New-McpBrowserRegistrySnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProductionConfigPath,

        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,

        [Parameter(Mandatory = $true)]
        [string]$BackupDirectory,

        [int]$ExpectedRegistrySchemaVersion = 0
    )

    $resolvedBackupDirectory = [System.IO.Path]::GetFullPath($BackupDirectory)
    $registryDirectory = Get-McpBrowserRegistryDirectory `
        -ProductionConfigPath $ProductionConfigPath `
        -ProjectRoot $ProjectRoot
    $snapshotId = [guid]::NewGuid().ToString('N')
    $snapshotDirectory = Join-Path $resolvedBackupDirectory 'browser-registry.before'
    $snapshotTemporaryDirectory = Join-Path $resolvedBackupDirectory ('.browser-registry.before.' + $snapshotId + '.tmp')
    $metadataPath = Join-Path $resolvedBackupDirectory 'browser-registry-snapshot.json'
    $journalPath = Join-Path $resolvedBackupDirectory 'browser-registry-rollback-journal.json'
    $quarantineDirectory = Join-Path $resolvedBackupDirectory 'browser-registry.after-candidate'
    $quarantineMetadataPath = Join-Path $resolvedBackupDirectory 'browser-registry-quarantine.json'
    $registryManifest = Get-McpBrowserRegistryManifest -Directory $registryDirectory -AllowMissing

    if ($ExpectedRegistrySchemaVersion -gt 0 -and $registryManifest.exists) {
        if ([int]$registryManifest.registrySchemaVersion -ne $ExpectedRegistrySchemaVersion) {
            throw "Unexpected Browser registry schema. Expected $ExpectedRegistrySchemaVersion, got $($registryManifest.registrySchemaVersion)."
        }
    }
    foreach ($path in @(
        $snapshotDirectory,
        $snapshotTemporaryDirectory,
        $metadataPath,
        $journalPath,
        $quarantineDirectory,
        $quarantineMetadataPath
    )) {
        if (Test-Path -LiteralPath $path) {
            throw "Browser registry rollback artifact already exists: $path"
        }
    }

    New-Item -ItemType Directory -Force -Path $resolvedBackupDirectory | Out-Null
    if ($registryManifest.exists) {
        try {
            Copy-McpBrowserRegistryVerified `
                -Source $registryDirectory `
                -Destination $snapshotTemporaryDirectory `
                -ExpectedManifest $registryManifest | Out-Null
            Move-Item -LiteralPath $snapshotTemporaryDirectory -Destination $snapshotDirectory
        }
        finally {
            Remove-Item -LiteralPath $snapshotTemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    $snapshotManifest = Get-McpBrowserRegistryManifest -Directory $snapshotDirectory -AllowMissing
    Assert-McpBrowserRegistryManifestMatch `
        -Expected $registryManifest `
        -Actual $snapshotManifest `
        -Label 'Browser registry snapshot'

    $snapshot = [pscustomobject]@{
        metadataSchemaVersion = 2
        snapshotId = $snapshotId
        registryDirectory = $registryDirectory
        snapshotDirectory = $snapshotDirectory
        rollbackJournalPath = $journalPath
        quarantineDirectory = $quarantineDirectory
        quarantineMetadataPath = $quarantineMetadataPath
        registryExisted = [bool]$registryManifest.exists
        registrySchemaVersion = $registryManifest.registrySchemaVersion
        manifestSha256 = [string]$snapshotManifest.contentSha256
        fileCount = [int]$snapshotManifest.fileCount
        totalBytes = [long]$snapshotManifest.totalBytes
        files = $snapshotManifest.files
        capturedAt = [DateTimeOffset]::UtcNow.ToString('O')
    }
    Write-McpJsonFile -Path $metadataPath -Value $snapshot
    return $snapshot
}

function Restore-McpBrowserRegistrySnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Snapshot
    )

    if ([int]$Snapshot.metadataSchemaVersion -ne 2) {
        throw 'Unsupported Browser registry snapshot metadata version.'
    }

    $snapshotId = [string]$Snapshot.snapshotId
    if ($snapshotId -notmatch '^[a-f0-9]{32}$') {
        throw 'Browser registry snapshot ID is invalid.'
    }
    $registryDirectory = [System.IO.Path]::GetFullPath([string]$Snapshot.registryDirectory)
    $snapshotDirectory = [System.IO.Path]::GetFullPath([string]$Snapshot.snapshotDirectory)
    $journalPath = [System.IO.Path]::GetFullPath([string]$Snapshot.rollbackJournalPath)
    $quarantineDirectory = [System.IO.Path]::GetFullPath([string]$Snapshot.quarantineDirectory)
    $quarantineMetadataPath = [System.IO.Path]::GetFullPath([string]$Snapshot.quarantineMetadataPath)
    $registryParent = Split-Path -Parent $registryDirectory
    $stageDirectory = Join-Path $registryParent ('.browser-registry-restore-' + $snapshotId)
    $snapshotManifest = Get-McpBrowserRegistryManifest -Directory $snapshotDirectory -AllowMissing
    $expectedManifest = [pscustomobject]@{
        exists = [bool]$Snapshot.registryExisted
        registrySchemaVersion = $Snapshot.registrySchemaVersion
        contentSha256 = [string]$Snapshot.manifestSha256
        fileCount = [int]$Snapshot.fileCount
        totalBytes = [long]$Snapshot.totalBytes
    }
    Assert-McpBrowserRegistryManifestMatch `
        -Expected $expectedManifest `
        -Actual $snapshotManifest `
        -Label 'Browser registry rollback source'

    $journal = if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
        Read-McpJsonFile -Path $journalPath
    }
    else {
        [pscustomobject]@{
            schemaVersion = 1
            snapshotId = $snapshotId
            snapshotManifestSha256 = [string]$Snapshot.manifestSha256
            registryDirectory = $registryDirectory
            stageDirectory = $stageDirectory
            quarantineDirectory = $quarantineDirectory
            phase = 'validated-snapshot'
            updatedAt = [DateTimeOffset]::UtcNow.ToString('O')
        }
    }
    if (
        [int]$journal.schemaVersion -ne 1 -or
        [string]$journal.snapshotId -ne $snapshotId -or
        [string]$journal.snapshotManifestSha256 -ne [string]$Snapshot.manifestSha256 -or
        [System.IO.Path]::GetFullPath([string]$journal.registryDirectory) -ne $registryDirectory -or
        [System.IO.Path]::GetFullPath([string]$journal.stageDirectory) -ne $stageDirectory -or
        [System.IO.Path]::GetFullPath([string]$journal.quarantineDirectory) -ne $quarantineDirectory
    ) {
        throw 'Browser registry rollback journal does not match the requested snapshot.'
    }
    Write-McpJsonFile -Path $journalPath -Value $journal

    $currentManifest = Get-McpBrowserRegistryManifest -Directory $registryDirectory -AllowMissing
    if ($currentManifest.exists) {
        try {
            Assert-McpBrowserRegistryManifestMatch `
                -Expected $expectedManifest `
                -Actual $currentManifest `
                -Label 'Already restored Browser registry'
            $journal.phase = 'completed'
            $journal.updatedAt = [DateTimeOffset]::UtcNow.ToString('O')
            Write-McpJsonFile -Path $journalPath -Value $journal
            return [pscustomobject]@{
                status = 'already-restored'
                restoredManifestSha256 = [string]$currentManifest.contentSha256
                quarantineDirectory = if (Test-Path -LiteralPath $quarantineDirectory) { $quarantineDirectory } else { $null }
                journalPath = $journalPath
            }
        }
        catch {
        }
    }

    if ($Snapshot.registryExisted -and -not (Test-Path -LiteralPath $stageDirectory -PathType Container)) {
        Copy-McpBrowserRegistryVerified `
            -Source $snapshotDirectory `
            -Destination $stageDirectory `
            -ExpectedManifest $expectedManifest | Out-Null
        $journal.phase = 'staged-restore'
        $journal.updatedAt = [DateTimeOffset]::UtcNow.ToString('O')
        Write-McpJsonFile -Path $journalPath -Value $journal
    }
    elseif ($Snapshot.registryExisted) {
        $stagedManifest = Get-McpBrowserRegistryManifest -Directory $stageDirectory
        Assert-McpBrowserRegistryManifestMatch `
            -Expected $expectedManifest `
            -Actual $stagedManifest `
            -Label 'Browser registry rollback staging'
    }

    $currentManifest = Get-McpBrowserRegistryManifest -Directory $registryDirectory -AllowMissing
    if ($currentManifest.exists) {
        if (Test-Path -LiteralPath $quarantineDirectory) {
            $quarantineManifest = Get-McpBrowserRegistryManifest -Directory $quarantineDirectory
            Assert-McpBrowserRegistryManifestMatch `
                -Expected $currentManifest `
                -Actual $quarantineManifest `
                -Label 'Existing Browser registry quarantine'
        }
        else {
            $quarantineTemporaryDirectory = $quarantineDirectory + '.' + $snapshotId + '.tmp'
            try {
                Copy-McpBrowserRegistryVerified `
                    -Source $registryDirectory `
                    -Destination $quarantineTemporaryDirectory `
                    -ExpectedManifest $currentManifest | Out-Null
                Move-Item -LiteralPath $quarantineTemporaryDirectory -Destination $quarantineDirectory
            }
            finally {
                Remove-Item -LiteralPath $quarantineTemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        if (Test-Path -LiteralPath $quarantineMetadataPath -PathType Leaf) {
            $quarantineMetadata = Read-McpJsonFile -Path $quarantineMetadataPath
            if (
                [int]$quarantineMetadata.schemaVersion -ne 1 -or
                [string]$quarantineMetadata.snapshotId -ne $snapshotId -or
                [string]$quarantineMetadata.manifestSha256 -ne [string]$currentManifest.contentSha256 -or
                [int]$quarantineMetadata.fileCount -ne [int]$currentManifest.fileCount -or
                [long]$quarantineMetadata.totalBytes -ne [long]$currentManifest.totalBytes -or
                [System.IO.Path]::GetFullPath([string]$quarantineMetadata.quarantineDirectory) -ne $quarantineDirectory
            ) {
                throw 'Browser registry quarantine metadata does not match the quarantined state.'
            }
        }
        else {
            Write-McpJsonFile -Path $quarantineMetadataPath -Value ([ordered]@{
                schemaVersion = 1
                snapshotId = $snapshotId
                registrySchemaVersion = $currentManifest.registrySchemaVersion
                manifestSha256 = [string]$currentManifest.contentSha256
                fileCount = [int]$currentManifest.fileCount
                totalBytes = [long]$currentManifest.totalBytes
                quarantinedAt = [DateTimeOffset]::UtcNow.ToString('O')
                quarantineDirectory = $quarantineDirectory
            })
        }
        Remove-Item -LiteralPath $registryDirectory -Recurse -Force
        $journal.phase = 'current-quarantined'
        $journal.updatedAt = [DateTimeOffset]::UtcNow.ToString('O')
        Write-McpJsonFile -Path $journalPath -Value $journal
    }
    elseif (Test-Path -LiteralPath $quarantineDirectory -PathType Container) {
        $quarantineManifest = Get-McpBrowserRegistryManifest -Directory $quarantineDirectory
        if (Test-Path -LiteralPath $quarantineMetadataPath -PathType Leaf) {
            $quarantineMetadata = Read-McpJsonFile -Path $quarantineMetadataPath
            if (
                [int]$quarantineMetadata.schemaVersion -ne 1 -or
                [string]$quarantineMetadata.snapshotId -ne $snapshotId -or
                [string]$quarantineMetadata.manifestSha256 -ne [string]$quarantineManifest.contentSha256 -or
                [int]$quarantineMetadata.fileCount -ne [int]$quarantineManifest.fileCount -or
                [long]$quarantineMetadata.totalBytes -ne [long]$quarantineManifest.totalBytes -or
                [System.IO.Path]::GetFullPath([string]$quarantineMetadata.quarantineDirectory) -ne $quarantineDirectory
            ) {
                throw 'Browser registry quarantine metadata does not match the resumed quarantine.'
            }
        }
        else {
            Write-McpJsonFile -Path $quarantineMetadataPath -Value ([ordered]@{
                schemaVersion = 1
                snapshotId = $snapshotId
                registrySchemaVersion = $quarantineManifest.registrySchemaVersion
                manifestSha256 = [string]$quarantineManifest.contentSha256
                fileCount = [int]$quarantineManifest.fileCount
                totalBytes = [long]$quarantineManifest.totalBytes
                quarantinedAt = [DateTimeOffset]::UtcNow.ToString('O')
                quarantineDirectory = $quarantineDirectory
            })
        }
    }

    if ($Snapshot.registryExisted) {
        if (-not (Test-Path -LiteralPath $stageDirectory -PathType Container)) {
            throw "Browser registry rollback staging directory is missing: $stageDirectory"
        }
        New-Item -ItemType Directory -Force -Path $registryParent | Out-Null
        Move-Item -LiteralPath $stageDirectory -Destination $registryDirectory
    }
    $journal.phase = 'restored-snapshot'
    $journal.updatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    Write-McpJsonFile -Path $journalPath -Value $journal

    $restoredManifest = Get-McpBrowserRegistryManifest -Directory $registryDirectory -AllowMissing
    Assert-McpBrowserRegistryManifestMatch `
        -Expected $expectedManifest `
        -Actual $restoredManifest `
        -Label 'Restored Browser registry'
    $journal.phase = 'completed'
    $journal.updatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    Write-McpJsonFile -Path $journalPath -Value $journal

    return [pscustomobject]@{
        status = 'restored'
        restoredManifestSha256 = [string]$restoredManifest.contentSha256
        quarantineDirectory = if (Test-Path -LiteralPath $quarantineDirectory) { $quarantineDirectory } else { $null }
        quarantineMetadataPath = if (Test-Path -LiteralPath $quarantineMetadataPath) { $quarantineMetadataPath } else { $null }
        journalPath = $journalPath
    }
}

function Test-McpTerminalProductionLifecycleStatus {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Status
    )

    return $Status -in @(
        'passed',
        'rolled-back',
        'rollback-failed',
        'failed',
        'passed-after-controlled-recovery'
    )
}
