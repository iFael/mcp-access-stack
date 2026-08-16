[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$ReleaseId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{40}$')]
    [string]$SourceCommit,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^v[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$ReleaseTag,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+$')]
    [string]$GatewayRepository,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^sha256:[a-f0-9]{64}$')]
    [string]$GatewayDigest,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+$')]
    [string]$ProxyRepository,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^sha256:[a-f0-9]{64}$')]
    [string]$ProxyDigest,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [Parameter(Mandatory = $true)]
    [string]$ExecutionNodeNativeDirectory,

    [ValidateRange(0, 9223372036854775807)]
    [long]$BuildRunId = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$executionNodeNative = [System.IO.Path]::GetFullPath($ExecutionNodeNativeDirectory)
$publicCommonPath = Join-Path $root 'deploy\windows\PublicDistribution.Common.ps1'
. $publicCommonPath
$publicSignerCertificatePath = Join-Path $root 'deploy\windows\mcp-access-stack-code-signing.cer'
Assert-McpPublicCertificateThumbprint `
    -Path $publicSignerCertificatePath `
    -ExpectedThumbprint $script:McpPublicCodeSigningThumbprint | Out-Null
$stage = Join-Path $output 'stage'
$releaseSource = Join-Path $root "releases\$ReleaseId"
if (-not (Test-Path -LiteralPath $releaseSource -PathType Container)) {
    throw "Immutable release was not found: $ReleaseId"
}
if ([string]::IsNullOrWhiteSpace([string]$env:WINDOWS_SIGNING_PFX_BASE64) -or
    [string]::IsNullOrWhiteSpace([string]$env:WINDOWS_SIGNING_PFX_PASSWORD)) {
    throw 'Public distribution requires WINDOWS_SIGNING_PFX_BASE64 and WINDOWS_SIGNING_PFX_PASSWORD.'
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )
    $directory = Split-Path -Parent $Path
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    [IO.File]::WriteAllText(
        [IO.Path]::GetFullPath($Path),
        $Content,
        [Text.UTF8Encoding]::new($false)
    )
}

function Copy-RelativeFile {
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    $source = Join-Path $root $RelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required public runtime file is missing: $RelativePath"
    }
    $target = Join-Path $stage $RelativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
}

function New-DataScript {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $json = $Value | ConvertTo-Json -Depth 16 -Compress
    $base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $script = @(
        '$json = [Text.Encoding]::UTF8.GetString(',
        "    [Convert]::FromBase64String('$base64')",
        ')',
        '$json | ConvertFrom-Json'
    ) -join [Environment]::NewLine
    Write-Utf8NoBom -Path $Path -Content ($script + [Environment]::NewLine)
}

function Sign-Script {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Certificate
    )
    Set-AuthenticodeSignature `
        -LiteralPath $Path `
        -Certificate $Certificate `
        -HashAlgorithm SHA256 `
        -TimestampServer 'http://timestamp.digicert.com' | Out-Null
    $observed = Get-AuthenticodeSignature -LiteralPath $Path
    if (-not $observed.SignerCertificate) {
        throw "Authenticode signing produced no signer certificate: $Path"
    }
    $actualThumbprint = Normalize-McpPublicThumbprint -Value $observed.SignerCertificate.Thumbprint
    $expectedThumbprint = Normalize-McpPublicThumbprint -Value $script:McpPublicCodeSigningThumbprint
    if ($actualThumbprint -ne $expectedThumbprint) {
        throw "Authenticode signing used an unexpected certificate: $Path"
    }
    if ($observed.Status -notin @('Valid', 'NotTrusted', 'UnknownError')) {
        throw "Authenticode signing failed: $Path (Status=$($observed.Status))"
    }
}

