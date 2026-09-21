[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
. $commonPath

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('mcp-release-contract-v2-' + [guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $tempRoot 'release'
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null

function Write-TestAttestation {
    param(
        [Parameter(Mandatory = $true)][int]$SchemaVersion,
        [switch]$IncludeDockerImages
    )

    $manifestPath = Join-Path $releaseRoot 'manifest.json'
    $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $value = [ordered]@{
        schemaVersion = $SchemaVersion
        releaseId = '1.2.3-test'
        commit = ('a' * 40)
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        manifestSha256 = $manifestHash
    }
    if ($IncludeDockerImages) {
        $value.dockerImages = @(
            [ordered]@{ component = 'gateway'; repository = 'ghcr.io/example/gateway'; digest = ('sha256:' + ('b' * 64)); platform = 'linux/amd64' },
            [ordered]@{ component = 'proxy'; repository = 'ghcr.io/example/proxy'; digest = ('sha256:' + ('c' * 64)); platform = 'linux/amd64' }
        )
    }
    $json = $value | ConvertTo-Json -Depth 16 -Compress
    $base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    [IO.File]::WriteAllText(
        (Join-Path $releaseRoot 'release-attestation.ps1'),
        ('$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(''' + $base64 + '''))' + [Environment]::NewLine + '$json | ConvertFrom-Json' + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
}

try {
    [IO.File]::WriteAllText(
        (Join-Path $releaseRoot 'manifest.json'),
        (([ordered]@{ releaseId = '1.2.3-test'; commit = ('a' * 40); fileHashes = @() } | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )

    Write-TestAttestation -SchemaVersion 2
    $v2 = Assert-McpPublicReleaseAttestation -ReleaseRoot $releaseRoot -AllowUnsignedDevelopment
    if ([int]$v2.schemaVersion -ne 2) {
        throw 'Release attestation v2 was not accepted.'
    }

    Write-TestAttestation -SchemaVersion 1 -IncludeDockerImages
    $v1 = Assert-McpPublicReleaseAttestation -ReleaseRoot $releaseRoot -AllowUnsignedDevelopment
    if ([int]$v1.schemaVersion -ne 1) {
        throw 'Historical release attestation v1 was not accepted.'
    }

    Write-TestAttestation -SchemaVersion 2 -IncludeDockerImages
    $v2WithDockerRejected = $false
    try {
        Assert-McpPublicReleaseAttestation -ReleaseRoot $releaseRoot -AllowUnsignedDevelopment | Out-Null
    }
    catch {
        $v2WithDockerRejected = $true
    }
    if (-not $v2WithDockerRejected) {
        throw 'Release attestation v2 accepted legacy dockerImages.'
    }

    $commonSource = Get-Content -Raw -LiteralPath $commonPath
    if ($commonSource.Contains('function Import-McpPublicDockerImages')) {
        throw 'Current public distribution helper still exposes Docker image import.'
    }

    $distributionBuilder = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'New-McpPublicDistribution.ps1')
    foreach ($legacyToken in @('GatewayRepository', 'GatewayDigest', 'ProxyRepository', 'ProxyDigest', 'dockerImages')) {
        if ($distributionBuilder.Contains($legacyToken)) {
            throw "Public distribution v2 still contains legacy token: $legacyToken"
        }
    }
    if ($distributionBuilder -notmatch 'schemaVersion = 2') {
        throw 'Public distribution builder does not emit schemaVersion 2.'
    }
    if ($distributionBuilder -match '\.runtime-tools[\\/]mcp-node-runtime') {
        throw 'Public distribution still depends on an out-of-release managed Node runtime.'
    }

    $releaseBuilderPath = Join-Path $PSScriptRoot 'New-McpRelease.ps1'
    if (-not (Test-Path -LiteralPath $releaseBuilderPath -PathType Leaf)) {
        throw 'Docker-free immutable release builder is missing.'
    }
    $releaseBuilderSource = Get-Content -Raw -LiteralPath $releaseBuilderPath
    foreach ($legacyToken in @('SkipDockerImages', 'GatewayRepository', 'ProxyRepository', 'dockerImages')) {
        if ($releaseBuilderSource -match [regex]::Escape($legacyToken)) {
            throw "Immutable release builder contains legacy token: $legacyToken"
        }
    }
    if ($releaseBuilderSource -notmatch 'runtime[\\\\/]node' -or
        $releaseBuilderSource -notmatch 'node\.exe') {
        throw 'Immutable release builder does not bundle the Windows Node runtime inside the release.'
    }

    $repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $releaseWorkflowPath = Join-Path $repositoryRoot '.github\workflows\release.yml'
    $releaseWorkflow = Get-Content -Raw -LiteralPath $releaseWorkflowPath
    $releaseStepIndex = $releaseWorkflow.IndexOf('deploy/windows/New-McpRelease.ps1', [StringComparison]::Ordinal)
    $nativeStepIndex = $releaseWorkflow.IndexOf('deploy/windows/New-McpWindowsExecutionNodeArtifacts.ps1', [StringComparison]::Ordinal)
    $distributionStepIndex = $releaseWorkflow.IndexOf('deploy/windows/New-McpPublicDistribution.ps1', [StringComparison]::Ordinal)
    if ($releaseStepIndex -lt 0 -or $nativeStepIndex -lt 0 -or $distributionStepIndex -lt 0 -or
        $releaseStepIndex -ge $nativeStepIndex -or $nativeStepIndex -ge $distributionStepIndex) {
        throw 'Public release workflow must build immutable release, native artifacts, then signed distribution in order.'
    }
    if ($releaseWorkflow -match 'test\s+"\$\{#run_ids\[@\]\}"\s+-eq\s+1') {
        throw 'Public release workflow rejects valid duplicate successful CI evidence for the same immutable commit.'
    }
    if ($releaseWorkflow -notmatch 'sort_by\(\.databaseId\)\s*\|\s*last\s*\|\s*\.databaseId\s*//\s*empty') {
        throw 'Public release workflow does not deterministically select the newest successful CI run.'
    }

    $edgeJobMatch = [regex]::Match($releaseWorkflow, '(?m)^  edge:\s*$')
    $publishJobMatch = [regex]::Match($releaseWorkflow, '(?m)^  publish:\s*$')
    if (-not $edgeJobMatch.Success -or -not $publishJobMatch.Success -or $edgeJobMatch.Index -ge $publishJobMatch.Index) {
        throw 'Public release workflow must gate publication on an Edge deployment job.'
    }

    $edgeJobSource = $releaseWorkflow.Substring($edgeJobMatch.Index, $publishJobMatch.Index - $edgeJobMatch.Index)
    foreach ($requiredToken in @(
        '- package',
        'CLOUDFLARE_API_TOKEN',
        'CLOUDFLARE_ACCOUNT_ID',
        'npm run deploy --workspace @mcp-access-stack/edge-gateway',
        'services/mcp-edge-gateway/src/generated/mcp-tool-manifest.ts',
        'Preflight contract rollout compatibility',
        'Contract-changing release requires rollout infrastructure from the previous stable Edge before deploy.',
        'another candidate contract is still prepared',
        'expectedContractRevision',
        'activeContractRevision',
        'candidateContractRevision',
        'executionPlaneReady',
        'contractCompatible',
        '/health',
        'controlPlaneReady'
    )) {
        if (-not $edgeJobSource.Contains($requiredToken)) {
            throw "Public release Edge gate is missing required token: $requiredToken"
        }
    }
    $publishJobSource = $releaseWorkflow.Substring($publishJobMatch.Index)
    if (-not $publishJobSource.Contains('- edge')) {
        throw 'Public GitHub Release must depend on the successful Edge contract gate.'
    }
    if ($distributionStepIndex -ge $edgeJobMatch.Index) {
        throw 'Signed Windows distribution must be complete before the Edge production mutation begins.'
    }
    Write-Output 'Release contract v2 test passed: v2 is Docker-free, runtime is self-contained, CI evidence is duplicate-safe, Edge prepare gates publication without invalidating the active connector, and v1 remains historical read compatibility.'
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
