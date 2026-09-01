[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BaseReleaseRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$CandidateId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{40}$')]
    [string]$PatchCommit,

    [Parameter(Mandatory = $true)]
    [string]$EdgeHostExecutable,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [switch]$AllowUnsignedDevelopment,
    [switch]$SkipArchive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$baseRelease = [IO.Path]::GetFullPath($BaseReleaseRoot)
$edgeHostSource = [IO.Path]::GetFullPath($EdgeHostExecutable)
$output = [IO.Path]::GetFullPath($OutputDirectory)
$stage = Join-Path $output 'stage'
$releaseParent = Join-Path $stage 'releases'
$candidateRelease = Join-Path $releaseParent $CandidateId
$publicCommonPath = Join-Path $projectRoot 'deploy\windows\PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $projectRoot 'deploy\windows\WindowsExecutionNode.Common.ps1'
$signerCertificatePath = Join-Path $projectRoot 'deploy\windows\mcp-access-stack-code-signing.cer'

. $publicCommonPath
. $executionCommonPath

if ([string]$env:GITHUB_ACTIONS -eq 'true') {
    Set-McpPublicSignatureValidationMode -Mode 'OfflinePinned'
}

Assert-McpPublicCertificateThumbprint `
    -Path $signerCertificatePath `
    -ExpectedThumbprint $script:McpPublicCodeSigningThumbprint | Out-Null

if (-not (Test-Path -LiteralPath $baseRelease -PathType Container)) {
    throw "Official base release root was not found: $baseRelease"
}
if (-not (Test-Path -LiteralPath $edgeHostSource -PathType Leaf)) {
    throw "McpEdgeHost artifact was not found: $edgeHostSource"
}

$baseVerification = Assert-McpWindowsExecutionNodeRelease `
    -ReleaseRoot $baseRelease `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment `
    -RuntimeSmoke
$baseAttestation = Assert-McpPublicReleaseAttestation `
    -ReleaseRoot $baseRelease `
    -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
$baseManifest = Read-McpPublicJson -Path (Join-Path $baseRelease 'manifest.json')
$baseReleaseId = [string]$baseManifest.releaseId
$baseCommit = [string]$baseManifest.commit
if ($baseReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or
    $baseCommit -notmatch '^[a-f0-9]{40}$' -or
    [string]$baseAttestation.releaseId -ne $baseReleaseId -or
    [string]$baseAttestation.commit -ne $baseCommit) {
    throw 'Official base release identity is invalid.'
}
if ($CandidateId -eq $baseReleaseId) {
    throw 'CandidateId must differ from the official base releaseId.'
}
$baseDockerImages = @($baseAttestation.dockerImages)
if ($baseDockerImages.Count -ne 2) {
    throw 'Official base attestation must contain gateway and proxy image identities.'
}

if (-not $AllowUnsignedDevelopment) {
    if ([string]::IsNullOrWhiteSpace([string]$env:WINDOWS_SIGNING_PFX_BASE64) -or
        [string]::IsNullOrWhiteSpace([string]$env:WINDOWS_SIGNING_PFX_PASSWORD)) {
        throw 'Windows Edge candidate signing material is not available.'
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )
    $directory = Split-Path -Parent $Path
    if ($directory) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    [IO.File]::WriteAllText(
        [IO.Path]::GetFullPath($Path),
        $Content,
        [Text.UTF8Encoding]::new($false)
    )
}

function New-DataScript {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $json = $Value | ConvertTo-Json -Depth 24 -Compress
    $base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $script = @(
        '$json = [Text.Encoding]::UTF8.GetString(',
        "    [Convert]::FromBase64String('$base64')",
        ')',
        '$json | ConvertFrom-Json'
    ) -join [Environment]::NewLine
    Write-Utf8NoBom -Path $Path -Content ($script + [Environment]::NewLine)
}

$certificate = $null
$pfxPath = Join-Path $output 'signing.pfx'

function Sign-CandidateArtifact {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ($AllowUnsignedDevelopment) {
        return
    }
    if ($null -eq $script:certificate) {
        throw 'Candidate signing certificate is not initialized.'
    }
    Set-AuthenticodeSignature `
        -LiteralPath $Path `
        -Certificate $script:certificate `
        -HashAlgorithm SHA256 `
        -TimestampServer 'http://timestamp.digicert.com' | Out-Null
    $observed = Get-AuthenticodeSignature -LiteralPath $Path
    if (-not $observed.SignerCertificate) {
        throw "Authenticode signing produced no signer certificate: $Path"
    }
    $actualThumbprint = Normalize-McpPublicThumbprint -Value $observed.SignerCertificate.Thumbprint
    $expectedThumbprint = Normalize-McpPublicThumbprint -Value $script:McpPublicCodeSigningThumbprint
    if ($actualThumbprint -ne $expectedThumbprint) {
        throw "Candidate artifact was signed by an unexpected certificate: $Path"
    }
    if ($observed.Status -notin @('Valid', 'NotTrusted', 'UnknownError')) {
        throw "Candidate artifact signing failed: $Path (Status=$($observed.Status))"
    }
}

function New-CandidateArtifactRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][bool]$AuthenticodeRequired
    )
    $absolutePath = Join-Path $candidateRelease ($RelativePath.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
        throw "Candidate execution-node artifact is missing: $RelativePath"
    }
    if ($AuthenticodeRequired) {
        Assert-McpPublicSignature `
            -Path $absolutePath `
            -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    }
    $item = Get-Item -LiteralPath $absolutePath
    return [ordered]@{
        role = $Role
        path = $RelativePath
        sha256 = (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash.ToLowerInvariant()
        sizeBytes = [long]$item.Length
        authenticodeRequired = $AuthenticodeRequired
    }
}

try {
    if (Test-Path -LiteralPath $output) {
        Remove-Item -LiteralPath $output -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $stage, $releaseParent | Out-Null

    if (-not $AllowUnsignedDevelopment) {
        [IO.File]::WriteAllBytes(
            $pfxPath,
            [Convert]::FromBase64String([string]$env:WINDOWS_SIGNING_PFX_BASE64)
        )
        $password = ConvertTo-SecureString `
            ([string]$env:WINDOWS_SIGNING_PFX_PASSWORD) `
            -AsPlainText `
            -Force
        $script:certificate = Import-PfxCertificate `
            -FilePath $pfxPath `
            -CertStoreLocation Cert:\CurrentUser\My `
            -Password $password
        if (-not $script:certificate.HasPrivateKey) {
            throw 'The configured candidate signing certificate does not contain a private key.'
        }
        $certificateThumbprint = Normalize-McpPublicThumbprint -Value $script:certificate.Thumbprint
        $expectedThumbprint = Normalize-McpPublicThumbprint -Value $script:McpPublicCodeSigningThumbprint
        if ($certificateThumbprint -ne $expectedThumbprint) {
            throw 'The configured candidate signer is not the pinned MCP Access Stack signer.'
        }
    }

    $bundleScripts = @(
        'deploy\windows\PublicDistribution.Common.ps1',
        'deploy\windows\WindowsExecutionNode.Common.ps1',
        'deploy\windows\Install-McpEdgeConnectorTask.ps1',
        'deploy\windows\Start-McpEdgeConnector.ps1',
        'deploy\windows\Test-McpEdgeConnectorTerminalIndependence.ps1'
    )
    foreach ($relativePath in $bundleScripts) {
        $source = Join-Path $projectRoot $relativePath
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Candidate runtime script is missing from source: $relativePath"
        }
        $target = Join-Path $stage $relativePath
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
        Sign-CandidateArtifact -Path $target
    }
    $candidateCertificatePath = Join-Path $stage 'deploy\windows\mcp-access-stack-code-signing.cer'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $candidateCertificatePath) | Out-Null
    Copy-Item -LiteralPath $signerCertificatePath -Destination $candidateCertificatePath

    $robocopy = Get-Command robocopy.exe -ErrorAction Stop
    New-Item -ItemType Directory -Force -Path $candidateRelease | Out-Null
    $robocopyArguments = @(
        $baseRelease,
        $candidateRelease,
        '/E',
        '/COPY:DAT',
        '/DCOPY:DAT',
        '/R:2',
        '/W:1',
        '/NFL',
        '/NDL',
        '/NJH',
        '/NJS',
        '/NP'
    )
    & $robocopy.Source @robocopyArguments *> $null
    $robocopyExitCode = $LASTEXITCODE
    if ($robocopyExitCode -ge 8) {
        throw "Official base release materialization failed with robocopy exit code $robocopyExitCode."
    }
    if (-not (Test-Path -LiteralPath $candidateRelease -PathType Container)) {
        throw 'Base release copy did not materialize under the candidate stage.'
    }

    $releaseLauncher = Join-Path $candidateRelease 'deploy\windows\Start-McpEdgeConnector.ps1'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $releaseLauncher) | Out-Null
    Copy-Item `
        -LiteralPath (Join-Path $stage 'deploy\windows\Start-McpEdgeConnector.ps1') `
        -Destination $releaseLauncher `
        -Force

    $releaseEdgeHost = Join-Path $candidateRelease 'native\McpEdgeHost.exe'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $releaseEdgeHost) | Out-Null
    Copy-Item -LiteralPath $edgeHostSource -Destination $releaseEdgeHost -Force
    Sign-CandidateArtifact -Path $releaseEdgeHost

    $edgePatch = [ordered]@{
        schemaVersion = 1
        kind = 'edge-host-persistence'
        baseReleaseId = $baseReleaseId
        baseCommit = $baseCommit
        patchCommit = $PatchCommit
    }

    $executionManifest = [ordered]@{
        version = 1
        releaseId = $CandidateId
        commit = $baseCommit
        platform = 'win32-x64'
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        runtimeMode = 'bundled-node'
        integrityRoot = 'signed-distribution-manifest'
        edgePatch = $edgePatch
        artifacts = @(
            (New-CandidateArtifactRecord -Role 'mcp-host' -RelativePath 'native/McpHost.exe' -AuthenticodeRequired $true),
            (New-CandidateArtifactRecord -Role 'workspace-agent' -RelativePath 'services/workspace-agent/dist/cli.js' -AuthenticodeRequired $false),
            (New-CandidateArtifactRecord -Role 'browser-worker' -RelativePath 'services/browser-worker/dist/server.js' -AuthenticodeRequired $false),
            (New-CandidateArtifactRecord -Role 'edge-connector' -RelativePath 'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js' -AuthenticodeRequired $false),
            (New-CandidateArtifactRecord -Role 'edge-connector-launcher' -RelativePath 'deploy/windows/Start-McpEdgeConnector.ps1' -AuthenticodeRequired $true),
            (New-CandidateArtifactRecord -Role 'edge-host' -RelativePath 'native/McpEdgeHost.exe' -AuthenticodeRequired $true),
            (New-CandidateArtifactRecord -Role 'edge-native-launcher' -RelativePath 'compat/McpNodeHostLauncher.exe' -AuthenticodeRequired $true),
            (New-CandidateArtifactRecord -Role 'node-runtime' -RelativePath 'runtime/node/node.exe' -AuthenticodeRequired $false)
        )
    }
    $executionManifestPath = Join-Path $candidateRelease 'execution-node-manifest.json'
    Write-Utf8NoBom `
        -Path $executionManifestPath `
        -Content (($executionManifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
    $executionManifestSha256 = (Get-FileHash -LiteralPath $executionManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $candidateManifestPath = Join-Path $candidateRelease 'manifest.json'
    $candidateManifest = Read-McpPublicJson -Path $candidateManifestPath
    $candidateManifest.releaseId = $CandidateId
    $candidateManifest.commit = $baseCommit
    $candidateManifest.builtAt = [DateTimeOffset]::UtcNow.ToString('O')
    $candidateManifest.testsPassed = $true
    $candidateManifest.dirty = $false
    $candidateManifest.source = 'signed-edge-patch-over-official-release'
    if ($candidateManifest.PSObject.Properties['edgePatch']) {
        $candidateManifest.edgePatch = $edgePatch
    }
    else {
        $candidateManifest | Add-Member -NotePropertyName edgePatch -NotePropertyValue $edgePatch
    }
    $executionNodeIdentity = [ordered]@{
        schemaVersion = 1
        manifestPath = 'execution-node-manifest.json'
        manifestSha256 = $executionManifestSha256
    }
    if ($candidateManifest.PSObject.Properties['executionNode']) {
        $candidateManifest.executionNode = $executionNodeIdentity
    }
    else {
        $candidateManifest | Add-Member -NotePropertyName executionNode -NotePropertyValue $executionNodeIdentity
    }

    $candidateManifest.fileHashes = @(
        Get-ChildItem -LiteralPath $candidateRelease -Recurse -File |
            Where-Object {
                $_.FullName -notmatch '[\\/]node_modules[\\/]' -and
                $_.Name -ne 'manifest.json' -and
                $_.Name -ne 'release-attestation.ps1'
            } |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    path = $_.FullName.Substring($candidateRelease.Length).TrimStart('\', '/').Replace('\', '/')
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
    )
    Write-Utf8NoBom `
        -Path $candidateManifestPath `
        -Content (($candidateManifest | ConvertTo-Json -Depth 32) + [Environment]::NewLine)

    $candidateAttestation = [ordered]@{
        schemaVersion = 1
        releaseId = $CandidateId
        commit = $baseCommit
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        manifestSha256 = (Get-FileHash -LiteralPath $candidateManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        dockerImages = @($baseDockerImages)
        edgePatch = $edgePatch
    }
    $candidateAttestationPath = Join-Path $candidateRelease 'release-attestation.ps1'
    New-DataScript -Value $candidateAttestation -Path $candidateAttestationPath
    Sign-CandidateArtifact -Path $candidateAttestationPath

    $candidateSummary = [ordered]@{
        schemaVersion = 1
        candidateId = $CandidateId
        baseReleaseId = $baseReleaseId
        baseCommit = $baseCommit
        patchCommit = $PatchCommit
        releaseRelativePath = "releases/$CandidateId"
    }
    Write-Utf8NoBom `
        -Path (Join-Path $stage 'edge-candidate.json') `
        -Content (($candidateSummary | ConvertTo-Json -Depth 8) + [Environment]::NewLine)

    $assetPath = $null
    $assetHash = $null
    $hashPath = $null
    if (-not $SkipArchive) {
        $assetPath = Join-Path $output "$CandidateId-windows-edge-candidate.zip"
        if (Test-Path -LiteralPath $assetPath) {
            Remove-Item -LiteralPath $assetPath -Force
        }
        Compress-Archive `
            -Path (Join-Path $stage '*') `
            -DestinationPath $assetPath `
            -CompressionLevel Optimal
        $assetHash = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $hashPath = "$assetPath.sha256"
        Write-Utf8NoBom `
            -Path $hashPath `
            -Content ("$assetHash *$([IO.Path]::GetFileName($assetPath))$([Environment]::NewLine)")
    }

    [pscustomobject]@{
        status = 'created'
        candidateId = $CandidateId
        baseReleaseId = $baseReleaseId
        baseCommit = $baseCommit
        patchCommit = $PatchCommit
        candidateReleaseRoot = $candidateRelease
        executionManifestSha256 = $executionManifestSha256
        signed = -not [bool]$AllowUnsignedDevelopment
        archiveCreated = -not [bool]$SkipArchive
        asset = $assetPath
        assetSha256 = $assetHash
        hashAsset = $hashPath
    } | ConvertTo-Json -Compress
}
finally {
    if ($script:certificate) {
        Remove-Item `
            -LiteralPath "Cert:\CurrentUser\My\$($script:certificate.Thumbprint)" `
            -Force `
            -ErrorAction SilentlyContinue
        $script:certificate = $null
    }
    if (Test-Path -LiteralPath $pfxPath) {
        Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
    }
}
