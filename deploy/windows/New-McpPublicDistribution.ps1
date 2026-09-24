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
    'config\windows-companion-policy.example.json',
    'deploy\windows\Install-McpAccessStack.ps1',
    'deploy\windows\Install-McpWindowsAdminCompanion.ps1',
    'deploy\windows\Start-McpAccessStackCutover.ps1',
    'deploy\windows\Invoke-McpAccessStackCutoverBroker.ps1',
    'deploy\windows\PublicDistribution.Common.ps1',
    'deploy\windows\WindowsExecutionNode.Common.ps1',
    'deploy\windows\Stage-McpWindowsExecutionNodeCandidate.ps1',
    'deploy\windows\Install-McpEdgeConnectorTask.ps1',
    'deploy\windows\Repair-McpEdgeConnectorTask.ps1',
    'deploy\windows\Invoke-McpEdgeOwnerOAuthBootstrap.ps1',
    'deploy\windows\Install-McpBrowserWorkerTask.ps1',
    'deploy\windows\Start-McpEdgeConnector.ps1',
    'deploy\windows\Test-McpEdgeConnectorTerminalIndependence.ps1',
    'deploy\windows\Invoke-McpWindowsExecutionNodeCutover.ps1',
    'deploy\windows\mcp-access-stack-code-signing.cer',
    'deploy\windows\Update-McpAccessStack.ps1',
    'operations\validation\Initialize-ValidationTools.ps1'

)
foreach ($relative in $runtimeFiles) {
    Copy-RelativeFile -RelativePath $relative
}

$releaseTargetParent = Join-Path $stage 'releases'
New-Item -ItemType Directory -Force -Path $releaseTargetParent | Out-Null
Copy-Item -LiteralPath $releaseSource -Destination $releaseTargetParent -Recurse
$releaseTarget = Join-Path $releaseTargetParent $ReleaseId
$edgeLauncherSource = Join-Path $stage 'deploy\windows\Start-McpEdgeConnector.ps1'
$edgeLauncherTarget = Join-Path $releaseTarget 'deploy\windows\Start-McpEdgeConnector.ps1'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $edgeLauncherTarget) | Out-Null
Copy-Item -LiteralPath $edgeLauncherSource -Destination $edgeLauncherTarget
$edgeOwnerOAuthBootstrapSource = Join-Path $stage 'deploy\windows\Invoke-McpEdgeOwnerOAuthBootstrap.ps1'
$edgeOwnerOAuthBootstrapTarget = Join-Path $releaseTarget 'deploy\windows\Invoke-McpEdgeOwnerOAuthBootstrap.ps1'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $edgeOwnerOAuthBootstrapTarget) | Out-Null
Copy-Item -LiteralPath $edgeOwnerOAuthBootstrapSource -Destination $edgeOwnerOAuthBootstrapTarget
$edgeRecoveryReleaseFiles = @(
    'Repair-McpEdgeConnectorTask.ps1',
    'Update-McpAccessStack.ps1',
    'Start-McpAccessStackCutover.ps1',
    'Invoke-McpAccessStackCutoverBroker.ps1',
    'Invoke-McpWindowsExecutionNodeCutover.ps1',
    'Install-McpBrowserWorkerTask.ps1',
    'Install-McpEdgeConnectorTask.ps1',
    'PublicDistribution.Common.ps1',
    'WindowsExecutionNode.Common.ps1'
)
foreach ($name in $edgeRecoveryReleaseFiles) {
    $source = Join-Path $stage ("deploy\windows\$name")
    $target = Join-Path $releaseTarget ("deploy\windows\$name")
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
}
$releaseManifestPath = Join-Path $releaseTarget 'manifest.json'
$releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw | ConvertFrom-Json
if ([string]$releaseManifest.releaseId -ne $ReleaseId -or
    [string]$releaseManifest.commit -ne $SourceCommit -or
    $releaseManifest.testsPassed -ne $true -or
    $releaseManifest.dirty -eq $true) {
    throw 'Immutable release identity or validation evidence does not match the requested public distribution.'
}