if (Test-Path -LiteralPath $output) {
    Remove-Item -LiteralPath $output -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$runtimeFiles = @(
    'package.json',
    'config\workspace-policy.example.json',
    'deploy\docker\compose.production.yml',
    'deploy\docker\scripts\Activate-McpCandidateRelease.ps1',
    'deploy\docker\scripts\Common.ps1',
    'deploy\docker\scripts\Get-DockerProductionStatus.ps1',
    'deploy\docker\scripts\Initialize-DockerProduction.ps1',
    'deploy\docker\scripts\Install-McpHostTasks.ps1',
    'deploy\docker\scripts\Install-McpProductionPromotionTask.ps1',
    'deploy\docker\scripts\Invoke-McpProductionPromotionTask.ps1',
    'deploy\docker\scripts\NodeRuntime.Common.ps1',
    'deploy\docker\scripts\ProductionLifecycle.Common.ps1',
    'deploy\docker\scripts\Promote-McpProduction.ps1',
    'deploy\docker\scripts\Request-McpProductionPromotion.ps1',
    'deploy\docker\scripts\Run-McpProductionPromotionDetached.ps1',
    'deploy\docker\scripts\Update-McpNodeRuntime.ps1',
    'deploy\windows\Install-McpAccessStack.ps1',
    'deploy\windows\Manage-McpCredential.ps1',
    'deploy\windows\PublicDistribution.Common.ps1',
    'deploy\windows\WindowsExecutionNode.Common.ps1',
    'deploy\windows\Stage-McpWindowsExecutionNodeCandidate.ps1',
    'deploy\windows\mcp-access-stack-code-signing.cer',
    'deploy\windows\Update-McpAccessStack.ps1',
    'operations\runtime\Initialize-GptOnlyProduction.ps1',
    'operations\validation\Initialize-ValidationTools.ps1'
)
foreach ($relative in $runtimeFiles) {
    Copy-RelativeFile -RelativePath $relative
}

$releaseTargetParent = Join-Path $stage 'releases'
New-Item -ItemType Directory -Force -Path $releaseTargetParent | Out-Null
Copy-Item -LiteralPath $releaseSource -Destination $releaseTargetParent -Recurse
$releaseTarget = Join-Path $releaseTargetParent $ReleaseId
$releaseManifestPath = Join-Path $releaseTarget 'manifest.json'
$releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw | ConvertFrom-Json
if ([string]$releaseManifest.releaseId -ne $ReleaseId -or
    [string]$releaseManifest.commit -ne $SourceCommit -or
    $releaseManifest.testsPassed -ne $true -or
    $releaseManifest.dirty -eq $true) {
    throw 'Immutable release identity or validation evidence does not match the requested public distribution.'
}

$expectedNativeArtifacts = @(
    'McpHost.exe',
    'McpNodeHostLauncher.exe',
    'McpCredentialBroker.exe'
)
foreach ($name in $expectedNativeArtifacts) {
    $source = Join-Path $executionNodeNative $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Prebuilt Windows execution-node artifact is missing: $name"
    }
}

$nativeTarget = Join-Path $releaseTarget 'native'
$compatTarget = Join-Path $releaseTarget 'compat'
New-Item -ItemType Directory -Force -Path $nativeTarget, $compatTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $executionNodeNative 'McpHost.exe') -Destination (Join-Path $nativeTarget 'McpHost.exe')
Copy-Item -LiteralPath (Join-Path $executionNodeNative 'McpNodeHostLauncher.exe') -Destination (Join-Path $compatTarget 'McpNodeHostLauncher.exe')
Copy-Item -LiteralPath (Join-Path $executionNodeNative 'McpCredentialBroker.exe') -Destination (Join-Path $compatTarget 'McpCredentialBroker.exe')

$nodeVersion = [string]$releaseManifest.nodeVersion
if ($nodeVersion -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
    throw 'Immutable release contains an invalid Node.js version.'
}
$nodeRuntimeSource = Join-Path $root ".runtime-tools\mcp-node-runtime\$nodeVersion"
$nodeExecutableSource = Join-Path $nodeRuntimeSource 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExecutableSource -PathType Leaf)) {
    throw "Managed Node.js runtime required by the release is missing: $nodeVersion"
}
$runtimeTargetParent = Join-Path $releaseTarget 'runtime'
$nodeRuntimeTarget = Join-Path $runtimeTargetParent 'node'
New-Item -ItemType Directory -Force -Path $runtimeTargetParent | Out-Null
Copy-Item -LiteralPath $nodeRuntimeSource -Destination $nodeRuntimeTarget -Recurse

