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
$mcpHostSupervisorSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\tooling\windows-execution-node\McpHostSupervisor.cs') -Raw
$mcpHostPersistenceSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\tooling\windows-execution-node\McpHostPersistence.cs') -Raw
$authenticodeVerifierSourcePath = Join-Path $PSScriptRoot '..\..\tooling\windows-execution-node\McpAuthenticodeVerifier.cs'
$authenticodeVerifierSource = Get-Content -LiteralPath $authenticodeVerifierSourcePath -Raw
$executionNodeCommon = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1') -Raw
$executionNodeStager = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Stage-McpWindowsExecutionNodeCandidate.ps1') -Raw
$executionNodeTransition = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeTransition.ps1') -Raw
$executionNodeTaskInstaller = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Install-McpWindowsExecutionNodeHostTask.ps1') -Raw
$edgeConnectorTaskInstaller = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Install-McpEdgeConnectorTask.ps1') -Raw
$edgeConnectorLauncher = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Start-McpEdgeConnector.ps1') -Raw
$executionNodeCutover = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeCutover.ps1') -Raw
$executionNodeCutoverTaskInstaller = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Install-McpWindowsExecutionNodeCutoverTask.ps1') -Raw
$executionNodeCutoverTaskBroker = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeCutoverTask.ps1') -Raw
$executionNodeCutoverRequest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Request-McpWindowsExecutionNodeCutover.ps1') -Raw
if (
    -not $common.Contains('distribution-manifest.ps1') -or
    -not $common.Contains('Assert-McpPublicSignature')
) {
    throw 'Distribution hashes must be rooted in a signed manifest.'
}
foreach ($required in @(
    '-OfflinePinnedAuthenticode',
    'timeout-minutes: 5'
)) {
    if (-not $releaseWorkflow.Contains($required)) {
        throw "Public release package-validation offline Authenticode requirement is missing: $required"
    }
}
foreach ($forbidden in @(
    'Import-Certificate',
    'addedTrustPaths',
    'Cert:\CurrentUser\$storeName'
)) {
    if ($releaseWorkflow.Contains($forbidden)) {
        throw "Public release package validation must not mutate certificate stores: $forbidden"
    }
}
foreach ($required in @(
    'OfflinePinned',
    'McpAuthenticodeVerifier',
    '800B0109',
    'GITHUB_ACTIONS'
)) {
    if (-not $common.Contains($required)) {
        throw "Offline pinned Authenticode common contract is missing: $required"
    }
}
foreach ($required in @(
    'WinVerifyTrust',
    'WTD_UI_NONE',
    'WTD_REVOKE_NONE',
    'WTD_REVOCATION_CHECK_NONE',
    'WTD_CACHE_ONLY_URL_RETRIEVAL',
    'WTHelperProvDataFromStateData',
    'WTHelperGetProvSignerFromChain',
    'WTHelperGetProvCertFromChain',
    'CertGetCertificateContextProperty',
    'CERT_SHA1_HASH_PROP_ID',
    'new IntPtr(-1)'
)) {
    if (-not $authenticodeVerifierSource.Contains($required)) {
        throw "Offline Authenticode verifier contract is missing: $required"
    }
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
    -not $distributionBuilder.Contains('Invoke-McpWindowsExecutionNodeTransition.ps1') -or
    -not $distributionBuilder.Contains('Install-McpWindowsExecutionNodeHostTask.ps1') -or
    -not $distributionBuilder.Contains('Install-McpEdgeConnectorTask.ps1') -or
    -not $distributionBuilder.Contains('Start-McpEdgeConnector.ps1') -or
    -not $distributionBuilder.Contains("-Role 'edge-connector'") -or
    -not $distributionBuilder.Contains("-Role 'edge-connector-launcher'") -or
    -not $distributionBuilder.Contains('Invoke-McpWindowsExecutionNodeCutover.ps1') -or
    -not $distributionBuilder.Contains('Install-McpWindowsExecutionNodeCutoverTask.ps1') -or
    -not $distributionBuilder.Contains('Invoke-McpWindowsExecutionNodeCutoverTask.ps1') -or
    -not $distributionBuilder.Contains('Request-McpWindowsExecutionNodeCutover.ps1') -or
    -not $distributionBuilder.Contains('Set-AuthenticodeSignature')
) {
    throw 'Public release workflow must build and sign the execution-node distribution and release attestation.'
}
foreach ($required in @(
    'McpHost.exe',
    'McpHostSupervisor.cs',
    'McpHostPersistence.cs',
    'McpNodeHostLauncher.exe',
    'McpCredentialBroker.exe',
    'Microsoft.NET\Framework64\v4.0.30319\csc.exe',
    'System.Web.Extensions.dll',
    'mcp-host-contract-v3'
)) {
    if (-not $executionNodeBuilder.Contains($required)) {
        throw "Execution-node native builder requirement is missing: $required"
    }
}
foreach ($required in @(
    'four legacy or six Edge-capable critical artifacts',
    'edge-connector',
    'edge-connector-launcher'
)) {
    if (-not $executionNodeCommon.Contains($required)) {
        throw "Execution-node Edge compatibility contract is missing: $required"
    }
}
foreach ($required in @(
    'ExpectedManifestSha256',
    "Role 'edge-connector'",
    "Role 'edge-connector-launcher'",
    "BROWSER_WORKER_ENABLED = 'false'",
    'OWNER_OAUTH_STATE_PATH',
    'ValidateOnly'
)) {
    if (-not $edgeConnectorLauncher.Contains($required)) {
        throw "Persistent Edge Connector launcher contract is missing: $required"
    }
}
foreach ($required in @(
    'New-ScheduledTaskAction',
    'New-ScheduledTaskTrigger -AtLogOn',
    '-MultipleInstances IgnoreNew',
    '-RestartCount 5',
    '-RunLevel Limited',
    "'AllSigned'",
    'edge-connector-launcher',
    'ValidateOnly'
)) {
    if (-not $edgeConnectorTaskInstaller.Contains($required)) {
        throw "Persistent Edge Connector task contract is missing: $required"
    }
}

