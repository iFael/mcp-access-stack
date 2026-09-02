[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$gitRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '..'))
$workflowPath = Join-Path $gitRoot '.github\workflows\windows-edge-candidate.yml'
$builderPath = Join-Path $PSScriptRoot 'New-McpWindowsEdgeCandidate.ps1'
$validatorPath = Join-Path $PSScriptRoot 'Test-McpWindowsEdgeCandidate.ps1'

foreach ($dependency in @($workflowPath, $builderPath, $validatorPath)) {
    if (-not (Test-Path -LiteralPath $dependency -PathType Leaf)) {
        throw "Windows Edge candidate signing dependency is missing: $dependency"
    }
}

$workflow = Get-Content -LiteralPath $workflowPath -Raw
$builder = Get-Content -LiteralPath $builderPath -Raw
$validator = Get-Content -LiteralPath $validatorPath -Raw

foreach ($required in @(
    'workflow_dispatch:',
    "if: github.ref == 'refs/heads/main'",
    'CURRENT_REF',
    'ref: ${{ github.sha }}',
    'persist-credentials: false',
    'environment: public-release',
    'WINDOWS_SIGNING_PFX_BASE64',
    'WINDOWS_SIGNING_PFX_PASSWORD',
    '--workflow CI',
    '--branch main',
    '--commit $env:GITHUB_SHA',
    '--event push',
    '--status success',
    'v1.1.0-beta.24',
    '.sha256',
    'Assert-McpPublicDistribution',
    "Set-McpPublicSignatureValidationMode -Mode 'OfflinePinned'",
    'distribution-manifest.ps1',
    'New-McpWindowsExecutionNodeArtifacts.ps1',
    'New-McpWindowsEdgeCandidate.ps1',
    'Test-McpWindowsEdgeCandidate.ps1',
    'retention-days: 1'
)) {
    if (-not $workflow.Contains($required)) {
        throw "Windows Edge candidate workflow contract is missing: $required"
    }
}

foreach ($forbidden in @(
    'packages: write',
    'docker/login-action',
    'docker/build-push-action',
    'gh release create',
    'gh release upload',
    'wrangler deploy',
    'inputs:',
    'github.event.inputs',
    '-SkipArchive'
)) {
    if ($workflow.Contains($forbidden)) {
        throw "Windows Edge candidate workflow contains forbidden publication/input surface: $forbidden"
    }
}

foreach ($required in @(
    'BaseReleaseRoot',
    'CandidateId',
    'PatchCommit',
    'EdgeHostExecutable',
    'OutputDirectory',
    'AllowUnsignedDevelopment',
    'SkipArchive',
    'Assert-McpPublicReleaseAttestation',
    'baseReleaseId',
    'baseCommit',
    'patchCommit',
    'edgePatch',
    "-Role 'edge-host'",
    "-Role 'edge-native-launcher'",
    'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js',
    'Set-AuthenticodeSignature',
    'release-attestation.ps1',
    'manifestSha256',
    'Compress-Archive'
)) {
    if (-not $builder.Contains($required)) {
        throw "Windows Edge candidate builder contract is missing: $required"
    }
}

if (-not $builder.Contains('robocopy.exe')) {
    throw 'Windows Edge candidate builder must use robocopy for the official base release tree.'
}
if ($builder.Contains('Copy-Item -LiteralPath $baseRelease -Destination $releaseParent -Recurse')) {
    throw 'Windows Edge candidate builder must not use recursive Copy-Item for the official base release tree.'
}
if ($validator.Contains('-RuntimeSmoke')) {
    throw 'Windows Edge candidate validator must not execute the legacy McpHost release-root runtime smoke against the 8-role patch manifest.'
}

if ($validator.Contains('Copy-Item -Path (Join-Path $root ''*'')')) {
    throw 'Windows Edge candidate validator must not copy the full candidate tree to simulate artifact loss.'
}
foreach ($requiredRegression in @(
    'Move-Item -LiteralPath $legacyLauncher',
    'Move-Item -LiteralPath $serviceCli',
    'Candidate loss simulation did not restore the legacy launcher.',
    'Candidate loss simulation did not restore the service CLI.',
    '$installerArguments += ''-AllowUnsignedDevelopment'''
)) {
    if (-not $validator.Contains($requiredRegression)) {
        throw "Windows Edge candidate validator regression contract is missing: $requiredRegression"
    }
}
foreach ($required in @(
    'CandidateRoot',
    'CandidateId',
    'PatchCommit',
    'OfflinePinnedAuthenticode',
    'SimulateLegacyLauncherLoss',
    'Assert-McpWindowsExecutionNodeRelease',
    'McpNodeHostLauncher.exe',
    'services\mcp-gateway\dist\edge-connector-cli.js',
    'McpEdgeHost.exe',
    'Start-McpEdgeConnector.ps1',
    'Install-McpEdgeConnectorTask.ps1',
    'legacyLauncherPresent',
    'serviceCliPresent',
    'installerPlanStatus'
)) {
    if (-not $validator.Contains($required)) {
        throw "Windows Edge candidate validator contract is missing: $required"
    }
}

Write-Output 'Windows Edge candidate signing workflow static contract passed.'
