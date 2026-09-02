[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CandidateRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$CandidateId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{40}$')]
    [string]$PatchCommit,

    [switch]$OfflinePinnedAuthenticode,
    [switch]$SimulateLegacyLauncherLoss,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$root = [IO.Path]::GetFullPath($CandidateRoot)
$publicCommonPath = Join-Path $projectRoot 'deploy\windows\PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $projectRoot 'deploy\windows\WindowsExecutionNode.Common.ps1'

. $publicCommonPath
. $executionCommonPath

if ($OfflinePinnedAuthenticode) {
    Set-McpPublicSignatureValidationMode -Mode 'OfflinePinned'
}

if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "CandidateRoot was not found: $root"
}

function Quote-CandidateArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"')) {
        throw 'Candidate qualification arguments cannot contain quotes.'
    }
    return '"' + $Value + '"'
}

function Invoke-CandidateEdgeHost {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.Arguments = (@($Arguments | ForEach-Object { Quote-CandidateArgument -Value $_ }) -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw 'McpEdgeHost candidate validation process did not start.'
        }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        return [pscustomobject]@{
            exitCode = $process.ExitCode
            stdout = $stdout.Trim()
            stderr = $stderr.Trim()
        }
    }
    finally {
        $process.Dispose()
    }
}

function Assert-CandidateMetadata {
    param([Parameter(Mandatory = $true)][string]$CandidateStageRoot)

    $releaseRoot = Join-Path $CandidateStageRoot "releases\$CandidateId"
    if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) {
        throw "Candidate release root is missing: $releaseRoot"
    }

    $verification = Assert-McpWindowsExecutionNodeRelease `
        -ReleaseRoot $releaseRoot `
        -ExpectedReleaseId $CandidateId `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    $attestation = Assert-McpPublicReleaseAttestation `
        -ReleaseRoot $releaseRoot `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
    $manifest = Read-McpPublicJson -Path (Join-Path $releaseRoot 'manifest.json')
    $executionManifest = Read-McpPublicJson -Path (Join-Path $releaseRoot 'execution-node-manifest.json')

    if ($null -eq $manifest.edgePatch -or
        [int]$manifest.edgePatch.schemaVersion -ne 1 -or
        [string]$manifest.edgePatch.kind -ne 'edge-host-persistence' -or
        [string]$manifest.edgePatch.patchCommit -ne $PatchCommit -or
        [string]$manifest.edgePatch.baseReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or
        [string]$manifest.edgePatch.baseCommit -notmatch '^[a-f0-9]{40}$' -or
        [string]$manifest.commit -ne [string]$manifest.edgePatch.baseCommit) {
        throw 'Candidate manifest Edge patch metadata is invalid.'
    }
    if ($null -eq $executionManifest.edgePatch -or
        [string]$executionManifest.edgePatch.baseReleaseId -ne [string]$manifest.edgePatch.baseReleaseId -or
        [string]$executionManifest.edgePatch.baseCommit -ne [string]$manifest.edgePatch.baseCommit -or
        [string]$executionManifest.edgePatch.patchCommit -ne $PatchCommit) {
        throw 'Candidate execution manifest Edge patch metadata is invalid.'
    }
    if ($null -eq $attestation.edgePatch -or
        [string]$attestation.edgePatch.baseReleaseId -ne [string]$manifest.edgePatch.baseReleaseId -or
        [string]$attestation.edgePatch.baseCommit -ne [string]$manifest.edgePatch.baseCommit -or
        [string]$attestation.edgePatch.patchCommit -ne $PatchCommit) {
        throw 'Candidate release attestation Edge patch metadata is invalid.'
    }
    if (@($executionManifest.artifacts).Count -ne 8) {
        throw 'Candidate execution manifest must contain exactly eight split-owner artifacts.'
    }

    return [pscustomobject]@{
        releaseRoot = $releaseRoot
        manifest = $manifest
        executionManifest = $executionManifest
        attestation = $attestation
        verification = $verification
    }
}

function Invoke-CandidateEdgeBoundary {
    param([Parameter(Mandatory = $true)][string]$CandidateStageRoot)

    $releaseRoot = Join-Path $CandidateStageRoot "releases\$CandidateId"
    $installer = Join-Path $CandidateStageRoot 'deploy\windows\Install-McpEdgeConnectorTask.ps1'
    $launcher = Join-Path $releaseRoot 'deploy\windows\Start-McpEdgeConnector.ps1'
    $edgeHost = Join-Path $releaseRoot 'native\McpEdgeHost.exe'
    $manifestPath = Join-Path $releaseRoot 'execution-node-manifest.json'
    foreach ($required in @($installer, $launcher, $edgeHost, $manifestPath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Candidate Edge boundary dependency is missing: $required"
        }
    }

    $privateRoot = Join-Path $env:TEMP ('mcp-edge-candidate-private-' + [guid]::NewGuid().ToString('N'))
    $connectorTokenFile = Join-Path $privateRoot 'connector-token.txt'
    $ownerTokenFile = Join-Path $privateRoot 'owner-token.txt'
    $policyPath = Join-Path $privateRoot 'policy.json'
    $connectorToken = 'c' * 64
    $ownerToken = 'o' * 64
    try {
        New-Item -ItemType Directory -Force -Path $privateRoot | Out-Null
        [IO.File]::WriteAllText($connectorTokenFile, $connectorToken, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($ownerTokenFile, $ownerToken, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($policyPath, "{}`n", [Text.UTF8Encoding]::new($false))
        $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

        $startOutput = @(& pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $launcher `
            -ReleaseRoot $releaseRoot `
            -ExpectedManifestSha256 $manifestHash `
            -RuntimeRoot $privateRoot `
            -EdgeBaseUrl 'https://mcp-access-stack.example.workers.dev' `
            -ConnectorTokenFile $connectorTokenFile `
            -OwnerTokenFile $ownerTokenFile `
            -PolicyPath $policyPath `
            -ValidateOnly 2>&1)
        if ($LASTEXITCODE -ne 0 -or $startOutput.Count -ne 1) {
            throw 'Candidate Start-McpEdgeConnector preflight failed.'
        }
        $startText = [string]$startOutput[0]
        if ($startText.Contains($connectorToken) -or $startText.Contains($ownerToken)) {
            throw 'Candidate Start-McpEdgeConnector preflight leaked a fixture secret.'
        }
        $startValidation = $startText | ConvertFrom-Json
        if ([string]$startValidation.status -ne 'validated' -or
            [string]$startValidation.executionManifestSha256 -ne $manifestHash) {
            throw 'Candidate Start-McpEdgeConnector preflight returned unexpected evidence.'
        }

        $hostArguments = @(
            '--release-root', $releaseRoot,
            '--expected-manifest-sha256', $manifestHash,
            '--runtime-root', $privateRoot,
            '--edge-base-url', 'https://mcp-access-stack.example.workers.dev',
            '--connector-token-file', $connectorTokenFile,
            '--owner-token-file', $ownerTokenFile,
            '--policy-path', $policyPath,
            '--allowed-origins', 'https://chatgpt.com,https://chat.openai.com',
            '--owner-oauth-scopes', 'workspaces:read',
            '--max-concurrent-requests', '8',
            '--restart-count', '0',
            '--restart-interval-seconds', '60',
            '--browser-enabled', 'false',
            '--validate-only'
        )
        $hostValidation = Invoke-CandidateEdgeHost -Executable $edgeHost -Arguments $hostArguments
        if ($hostValidation.exitCode -ne 0 -or $hostValidation.stdout -ne 'mcp-edge-host-contract-v1') {
            throw "Candidate McpEdgeHost preflight failed: $($hostValidation.stderr)"
        }
        if ($hostValidation.stdout.Contains($connectorToken) -or
            $hostValidation.stdout.Contains($ownerToken) -or
            $hostValidation.stderr.Contains($connectorToken) -or
            $hostValidation.stderr.Contains($ownerToken)) {
            throw 'Candidate McpEdgeHost preflight leaked a fixture secret.'
        }

        $installerArguments = @(
            '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', $installer,
            '-InstallationRoot', $CandidateStageRoot,
            '-ReleaseId', $CandidateId,
            '-RuntimeRoot', $privateRoot,
            '-EdgeBaseUrl', 'https://mcp-access-stack.example.workers.dev',
            '-ConnectorTokenFile', $connectorTokenFile,
            '-OwnerTokenFile', $ownerTokenFile,
            '-PolicyPath', $policyPath
        )
        if ($AllowUnsignedDevelopment) {
            $installerArguments += '-AllowUnsignedDevelopment'
        }
        $planOutput = @(& pwsh @installerArguments 2>&1)
        if ($LASTEXITCODE -ne 0 -or $planOutput.Count -ne 1) {
            throw 'Candidate Edge task installer plan failed.'
        }
        $planText = [string]$planOutput[0]
        if ($planText.Contains($connectorToken) -or $planText.Contains($ownerToken)) {
            throw 'Candidate Edge task installer plan leaked a fixture secret.'
        }
        $plan = $planText | ConvertFrom-Json
        if ([string]$plan.status -ne 'planned' -or
            [string]$plan.plan.execute -notmatch 'McpEdgeHost\.exe$' -or
            $plan.plan.activated -ne $false) {
            throw 'Candidate Edge task installer plan returned unexpected evidence.'
        }

        return [pscustomobject]@{
            startPreflight = [string]$startValidation.status
            hostPreflight = [string]$hostValidation.stdout
            installerPlanStatus = [string]$plan.status
            installerExecute = [string]$plan.plan.execute
            secretsLeaked = $false
        }
    }
    finally {
        if (Test-Path -LiteralPath $privateRoot) {
            Remove-Item -LiteralPath $privateRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$intact = Assert-CandidateMetadata -CandidateStageRoot $root
$qualifiedRelease = Join-Path $root "releases\$CandidateId"
$legacyLauncher = Join-Path $qualifiedRelease 'compat\McpNodeHostLauncher.exe'
$serviceCli = Join-Path $qualifiedRelease 'services\mcp-gateway\dist\edge-connector-cli.js'
$packageCli = Join-Path $qualifiedRelease 'node_modules\@vs-code-gpt\remote-mcp-gateway\dist\edge-connector-cli.js'
$edgeHost = Join-Path $qualifiedRelease 'native\McpEdgeHost.exe'
$legacyWasPresent = Test-Path -LiteralPath $legacyLauncher -PathType Leaf
$serviceCliWasPresent = Test-Path -LiteralPath $serviceCli -PathType Leaf
$stashRoot = $null
$legacyStash = $null
$serviceCliStash = $null
$result = $null
try {
    if ($SimulateLegacyLauncherLoss) {
        $stashRoot = Join-Path $env:TEMP ('mcp-edge-candidate-loss-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $stashRoot | Out-Null

        if ($legacyWasPresent) {
            $legacyStash = Join-Path $stashRoot 'McpNodeHostLauncher.exe'
            Move-Item -LiteralPath $legacyLauncher -Destination $legacyStash
        }
        if ($serviceCliWasPresent) {
            $serviceCliStash = Join-Path $stashRoot 'edge-connector-cli.js'
            Move-Item -LiteralPath $serviceCli -Destination $serviceCliStash
        }

        Assert-McpPublicReleaseAttestation `
            -ReleaseRoot $qualifiedRelease `
            -AllowUnsignedDevelopment:$AllowUnsignedDevelopment | Out-Null
    }

    $boundary = Invoke-CandidateEdgeBoundary -CandidateStageRoot $root
    $result = [pscustomobject]@{
        status = 'validated'
        candidateId = $CandidateId
        baseReleaseId = [string]$intact.manifest.edgePatch.baseReleaseId
        baseCommit = [string]$intact.manifest.edgePatch.baseCommit
        patchCommit = [string]$intact.manifest.edgePatch.patchCommit
        simulatedLegacyLoss = [bool]$SimulateLegacyLauncherLoss
        legacyLauncherPresent = (Test-Path -LiteralPath $legacyLauncher -PathType Leaf)
        serviceCliPresent = (Test-Path -LiteralPath $serviceCli -PathType Leaf)
        packageCliPresent = (Test-Path -LiteralPath $packageCli -PathType Leaf)
        edgeHostPresent = (Test-Path -LiteralPath $edgeHost -PathType Leaf)
        startPreflight = [string]$boundary.startPreflight
        hostPreflight = [string]$boundary.hostPreflight
        installerPlanStatus = [string]$boundary.installerPlanStatus
        installerExecute = [string]$boundary.installerExecute
        secretsLeaked = [bool]$boundary.secretsLeaked
    }
}
finally {
    if ($legacyStash -and (Test-Path -LiteralPath $legacyStash -PathType Leaf)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $legacyLauncher) | Out-Null
        Move-Item -LiteralPath $legacyStash -Destination $legacyLauncher
    }
    if ($serviceCliStash -and (Test-Path -LiteralPath $serviceCliStash -PathType Leaf)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $serviceCli) | Out-Null
        Move-Item -LiteralPath $serviceCliStash -Destination $serviceCli
    }
    if ($stashRoot -and (Test-Path -LiteralPath $stashRoot)) {
        Remove-Item -LiteralPath $stashRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($legacyWasPresent -and -not (Test-Path -LiteralPath $legacyLauncher -PathType Leaf)) {
    throw 'Candidate loss simulation did not restore the legacy launcher.'
}
if ($serviceCliWasPresent -and -not (Test-Path -LiteralPath $serviceCli -PathType Leaf)) {
    throw 'Candidate loss simulation did not restore the service CLI.'
}
$result | ConvertTo-Json -Compress