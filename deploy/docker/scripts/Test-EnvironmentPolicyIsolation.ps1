[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Join-Path ([System.IO.Path]::GetTempPath()) ('mcp-policy-isolation-' + [guid]::NewGuid().ToString('N'))
$sourcePath = Join-Path $root 'source-policy.json'
$localAppDataRoot = Join-Path $root 'local-app-data'

try {
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Write-McpJsonFile -Path $sourcePath -Value ([ordered]@{
        version = 1
        workspaces = @(
            [ordered]@{ id = 'one'; name = 'One' },
            [ordered]@{ id = 'two'; name = 'Two' }
        )
    })

    $development = Install-McpEnvironmentPolicySnapshot `
        -Environment 'development' `
        -SourcePolicyPath $sourcePath `
        -LocalApplicationDataRoot $localAppDataRoot
    $production = Install-McpEnvironmentPolicySnapshot `
        -Environment 'production' `
        -SourcePolicyPath $sourcePath `
        -LocalApplicationDataRoot $localAppDataRoot

    if ($development.environment -ne 'development') {
        throw 'Development environment normalization failed.'
    }
    if ($production.environment -ne 'production') {
        throw 'Production environment normalization failed.'
    }
    if ($development.policyPath -eq $production.policyPath) {
        throw 'Development and production policies must not share the same physical file.'
    }
    $expectedDevelopmentDirectory = Get-McpEnvironmentPolicyDirectory `
        -Environment 'development' `
        -LocalApplicationDataRoot $localAppDataRoot
    if (-not [System.IO.Path]::GetFullPath([string]$development.policyPath).StartsWith(
        [System.IO.Path]::GetFullPath($expectedDevelopmentDirectory),
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Development policy path is outside the canonical development environment directory.'
    }
    if ($development.policySha256 -ne $production.policySha256) {
        throw 'Equivalent source policies must install with the same SHA-256.'
    }
    if ([int]$development.workspaceCount -ne 2 -or [int]$production.workspaceCount -ne 2) {
        throw 'Environment policy workspace counts are incorrect.'
    }

    $developmentManifest = Read-McpJsonFile -Path $development.manifestPath
    $productionManifest = Read-McpJsonFile -Path $production.manifestPath
    if ([string]$developmentManifest.environment -ne 'development') {
        throw 'Development policy manifest environment is incorrect.'
    }
    if ([string]$developmentManifest.runtimeEnvironmentId -ne 'development') {
        throw 'Development policy manifest runtime environment id is incorrect.'
    }
    if ([string]$productionManifest.environment -ne 'production') {
        throw 'Production policy manifest environment is incorrect.'
    }

    $productionBeforeSha = [Convert]::ToHexString(
        [System.Security.Cryptography.SHA256]::HashData(
            [System.IO.File]::ReadAllBytes([string]$production.policyPath)
        )
    )
    [System.IO.File]::WriteAllText(
        [string]$development.policyPath,
        '{"version":1,"workspaces":[]}',
        [System.Text.UTF8Encoding]::new($false)
    )
    $productionAfterSha = [Convert]::ToHexString(
        [System.Security.Cryptography.SHA256]::HashData(
            [System.IO.File]::ReadAllBytes([string]$production.policyPath)
        )
    )
    if ($productionBeforeSha -ne $productionAfterSha) {
        throw 'Changing the development policy unexpectedly changed the production policy.'
    }

    Write-Output 'Environment policy isolation test passed: development and production own independent policy snapshots.'
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
