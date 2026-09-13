[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-McpWindowsExecutionNodeSignature {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$AllowUnsignedDevelopment
    )

    if ($AllowUnsignedDevelopment) {
        $signature = Get-AuthenticodeSignature -LiteralPath $Path
        if ($signature.Status -in @('NotSigned', 'UnknownError') -and $null -eq $signature.SignerCertificate) {
            return
        }
    }
    Assert-McpPublicSignature -Path $Path -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
}
function Resolve-McpWindowsAccountSidValue {
    param([Parameter(Mandatory = $true)][string]$UserId)

    if ([string]::IsNullOrWhiteSpace($UserId)) {
        return $null
    }
    try {
        if ($UserId -match '^S-\d-\d+(?:-\d+)+$') {
            return ([Security.Principal.SecurityIdentifier]::new($UserId)).Value
        }
        $account = [Security.Principal.NTAccount]::new($UserId)
        return ([Security.Principal.SecurityIdentifier]$account.Translate(
            [Security.Principal.SecurityIdentifier]
        )).Value
    }
    catch {
        return $null
    }
}

function Test-McpWindowsAccountIdentityEquivalent {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        return $false
    }
    if ($Left.Equals($Right, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    $leftSid = Resolve-McpWindowsAccountSidValue -UserId $Left
    $rightSid = Resolve-McpWindowsAccountSidValue -UserId $Right
    return -not [string]::IsNullOrWhiteSpace($leftSid) -and
        -not [string]::IsNullOrWhiteSpace($rightSid) -and
        $leftSid.Equals($rightSid, [StringComparison]::OrdinalIgnoreCase)
}
function Get-McpWindowsScheduledTaskOwnerSddl {
    param(
        [Parameter(Mandatory = $true)][string]$CurrentSddl,
        [Parameter(Mandatory = $true)][string]$UserId
    )

    $sidValue = Resolve-McpWindowsAccountSidValue -UserId $UserId
    if ([string]::IsNullOrWhiteSpace($sidValue)) {
        throw "Scheduled Task owner SID could not be resolved: $UserId"
    }
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($CurrentSddl)
    if ($null -eq $descriptor.DiscretionaryAcl) {
        throw 'Scheduled Task security descriptor is missing a DACL.'
    }

    $sid = [Security.Principal.SecurityIdentifier]::new($sidValue)
    for ($index = $descriptor.DiscretionaryAcl.Count - 1; $index -ge 0; $index--) {
        $ace = $descriptor.DiscretionaryAcl[$index]
        if ($ace -is [Security.AccessControl.KnownAce] -and
            [string]$ace.SecurityIdentifier.Value -eq $sidValue) {
            $descriptor.DiscretionaryAcl.RemoveAce($index)
        }
    }

    $ownerAce = [Security.AccessControl.CommonAce]::new(
        [Security.AccessControl.AceFlags]::None,
        [Security.AccessControl.AceQualifier]::AccessAllowed,
        0x1f01ff,
        $sid,
        $false,
        $null
    )
    $descriptor.DiscretionaryAcl.InsertAce($descriptor.DiscretionaryAcl.Count, $ownerAce)
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
        [Security.AccessControl.AccessControlSections]::Group -bor
        [Security.AccessControl.AccessControlSections]::Access
    return $descriptor.GetSddlForm($sections)
}

function Set-McpWindowsScheduledTaskOwnerAccess {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$UserId
    )

    $service = New-Object -ComObject 'Schedule.Service'
    $folder = $null
    $registeredTask = $null
    try {
        $service.Connect()
        $folder = $service.GetFolder('\')
        $registeredTask = $folder.GetTask($TaskName)
        $currentSddl = [string]$registeredTask.GetSecurityDescriptor(7)
        $targetSddl = Get-McpWindowsScheduledTaskOwnerSddl `
            -CurrentSddl $currentSddl `
            -UserId $UserId
        $changed = -not $currentSddl.Equals($targetSddl, [StringComparison]::Ordinal)
        if ($changed) {
            $registeredTask.SetSecurityDescriptor($targetSddl, 0x10)
        }

        $verifiedSddl = [string]$registeredTask.GetSecurityDescriptor(7)
        $verified = [Security.AccessControl.RawSecurityDescriptor]::new($verifiedSddl)
        $sidValue = Resolve-McpWindowsAccountSidValue -UserId $UserId
        $fullAccess = $false
        for ($index = 0; $index -lt $verified.DiscretionaryAcl.Count; $index++) {
            $ace = $verified.DiscretionaryAcl[$index]
            if ($ace -is [Security.AccessControl.KnownAce] -and
                [string]$ace.SecurityIdentifier.Value -eq $sidValue -and
                [int]$ace.AccessMask -eq 0x1f01ff) {
                $fullAccess = $true
                break
            }
        }
        if (-not $fullAccess) {
            throw "Scheduled Task owner access was not persisted: $TaskName"
        }
        return [pscustomobject]@{ changed = $changed; ownerSid = $sidValue }
    }
    finally {
        foreach ($comObject in @($registeredTask, $folder, $service)) {
            if ($null -ne $comObject -and [Runtime.InteropServices.Marshal]::IsComObject($comObject)) {
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($comObject)
            }
        }
    }
}
function Assert-McpWindowsExecutionNodeNoReparsePoints {
    param([Parameter(Mandatory = $true)][string]$Root)

    $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    if (-not (Test-Path -LiteralPath $resolvedRoot)) {
        throw "Execution-node path was not found: $resolvedRoot"
    }

    $items = @(
        Get-Item -LiteralPath $resolvedRoot -Force
        Get-ChildItem -LiteralPath $resolvedRoot -Force -Recurse
    )
    foreach ($item in $items) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Execution-node staging rejects reparse points: $($item.FullName)"
        }
    }
}

