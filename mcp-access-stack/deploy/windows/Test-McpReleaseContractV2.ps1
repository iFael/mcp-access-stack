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


    Write-Output 'Release contract v2 test passed: v2 is Docker-free and v1 remains historical read compatibility.'
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
