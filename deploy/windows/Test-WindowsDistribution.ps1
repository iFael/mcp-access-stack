[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$files = Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.ps1'
$issues = @()
foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile(
        $file.FullName,
        [ref]$tokens,
        [ref]$errors
    ) | Out-Null
    foreach ($parseError in $errors) {
        $issues += "$($file.Name): $($parseError.Message)"
    }
}
if ($issues.Count -gt 0) {
    throw ($issues -join [Environment]::NewLine)
}

$installer = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Install-McpAccessStack.ps1') -Raw
$updater = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Update-McpAccessStack.ps1') -Raw
$common = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1') -Raw
$credentialManager = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Manage-McpCredential.ps1') -Raw
$releaseWorkflowPath = Join-Path $PSScriptRoot '..\..\..\.github\workflows\release.yml'
$releaseWorkflow = Get-Content -LiteralPath $releaseWorkflowPath -Raw
$distributionBuilder = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'New-McpPublicDistribution.ps1') -Raw
if (
    -not $common.Contains('distribution-manifest.ps1') -or
    -not $common.Contains('Assert-McpPublicSignature')
) {
    throw 'Distribution hashes must be rooted in a signed manifest.'
}
if (
    -not $releaseWorkflow.Contains('New-McpPublicDistribution.ps1') -or
    -not $distributionBuilder.Contains('distribution-manifest.ps1') -or
    -not $distributionBuilder.Contains('release-attestation.ps1') -or
    -not $distributionBuilder.Contains('Set-AuthenticodeSignature')
) {
    throw 'Public release workflow must build a signed distribution and release attestation.'
}
foreach ($required in @(
    'Assert-McpPublicSignature',
    'Assert-McpPublicDistribution',
    'Assert-McpPublicReleaseFiles',
    'Assert-McpPublicReleaseAttestation',
    'Import-McpPublicDockerImages',
    'playwright\cli.js',
    '-DockerTunnel',
    '-AuthMode owner',
    'Wait-McpHttpEndpoint',
    'Activate-McpCandidateRelease.ps1',
    'Install-McpProductionPromotionTask.ps1'
)) {
    if (-not $installer.Contains($required)) {
        throw "Windows installer requirement is missing: $required"
    }
}
foreach ($required in @(
    'Get-McpCredentialBrokerExecutable',
    'McpAccessStack/',
    '--mode',
    'manage',
    'Start-Process'
)) {
    if (-not $credentialManager.Contains($required)) {
        throw "Credential management requirement is missing: $required"
    }
}
if ($credentialManager.Contains('--username') -or $credentialManager.Contains('--password')) {
    throw 'Credential management must not transport secrets through PowerShell arguments.'
}
foreach ($required in @(
    'browser_download_url',
    'SHA-256',
    'candidate',
    'Assert-McpPublicReleaseAttestation',
    'Request-McpProductionPromotion.ps1',
    'if ($Promote)'
)) {
    if (-not $updater.Contains($required)) {
        throw "Windows updater requirement is missing: $required"
    }
}

if ($releaseWorkflow -match 'uses:\s+[^\r\n#]+@v[0-9]') {
    throw 'Public release workflow contains a mutable action tag instead of an immutable SHA.'
}
if (-not $releaseWorkflow.Contains('persist-credentials: false')) {
    throw 'Public release workflow must disable persisted checkout credentials.'
}
if (-not $distributionBuilder.Contains('WINDOWS_SIGNING_PFX_BASE64') -or
    -not $distributionBuilder.Contains('WINDOWS_SIGNING_PFX_PASSWORD')) {
    throw 'Public distribution builder must fail closed without code-signing secrets.'
}

Write-Output 'Windows distribution scripts have valid syntax and safety gates.'