function Assert-McpWindowsExecutionNodeDistributionCompleteness {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][object]$Manifest
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    $expected = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($Manifest.files)) {
        $relativePath = ([string]$entry.path).Replace('\', '/')
        if (-not $expected.Add($relativePath)) {
            throw "Signed distribution manifest contains a duplicate path: $relativePath"
        }
    }

    $actual = @(
        Get-ChildItem -LiteralPath $resolvedRoot -Recurse -Force -File |
            Where-Object { $_.FullName -ne (Join-Path $resolvedRoot 'distribution-manifest.ps1') } |
            ForEach-Object {
                [System.IO.Path]::GetRelativePath($resolvedRoot, $_.FullName).Replace('\', '/')
            }
    )
    if ($actual.Count -ne $expected.Count) {
        throw 'Signed distribution file set does not match the extracted package.'
    }
    foreach ($relativePath in $actual) {
        if (-not $expected.Contains($relativePath)) {
            throw "Extracted distribution contains an unsigned extra file: $relativePath"
        }
    }
}

function Assert-McpWindowsExecutionNodeMaterializedRelease {
    param(
        [Parameter(Mandatory = $true)][object]$DistributionManifest,
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot
    )

    $resolvedRelease = [System.IO.Path]::GetFullPath($ReleaseRoot)
    $prefix = "releases/$ReleaseId/"
    $entries = @(
        $DistributionManifest.files |
            Where-Object { ([string]$_.path).Replace('\', '/').StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }
    )
    if ($entries.Count -eq 0) {
        throw 'Signed distribution manifest contains no files for the requested execution-node release.'
    }

    $expected = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $entries) {
        $signedPath = ([string]$entry.path).Replace('\', '/')
        $relativePath = $signedPath.Substring($prefix.Length)
        if ([string]::IsNullOrWhiteSpace($relativePath) -or -not $expected.Add($relativePath)) {
            throw "Signed execution-node release path is invalid or duplicated: $signedPath"
        }
        $targetPath = Resolve-McpPublicChildPath -Root $resolvedRelease -RelativePath $relativePath
        if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
            throw "Materialized execution-node release is missing a signed file: $relativePath"
        }
        $expectedHash = ([string]$entry.sha256).ToLowerInvariant()
        $actualHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expectedHash -notmatch '^[a-f0-9]{64}$' -or $actualHash -ne $expectedHash) {
            throw "Materialized execution-node release hash mismatch: $relativePath"
        }
    }

    $actual = @(
        Get-ChildItem -LiteralPath $resolvedRelease -Recurse -Force -File |
            ForEach-Object {
                [System.IO.Path]::GetRelativePath($resolvedRelease, $_.FullName).Replace('\', '/')
            }
    )
    if ($actual.Count -ne $expected.Count) {
        throw 'Materialized execution-node release file set differs from the signed distribution.'
    }
    foreach ($relativePath in $actual) {
        if (-not $expected.Contains($relativePath)) {
            throw "Materialized execution-node release contains an unsigned extra file: $relativePath"
        }
    }
}
function Assert-McpWindowsExecutionNodeRelease {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [string]$ExpectedReleaseId,
        [string]$ExpectedCommit,
        [switch]$AllowUnsignedDevelopment,
        [switch]$RuntimeSmoke
    )

    $release = [System.IO.Path]::GetFullPath($ReleaseRoot)
    Assert-McpWindowsExecutionNodeNoReparsePoints -Root $release

    $releaseManifest = Assert-McpPublicReleaseFiles -ReleaseRoot $release
    $releaseAttestation = Assert-McpPublicReleaseAttestation `
        -ReleaseRoot $release `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

    $releaseId = [string]$releaseManifest.releaseId
    $commit = [string]$releaseManifest.commit
    if ($releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw 'Execution-node release contains an invalid releaseId.'
    }
    if ($commit -notmatch '^[a-f0-9]{40}$') {
        throw 'Execution-node release contains an invalid commit.'
    }
    if ($ExpectedReleaseId -and $releaseId -ne $ExpectedReleaseId) {
        throw 'Execution-node releaseId does not match the expected release.'
    }
    if ($ExpectedCommit -and $commit -ne $ExpectedCommit) {
        throw 'Execution-node commit does not match the expected commit.'
    }
    if ([string]$releaseAttestation.releaseId -ne $releaseId -or
        [string]$releaseAttestation.commit -ne $commit) {
        throw 'Execution-node release attestation identity mismatch.'
    }

    $executionManifestPath = Join-Path $release 'execution-node-manifest.json'
    $executionManifest = Read-McpPublicJson -Path $executionManifestPath
    $executionVersion = [int]$executionManifest.version
    if ($executionVersion -notin @(1, 2) -or
        [string]$executionManifest.releaseId -ne $releaseId -or
        [string]$executionManifest.commit -ne $commit -or
        [string]$executionManifest.platform -ne 'win32-x64' -or
        [string]$executionManifest.runtimeMode -ne 'bundled-node' -or
        [string]$executionManifest.integrityRoot -ne 'signed-distribution-manifest') {
        throw 'Execution-node manifest identity, platform or integrity root is invalid.'
    }

    $executionIdentity = $releaseManifest.executionNode
    if ($null -eq $executionIdentity -or
        [int]$executionIdentity.schemaVersion -ne $executionVersion -or
        [string]$executionIdentity.manifestPath -ne 'execution-node-manifest.json') {
        throw 'Release manifest is missing or mismatches execution-node identity.'
    }
    $expectedExecutionHash = ([string]$executionIdentity.manifestSha256).ToLowerInvariant()
    $actualExecutionHash = (Get-FileHash -LiteralPath $executionManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expectedExecutionHash -notmatch '^[a-f0-9]{64}$' -or $actualExecutionHash -ne $expectedExecutionHash) {
        throw 'Execution-node manifest hash is not bound to the release manifest.'
    }

    function Assert-McpExecutionArtifactIntegrity {
        param([Parameter(Mandatory = $true)][object]$Record)
        $artifactPath = Resolve-McpPublicChildPath -Root $release -RelativePath ([string]$Record.path)
        if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
            throw "Execution-node artifact is missing: $($Record.path)"
        }
        $item = Get-Item -LiteralPath $artifactPath
        if ([long]$Record.sizeBytes -ne [long]$item.Length) {
            throw "Execution-node artifact size mismatch: $($Record.path)"
        }
        $actualHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $expectedHash = ([string]$Record.sha256).ToLowerInvariant()
        if ($expectedHash -notmatch '^[a-f0-9]{64}$' -or $actualHash -ne $expectedHash) {
            throw "Execution-node artifact hash mismatch: $($Record.path)"
        }
        if ($Record.authenticodeRequired -eq $true) {
            Assert-McpWindowsExecutionNodeSignature `
                -Path $artifactPath `
                -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
        }
        return $artifactPath
    }

    $artifacts = @($executionManifest.artifacts)
    $nodeRecord = $null
    if ($executionVersion -eq 2) {
        $services = @($executionManifest.services)
        $requiredServices = @('edge-runtime', 'browser-worker')
        foreach ($serviceId in $requiredServices) {
            $records = @($services | Where-Object { [string]$_.id -eq $serviceId })
            if ($records.Count -ne 1) {
                throw "Execution-node service is missing or duplicated: $serviceId"
            }
        }
        if ($services.Count -ne $requiredServices.Count) {
            throw 'Execution-node manifest contains an unsupported logical service.'
        }

        $seenArtifactIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($record in $artifacts) {
            $artifactId = [string]$record.id
            $owner = [string]$record.owner
            if ($artifactId -notmatch '^[a-z][a-z0-9-]{0,63}$' -or -not $seenArtifactIds.Add($artifactId)) {
                throw "Execution-node artifact id is invalid or duplicated: $artifactId"
            }
            if ($owner -notin @('edge-runtime', 'browser-worker', 'shared')) {
                throw "Execution-node artifact owner is invalid: $owner"
            }
            Assert-McpExecutionArtifactIntegrity -Record $record | Out-Null
        }

        foreach ($service in $services) {
            $serviceId = [string]$service.id
            $entryId = [string]$service.entryArtifactId
            $entry = @($artifacts | Where-Object { [string]$_.id -eq $entryId })
            if ($entry.Count -ne 1) {
                throw "Execution-node service entry artifact is missing: $serviceId/$entryId"
            }
            if ([string]$entry[0].owner -ne $serviceId) {
                throw "Execution-node service entry artifact must be owned by $serviceId"
            }
            if ($entry[0].authenticodeRequired -ne $true) {
                throw "Execution-node service entry artifact must require Authenticode: $serviceId"
            }
        }

        $requiredArtifacts = @{
            'edge-host' = @('edge-runtime', 'native/McpEdgeHost.exe', $true)
            'edge-connector' = @('edge-runtime', 'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js', $false)
            'edge-validation-launcher' = @('edge-runtime', 'deploy/windows/Start-McpEdgeConnector.ps1', $true)
            'browser-worker-server' = @('browser-worker', 'services/browser-worker/dist/server.js', $false)
            'browser-native-launcher' = @('browser-worker', 'compat/McpNodeHostLauncher.exe', $true)
            'browser-credential-broker' = @('browser-worker', 'compat/McpCredentialBroker.exe', $true)
            'node-runtime' = @('shared', 'runtime/node/node.exe', $false)
        }
        foreach ($artifactId in $requiredArtifacts.Keys) {
            $record = @($artifacts | Where-Object { [string]$_.id -eq $artifactId })
            if ($record.Count -ne 1) {
                throw "Execution-node required artifact is missing or duplicated: $artifactId"
            }
            $expected = $requiredArtifacts[$artifactId]
            if ([string]$record[0].owner -ne [string]$expected[0] -or
                [string]$record[0].path -ne [string]$expected[1] -or
                [bool]$record[0].authenticodeRequired -ne [bool]$expected[2]) {
                throw "Execution-node required artifact contract mismatch: $artifactId"
            }
        }
        $nodeRecord = @($artifacts | Where-Object { [string]$_.id -eq 'node-runtime' })[0]
    }
    else {
        $legacyRoles = @(
            'mcp-host',
            'workspace-agent',
            'browser-worker',
            'edge-connector',
            'edge-connector-launcher',
            'edge-host',
            'edge-native-launcher',
            'node-runtime'
        )
        if ($artifacts.Count -ne $legacyRoles.Count) {
            throw 'Historical execution-node manifest must contain exactly the eight-role split-owner contract.'
        }
        foreach ($role in $legacyRoles) {
            $records = @($artifacts | Where-Object { [string]$_.role -eq $role })
            if ($records.Count -ne 1) {
                throw "Historical execution-node manifest role is missing or duplicated: $role"
            }
            Assert-McpExecutionArtifactIntegrity -Record $records[0] | Out-Null
        }
        $hostRecord = @($artifacts | Where-Object { [string]$_.role -eq 'mcp-host' })[0]
        if ($hostRecord.authenticodeRequired -ne $true) {
            throw 'Historical McpHost must require Authenticode validation.'
        }
        $edgeConnectorRecord = @($artifacts | Where-Object { [string]$_.role -eq 'edge-connector' })[0]
        $edgeHostRecord = @($artifacts | Where-Object { [string]$_.role -eq 'edge-host' })[0]
        $edgeLauncherRecord = @($artifacts | Where-Object { [string]$_.role -eq 'edge-native-launcher' })[0]
        if ([string]$edgeConnectorRecord.path -ne 'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js' -or
            [string]$edgeHostRecord.path -ne 'native/McpEdgeHost.exe' -or
            [string]$edgeLauncherRecord.path -ne 'compat/McpNodeHostLauncher.exe') {
            throw 'Historical execution-node artifact paths are invalid.'
        }
        $nodeRecord = @($artifacts | Where-Object { [string]$_.role -eq 'node-runtime' })[0]

        if ($RuntimeSmoke) {
            $hostPath = Resolve-McpPublicChildPath -Root $release -RelativePath ([string]$hostRecord.path)
            $hostVersion = @(& $hostPath --version)
            if ($LASTEXITCODE -ne 0 -or $hostVersion.Count -ne 1 -or [string]$hostVersion[0] -ne 'mcp-host-contract-v3') {
                throw 'Historical signed McpHost failed its version smoke check.'
            }
        }
    }

    if ($RuntimeSmoke) {
        $nodePath = Resolve-McpPublicChildPath -Root $release -RelativePath ([string]$nodeRecord.path)
        $nodeVersion = @(& $nodePath --version)
        if ($LASTEXITCODE -ne 0 -or $nodeVersion.Count -ne 1 -or [string]$nodeVersion[0] -ne [string]$releaseManifest.nodeVersion) {
            throw 'Bundled Node.js runtime does not match the immutable release manifest.'
        }
    }
    return [pscustomobject]@{
        releaseId = $releaseId
        commit = $commit
        executionManifestSha256 = $actualExecutionHash
        releaseManifest = $releaseManifest
        executionManifest = $executionManifest
    }
}