$expectedNativeArtifacts = @(
    'McpEdgeHost.exe',
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
Copy-Item -LiteralPath (Join-Path $executionNodeNative 'McpEdgeHost.exe') -Destination (Join-Path $nativeTarget 'McpEdgeHost.exe')
Copy-Item -LiteralPath (Join-Path $executionNodeNative 'McpNodeHostLauncher.exe') -Destination (Join-Path $compatTarget 'McpNodeHostLauncher.exe')
Copy-Item -LiteralPath (Join-Path $executionNodeNative 'McpCredentialBroker.exe') -Destination (Join-Path $compatTarget 'McpCredentialBroker.exe')

$nodeVersion = [string]$releaseManifest.nodeVersion
if ($nodeVersion -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
    throw 'Immutable release contains an invalid Node.js version.'
}
$nodeRuntimeTarget = Join-Path $releaseTarget 'runtime\node'
$nodeExecutableTarget = Join-Path $nodeRuntimeTarget 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExecutableTarget -PathType Leaf)) {
    throw "Immutable release is missing bundled Node.js runtime: $nodeVersion"
}
$observedNodeVersion = @(& $nodeExecutableTarget --version)
if ($LASTEXITCODE -ne 0 -or $observedNodeVersion.Count -ne 1 -or [string]$observedNodeVersion[0] -ne $nodeVersion) {
    throw 'Bundled Node.js runtime does not match immutable release metadata.'
}

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

    $edgeHostExecutablePath = Join-Path $releaseTarget 'native\McpEdgeHost.exe'
    $compatLauncherPath = Join-Path $releaseTarget 'compat\McpNodeHostLauncher.exe'
    $compatBrokerPath = Join-Path $releaseTarget 'compat\McpCredentialBroker.exe'
    foreach ($nativeExecutable in @($edgeHostExecutablePath, $compatLauncherPath, $compatBrokerPath)) {
        Sign-Script -Path $nativeExecutable -Certificate $certificate
    }

    function New-ExecutionNodeArtifactRecord {
        param(
            [Parameter(Mandatory = $true)][string]$Id,
            [Parameter(Mandatory = $true)][ValidateSet('edge-runtime', 'browser-worker', 'shared')][string]$Owner,
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
            id = $Id
            owner = $Owner
            path = $RelativePath
            sha256 = (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash.ToLowerInvariant()
            sizeBytes = [long]$item.Length
            authenticodeRequired = $AuthenticodeRequired
        }
    }

    $executionNodeManifest = [ordered]@{
        version = 2
        releaseId = $ReleaseId
        commit = $SourceCommit
        platform = 'win32-x64'
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        runtimeMode = 'bundled-node'
        integrityRoot = 'signed-distribution-manifest'
        services = @(
            [ordered]@{ id = 'edge-runtime'; entryArtifactId = 'edge-host' },
            [ordered]@{ id = 'browser-worker'; entryArtifactId = 'browser-native-launcher' }
        )
        artifacts = @(
            (New-ExecutionNodeArtifactRecord -Id 'edge-host' -Owner 'edge-runtime' -RelativePath 'native/McpEdgeHost.exe' -AuthenticodeRequired $true),
            (New-ExecutionNodeArtifactRecord -Id 'edge-connector' -Owner 'edge-runtime' -RelativePath 'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js' -AuthenticodeRequired $false),
            (New-ExecutionNodeArtifactRecord -Id 'edge-validation-launcher' -Owner 'edge-runtime' -RelativePath 'deploy/windows/Start-McpEdgeConnector.ps1' -AuthenticodeRequired $true),
            (New-ExecutionNodeArtifactRecord -Id 'browser-worker-server' -Owner 'browser-worker' -RelativePath 'services/browser-worker/dist/server.js' -AuthenticodeRequired $false),
            (New-ExecutionNodeArtifactRecord -Id 'browser-native-launcher' -Owner 'browser-worker' -RelativePath 'compat/McpNodeHostLauncher.exe' -AuthenticodeRequired $true),
            (New-ExecutionNodeArtifactRecord -Id 'browser-credential-broker' -Owner 'browser-worker' -RelativePath 'compat/McpCredentialBroker.exe' -AuthenticodeRequired $true),
            (New-ExecutionNodeArtifactRecord -Id 'node-runtime' -Owner 'shared' -RelativePath 'runtime/node/node.exe' -AuthenticodeRequired $false)
        )
    }
    $executionNodeManifestPath = Join-Path $releaseTarget 'execution-node-manifest.json'
    Write-Utf8NoBom `
        -Path $executionNodeManifestPath `
        -Content (($executionNodeManifest | ConvertTo-Json -Depth 16) + [Environment]::NewLine)
    $executionNodeIdentity = [ordered]@{
        schemaVersion = 2
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
        schemaVersion = 2
        releaseId = $ReleaseId
        commit = $SourceCommit
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        manifestSha256 = (Get-FileHash -LiteralPath $releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
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
        schemaVersion = 2
        platform = 'windows-x64'
        releaseId = $ReleaseId
        version = $ReleaseId
        commit = $SourceCommit
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
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