foreach ($required in @('--version', '--validate-release-root', '--supervise', '--run-active', 'installation-root', 'expected-manifest-sha256', 'qualification-owner-pid')) {
    if (-not $mcpHostSource.Contains($required)) {
        throw "McpHost supervisor CLI contract is missing: $required"
    }
}
foreach ($required in @(
    'JobObjectLimitKillOnJobClose',
    '/health/ready',
    'Execution-node artifact changed after validation',
    'eventName, "connected"',
    'host-state.json',
    'mcp_host_qualification_owner_exited',
    'either four legacy or six Edge-capable critical artifacts',
    'services/mcp-gateway/dist/edge-connector-cli.js',
    'deploy/windows/Start-McpEdgeConnector.ps1',
    'Edge connector launcher artifact must require Authenticode.'
)) {
    if (-not $mcpHostSupervisorSource.Contains($required)) {
        throw "McpHost supervisor runtime contract is missing: $required"
    }
}
foreach ($required in @(
    'host-ownership-',
    'Stable McpHost does not match the active release McpHost artifact.',
    'ExecutionNodeSupervisor.Run',
    'LifecycleStateFileName',
    'lifecycle-state.v1.json'
)) {
    if (-not $mcpHostPersistenceSource.Contains($required)) {
        throw "McpHost persistent ownership contract is missing: $required"
    }
}
foreach ($required in @(
    'New-ScheduledTaskAction',
    '-Execute $stableHostPath',
    '--run-active',
    'New-ScheduledTaskTrigger -AtLogOn',
    '-MultipleInstances IgnoreNew'
)) {
    if (-not $executionNodeTaskInstaller.Contains($required)) {
        throw "Persistent host task contract is missing: $required"
    }
}
foreach ($required in @(
    'Disable-McpLegacyOwnership',
    'Sync-McpStableHost',
    'Wait-McpPersistentReady',
    'Restore-McpLegacyOwnership',
    'Enter-McpWindowsExecutionNodeOperationMutex'
)) {
    if (-not $executionNodeCutover.Contains($required)) {
        throw "Execution-node cutover contract is missing: $required"
    }
}
foreach ($required in @(
    'New-ScheduledTaskAction',
    'Invoke-McpWindowsExecutionNodeCutoverTask.ps1',
    '-ExecutionPolicy',
    'AllSigned',
    '-MultipleInstances IgnoreNew',
    '-RunLevel Limited',
    'independentOwner = $true'
)) {
    if (-not $executionNodeCutoverTaskInstaller.Contains($required)) {
        throw "Detached execution-node cutover Task installer contract is missing: $required"
    }
}
foreach ($required in @(
    'cutover-request.json',
    'cutover-runs',
    'Invoke-McpWindowsExecutionNodeCutover.ps1',
    'McpCredentialBroker.exe',
    "status = 'passed'",
    'Move-Item -LiteralPath $requestPath'
)) {
    if (-not $executionNodeCutoverTaskBroker.Contains($required)) {
        throw "Detached execution-node cutover broker contract is missing: $required"
    }
}
foreach ($required in @(
    'Start-ScheduledTask',
    'cutover-request.json',
    'expectedManifestSha256',
    'detached = $true'
)) {
    if (-not $executionNodeCutoverRequest.Contains($required)) {
        throw "Detached execution-node cutover request contract is missing: $required"
    }
}
foreach ($required in @(
    'Assert-McpWindowsExecutionNodeRelease',
    'Assert-McpWindowsExecutionNodeNoReparsePoints',
    'Assert-McpWindowsExecutionNodeDistributionCompleteness',
    'Assert-McpWindowsExecutionNodeMaterializedRelease',
    'Get-McpWindowsExecutionNodeStatePath',
    'lifecycle-state.v1.json',
    'Read-McpWindowsExecutionNodeState',
    'Write-McpWindowsExecutionNodeState',
    'Enter-McpWindowsExecutionNodeOperationMutex',
    'Exit-McpWindowsExecutionNodeOperationMutex'
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
    'candidatePrepared = $true',
    'Enter-McpWindowsExecutionNodeOperationMutex'
)) {
    if (-not $executionNodeStager.Contains($required)) {
        throw "Execution-node stager requirement is missing: $required"
    }
}
foreach ($required in @(
    "ValidateSet('Promote', 'Rollback')",
    'state.lock',
    'Assert-McpWindowsExecutionNodeRelease',
    'healthValidated',
    'candidate = $null',
    'previous = $sourcePointer',
    'candidate = $sourcePointer',
    '--qualification-owner-pid',
    'Enter-McpWindowsExecutionNodeOperationMutex'
)) {
    if (-not $executionNodeTransition.Contains($required)) {
        throw "Execution-node transition requirement is missing: $required"
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
    if (-not ('McpAuthenticodeVerifier' -as [type])) {
        Add-Type -Path $authenticodeVerifierSourcePath
    }
    if (-not ('McpAuthenticodeVerifier' -as [type])) {
        throw 'Offline Authenticode verifier did not compile on the GitHub Windows runner.'
    }

    $authFixtureRoot = Join-Path $env:RUNNER_TEMP ('authenticode-verifier-fixture-' + [guid]::NewGuid().ToString('N'))
    $authFixtureCertificate = $null
    try {
        New-Item -ItemType Directory -Force -Path $authFixtureRoot | Out-Null
        $authFixturePath = Join-Path $authFixtureRoot 'probe.ps1'
        [IO.File]::WriteAllText(
            $authFixturePath,
            "Write-Output 'authenticode-probe'`r`n",
            [Text.UTF8Encoding]::new($false)
        )
        $authFixtureCertificate = New-SelfSignedCertificate `
            -Type CodeSigningCert `
            -Subject ('CN=MCP Offline Authenticode CI ' + [guid]::NewGuid().ToString('N')) `
            -CertStoreLocation 'Cert:\CurrentUser\My'
        Set-AuthenticodeSignature `
            -LiteralPath $authFixturePath `
            -Certificate $authFixtureCertificate `
            -HashAlgorithm SHA256 | Out-Null

        $authFixtureResult = [McpAuthenticodeVerifier]::Verify($authFixturePath)
        $authFixtureStatus = [uint32]$authFixtureResult.StatusCode
        $trustUntrustedRoot = [Convert]::ToUInt32('800B0109', 16)
        $authFixtureThumbprint = (([string]$authFixtureResult.SignerThumbprint) -replace '[^A-Fa-f0-9]', '').ToUpperInvariant()
        $expectedFixtureThumbprint = (([string]$authFixtureCertificate.Thumbprint) -replace '[^A-Fa-f0-9]', '').ToUpperInvariant()
        if ($authFixtureStatus -notin @([uint32]0, $trustUntrustedRoot) -or
            $authFixtureThumbprint -ne $expectedFixtureThumbprint) {
            throw ("Offline Authenticode verifier rejected a valid CI fixture. WinVerifyTrust=0x{0:X8}" -f $authFixtureStatus)
        }

        $signedFixture = [IO.File]::ReadAllText($authFixturePath)
        [IO.File]::WriteAllText(
            $authFixturePath,
            $signedFixture.Replace('authenticode-probe', 'authenticode-pr0be'),
            [Text.UTF8Encoding]::new($false)
        )
        $tamperedFixtureResult = [McpAuthenticodeVerifier]::Verify($authFixturePath)
        $tamperedStatus = [uint32]$tamperedFixtureResult.StatusCode
        if ($tamperedStatus -in @([uint32]0, $trustUntrustedRoot)) {
            throw 'Offline Authenticode verifier accepted a tampered CI fixture.'
        }
    }
    finally {
        if ($authFixtureCertificate) {
            Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($authFixtureCertificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $authFixtureRoot) {
            Remove-Item -LiteralPath $authFixtureRoot -Recurse -Force
        }
    }

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
& (Join-Path $PSScriptRoot 'Test-McpHostSupervisor.ps1')
& (Join-Path $PSScriptRoot 'Test-McpWindowsExecutionNodeStaging.ps1')
& (Join-Path $PSScriptRoot 'Test-McpWindowsExecutionNodeTransition.ps1')
& (Join-Path $PSScriptRoot 'Test-McpWindowsExecutionNodePersistence.ps1')
& (Join-Path $PSScriptRoot 'Test-McpEdgeConnectorPersistence.ps1')
Write-Output 'Windows distribution scripts have valid syntax and safety gates.'