function Get-McpWindowsExecutionNodeStatePath {
    param([Parameter(Mandatory = $true)][string]$InstallationRoot)

    $resolvedRoot = [IO.Path]::GetFullPath($InstallationRoot)
    return Join-Path $resolvedRoot 'state\lifecycle-state.v1.json'
}
function Assert-McpWindowsExecutionNodePointer {
    param(
        [AllowNull()][object]$Pointer,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Pointer) {
        return
    }
    if ([string]$Pointer.releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw "Execution-node state contains an invalid $Name releaseId."
    }
    if ([string]$Pointer.manifestSha256 -notmatch '^[a-f0-9]{64}$') {
        throw "Execution-node state contains an invalid $Name manifest hash."
    }
    try {
        $null = [DateTimeOffset]$Pointer.materializedAt
    }
    catch {
        throw "Execution-node state contains an invalid $Name materializedAt timestamp."
    }
}

function Enter-McpWindowsExecutionNodeOperationMutex {
    param(
        [Parameter(Mandatory = $true)][string]$InstallationRoot,
        [ValidateRange(0, 60000)][int]$TimeoutMs = 0
    )

    $resolvedRoot = [IO.Path]::GetFullPath($InstallationRoot).TrimEnd('\', '/').ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($resolvedRoot)
        $hashBytes = $sha.ComputeHash($bytes)
        $hash = ([Convert]::ToHexString($hashBytes)).ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
    $name = 'Local\McpAccessStack.ExecutionNode.' + $hash.Substring(0, 32)
    $mutex = [Threading.Mutex]::new($false, $name)
    $acquired = $false
    try {
        try {
            $acquired = $mutex.WaitOne($TimeoutMs)
        }
        catch [Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if (-not $acquired) {
            throw 'Another execution-node lifecycle operation is already active.'
        }
        return $mutex
    }
    catch {
        if (-not $acquired) {
            $mutex.Dispose()
        }
        throw
    }
}

function Exit-McpWindowsExecutionNodeOperationMutex {
    param([AllowNull()][Threading.Mutex]$Mutex)

    if ($null -eq $Mutex) {
        return
    }
    try {
        $Mutex.ReleaseMutex()
    }
    finally {
        $Mutex.Dispose()
    }
}

function Read-McpWindowsExecutionNodeState {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($null -eq $state -or [int]$state.version -ne 1) {
        throw 'Unsupported execution-node state version.'
    }
    Assert-McpWindowsExecutionNodePointer -Pointer $state.active -Name 'active'
    Assert-McpWindowsExecutionNodePointer -Pointer $state.candidate -Name 'candidate'
    Assert-McpWindowsExecutionNodePointer -Pointer $state.previous -Name 'previous'

    if ($null -ne $state.active -and $null -ne $state.candidate -and
        [string]$state.active.releaseId -eq [string]$state.candidate.releaseId) {
        throw 'Execution-node state candidate must differ from active.'
    }
    if ($null -ne $state.active -and $null -ne $state.previous -and
        [string]$state.active.releaseId -eq [string]$state.previous.releaseId) {
        throw 'Execution-node state previous must differ from active.'
    }
    try {
        $null = [DateTimeOffset]$state.updatedAt
    }
    catch {
        throw 'Execution-node state contains an invalid updatedAt timestamp.'
    }
    return $state
}

function Write-McpWindowsExecutionNodeState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $directory = Split-Path -Parent $resolvedPath
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporaryPath = "$resolvedPath.tmp.$([guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText(
            $temporaryPath,
            (($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
        [IO.File]::Move($temporaryPath, $resolvedPath, $true)
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
}