$dockerImages = @(
    [ordered]@{
        component = 'gateway'
        repository = $GatewayRepository
        digest = $GatewayDigest
        platform = 'linux/amd64'
    },
    [ordered]@{
        component = 'proxy'
        repository = $ProxyRepository
        digest = $ProxyDigest
        platform = 'linux/amd64'
    }
)
$releaseManifest.dockerImages = $dockerImages
if ($BuildRunId -gt 0) {
    $publicBuild = [ordered]@{
        provider = 'github-actions'
        workflowName = 'Public release'
        runId = $BuildRunId
        commit = $SourceCommit
        assembledAt = [DateTimeOffset]::UtcNow.ToString('O')
    }
    if ($releaseManifest.PSObject.Properties['publicBuild']) {
        $releaseManifest.publicBuild = $publicBuild
    }
    else {
        $releaseManifest | Add-Member -NotePropertyName publicBuild -NotePropertyValue $publicBuild
    }
}
$releaseManifest | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $releaseManifestPath -Encoding UTF8

$pfxPath = Join-Path $output 'signing.pfx'
[IO.File]::WriteAllBytes(
    $pfxPath,
    [Convert]::FromBase64String([string]$env:WINDOWS_SIGNING_PFX_BASE64)
)
$password = ConvertTo-SecureString ([string]$env:WINDOWS_SIGNING_PFX_PASSWORD) -AsPlainText -Force
$certificate = Import-PfxCertificate `
    -FilePath $pfxPath `
    -CertStoreLocation Cert:\CurrentUser\My `
    -Password $password
try {
    if (-not $certificate.HasPrivateKey) {
        throw 'The configured code-signing certificate does not contain a private key.'
    }
    $certificateThumbprint = Normalize-McpPublicThumbprint -Value $certificate.Thumbprint
    $expectedSignerThumbprint = Normalize-McpPublicThumbprint -Value $script:McpPublicCodeSigningThumbprint
    if ($certificateThumbprint -ne $expectedSignerThumbprint) {
        throw 'The configured PFX is not the pinned MCP Access Stack code-signing certificate.'
    }

    foreach ($script in @(
        Get-ChildItem -LiteralPath $stage -Recurse -File -Filter '*.ps1' |
            Where-Object {
                -not $_.FullName.StartsWith(
                    $nodeRuntimeTarget,
                    [StringComparison]::OrdinalIgnoreCase
                )
            } |
            Sort-Object FullName
    )) {
        Sign-Script -Path $script.FullName -Certificate $certificate
    }

    $hostExecutablePath = Join-Path $releaseTarget 'native\McpHost.exe'
    $compatLauncherPath = Join-Path $releaseTarget 'compat\McpNodeHostLauncher.exe'
    $compatBrokerPath = Join-Path $releaseTarget 'compat\McpCredentialBroker.exe'
    foreach ($nativeExecutable in @($hostExecutablePath, $compatLauncherPath, $compatBrokerPath)) {
        Sign-Script -Path $nativeExecutable -Certificate $certificate
    }

    function New-ExecutionNodeArtifactRecord {
        param(
            [Parameter(Mandatory = $true)][string]$Role,
            [Parameter(Mandatory = $true)][string]$RelativePath,
            [Parameter(Mandatory = $true)][bool]$AuthenticodeRequired
        )
        $absolutePath = Join-Path $releaseTarget ($RelativePath.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
            throw "Execution-node artifact is missing: $RelativePath"
        }
        if ($AuthenticodeRequired) {
            $signature = Get-AuthenticodeSignature -LiteralPath $absolutePath
            if (-not $signature.SignerCertificate) {
                throw "Execution-node artifact is unsigned: $RelativePath"
            }
            $actualThumbprint = Normalize-McpPublicThumbprint -Value $signature.SignerCertificate.Thumbprint
            $expectedThumbprint = Normalize-McpPublicThumbprint -Value $script:McpPublicCodeSigningThumbprint
            if ($actualThumbprint -ne $expectedThumbprint) {
                throw "Execution-node artifact signer mismatch: $RelativePath"
            }
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

    $executionNodeManifest = [ordered]@{
        version = 1
        releaseId = $ReleaseId
        commit = $SourceCommit
        platform = 'win32-x64'
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        runtimeMode = 'bundled-node'
        integrityRoot = 'signed-distribution-manifest'
        artifacts = @(
            (New-ExecutionNodeArtifactRecord -Role 'mcp-host' -RelativePath 'native/McpHost.exe' -AuthenticodeRequired $true),
            (New-ExecutionNodeArtifactRecord -Role 'workspace-agent' -RelativePath 'services/workspace-agent/dist/cli.js' -AuthenticodeRequired $false),
            (New-ExecutionNodeArtifactRecord -Role 'browser-worker' -RelativePath 'services/browser-worker/dist/server.js' -AuthenticodeRequired $false),
            (New-ExecutionNodeArtifactRecord -Role 'node-runtime' -RelativePath 'runtime/node/node.exe' -AuthenticodeRequired $false)
        )
    }
    $executionNodeManifestPath = Join-Path $releaseTarget 'execution-node-manifest.json'
    Write-Utf8NoBom `
        -Path $executionNodeManifestPath `
        -Content (($executionNodeManifest | ConvertTo-Json -Depth 16) + [Environment]::NewLine)
    $executionNodeIdentity = [ordered]@{
        schemaVersion = 1
        manifestPath = 'execution-node-manifest.json'
        manifestSha256 = (Get-FileHash -LiteralPath $executionNodeManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    if ($releaseManifest.PSObject.Properties['executionNode']) {
        $releaseManifest.executionNode = $executionNodeIdentity
    }
    else {
        $releaseManifest | Add-Member -NotePropertyName executionNode -NotePropertyValue $executionNodeIdentity
    }

    $releaseFiles = @(
        Get-ChildItem -LiteralPath $releaseTarget -Recurse -File |
            Where-Object {
                $_.FullName -notmatch '[\\/]node_modules[\\/]' -and
                $_.Name -ne 'manifest.json' -and
                $_.Name -ne 'release-attestation.ps1'
            } |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    path = $_.FullName.Substring($releaseTarget.Length).TrimStart('\', '/').Replace('\', '/')
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
    )
    $releaseManifest.fileHashes = $releaseFiles
    Write-Utf8NoBom `
        -Path $releaseManifestPath `
        -Content (($releaseManifest | ConvertTo-Json -Depth 32) + [Environment]::NewLine)

    $releaseAttestation = [ordered]@{
        schemaVersion = 1
        releaseId = $ReleaseId
        commit = $SourceCommit
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        manifestSha256 = (Get-FileHash -LiteralPath $releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        dockerImages = $dockerImages
    }
    $releaseAttestationPath = Join-Path $releaseTarget 'release-attestation.ps1'
    New-DataScript -Value $releaseAttestation -Path $releaseAttestationPath
    Sign-Script -Path $releaseAttestationPath -Certificate $certificate

    $distributionFiles = @(
        Get-ChildItem -LiteralPath $stage -Recurse -File |
            Where-Object { $_.Name -ne 'distribution-manifest.ps1' } |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    path = $_.FullName.Substring($stage.Length).TrimStart('\', '/').Replace('\', '/')
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
    )
    $distributionManifest = [ordered]@{
        schemaVersion = 1
        platform = 'windows-x64'
        releaseId = $ReleaseId
        version = $ReleaseId
        commit = $SourceCommit
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        dockerImages = $dockerImages
        files = $distributionFiles
    }
    $distributionManifestPath = Join-Path $stage 'distribution-manifest.ps1'
    New-DataScript -Value $distributionManifest -Path $distributionManifestPath
    Sign-Script -Path $distributionManifestPath -Certificate $certificate
}
finally {
    if ($certificate) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
}

$assetPath = Join-Path $output "$ReleaseTag-windows-x64.zip"
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $assetPath -CompressionLevel Optimal
$assetHash = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant()
$hashPath = "$assetPath.sha256"
Write-Utf8NoBom `
    -Path $hashPath `
    -Content ("$assetHash *$([IO.Path]::GetFileName($assetPath))$([Environment]::NewLine)")

[pscustomobject]@{
    status = 'created'
    releaseId = $ReleaseId
    commit = $SourceCommit
    asset = $assetPath
    assetSha256 = $assetHash
    hashAsset = $hashPath
    stageFileCount = @(Get-ChildItem -LiteralPath $stage -Recurse -File).Count
    stageBytes = [long]((Get-ChildItem -LiteralPath $stage -Recurse -File | Measure-Object Length -Sum).Sum)
} | ConvertTo-Json -Compress
