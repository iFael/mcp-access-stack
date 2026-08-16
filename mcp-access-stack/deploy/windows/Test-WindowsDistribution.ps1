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
$executionNodeBuilder = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'New-McpWindowsExecutionNodeArtifacts.ps1') -Raw
$mcpHostSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\tooling\windows-execution-node\McpHost.cs') -Raw
$executionNodeCommon = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1') -Raw
$executionNodeStager = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Stage-McpWindowsExecutionNodeCandidate.ps1') -Raw
if (
    -not $common.Contains('distribution-manifest.ps1') -or
    -not $common.Contains('Assert-McpPublicSignature')
) {
    throw 'Distribution hashes must be rooted in a signed manifest.'
}
if (
    -not $releaseWorkflow.Contains('New-McpPublicDistribution.ps1') -or
    -not $releaseWorkflow.Contains('New-McpWindowsExecutionNodeArtifacts.ps1') -or
    -not $releaseWorkflow.Contains('Test-McpWindowsExecutionNodePackage.ps1') -or
    -not $distributionBuilder.Contains('distribution-manifest.ps1') -or
    -not $distributionBuilder.Contains('release-attestation.ps1') -or
    -not $distributionBuilder.Contains('execution-node-manifest.json') -or
    -not $distributionBuilder.Contains('ExecutionNodeNativeDirectory') -or
    -not $distributionBuilder.Contains('McpHost.exe') -or
    -not $distributionBuilder.Contains('WindowsExecutionNode.Common.ps1') -or
    -not $distributionBuilder.Contains('Stage-McpWindowsExecutionNodeCandidate.ps1') -or
    -not $distributionBuilder.Contains('Set-AuthenticodeSignature')
) {
    throw 'Public release workflow must build and sign the execution-node distribution and release attestation.'
}
foreach ($required in @(
    'McpHost.exe',
    'McpNodeHostLauncher.exe',
    'McpCredentialBroker.exe',
    'Microsoft.NET\Framework64\v4.0.30319\csc.exe',
    'mcp-host-contract-v1'
)) {
    if (-not $executionNodeBuilder.Contains($required)) {
        throw "Execution-node native builder requirement is missing: $required"
    }
}
foreach ($required in @('--version', '--validate-release-root', 'runtime supervision is not enabled yet')) {
    if (-not $mcpHostSource.Contains($required)) {
        throw "McpHost stage-2 safety contract is missing: $required"
    }
}
foreach ($required in @(
    'Assert-McpWindowsExecutionNodeRelease',
    'Assert-McpWindowsExecutionNodeNoReparsePoints',
    'Assert-McpWindowsExecutionNodeDistributionCompleteness',
    'Assert-McpWindowsExecutionNodeMaterializedRelease',
    'Read-McpWindowsExecutionNodeState',
    'Write-McpWindowsExecutionNodeState'
)) {
    if (-not $executionNodeCommon.Contains($required)) {
        throw "Execution-node common requirement is missing: $required"
    }
}
foreach ($required in @(
    'Assert-McpPublicDistribution',
    'ExpectedReleaseId',
    'distributionCommit',
    'state.lock',
    'activeChanged = $false',
    'candidatePrepared = $true'
)) {
    if (-not $executionNodeStager.Contains($required)) {
        throw "Execution-node stager requirement is missing: $required"
    }
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

if ([string]$env:GITHUB_ACTIONS -eq 'true') {
    $fixtureRoot = Join-Path $env:RUNNER_TEMP ('execution-node-builder-fixture-' + [guid]::NewGuid().ToString('N'))
    $fixtureRelease = Join-Path $fixtureRoot 'release'
    $fixtureOutput = Join-Path $fixtureRoot 'output'
    try {
        $launcherFixture = Join-Path $fixtureRelease 'tooling\windows-host-launcher'
        $brokerFixture = Join-Path $fixtureRelease 'tooling\windows-credential-broker'
        New-Item -ItemType Directory -Force -Path $launcherFixture, $brokerFixture | Out-Null
        Copy-Item `
            -LiteralPath (Join-Path $PSScriptRoot '..\..\tooling\windows-host-launcher\McpNodeHostLauncher.cs') `
            -Destination (Join-Path $launcherFixture 'McpNodeHostLauncher.cs')
        Copy-Item `
            -LiteralPath (Join-Path $PSScriptRoot '..\..\tooling\windows-credential-broker\McpCredentialBroker.cs') `
            -Destination (Join-Path $brokerFixture 'McpCredentialBroker.cs')
        [IO.File]::WriteAllText(
            (Join-Path $fixtureRelease 'manifest.json'),
            (([ordered]@{
                releaseId = 'ci-fixture'
                commit = ('a' * 40)
            } | ConvertTo-Json) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )

        $resultJson = & pwsh -NoLogo -NoProfile `
            -File (Join-Path $PSScriptRoot 'New-McpWindowsExecutionNodeArtifacts.ps1') `
            -ReleaseRoot $fixtureRelease `
            -ReleaseId 'ci-fixture' `
            -SourceCommit ('a' * 40) `
            -OutputDirectory $fixtureOutput
        if ($LASTEXITCODE -ne 0) {
            throw 'Execution-node native builder CI smoke failed.'
        }
        $result = $resultJson | ConvertFrom-Json
        if ([string]$result.status -ne 'built' -or @($result.artifacts).Count -ne 3) {
            throw 'Execution-node native builder CI smoke returned unexpected evidence.'
        }
    }
    finally {
        if (Test-Path -LiteralPath $fixtureRoot) {
            Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
        }
    }
}
& (Join-Path $PSScriptRoot 'Test-McpWindowsExecutionNodeStaging.ps1')
Write-Output 'Windows distribution scripts have valid syntax and safety gates.'
