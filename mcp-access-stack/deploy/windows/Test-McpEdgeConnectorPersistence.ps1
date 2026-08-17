[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcherSource = Join-Path $PSScriptRoot 'Start-McpEdgeConnector.ps1'
$installer = Join-Path $PSScriptRoot 'Install-McpEdgeConnectorTask.ps1'
foreach ($required in @($launcherSource, $installer)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Edge Connector persistence test dependency is missing: $required"
    }
}

$launcherContent = Get-Content -LiteralPath $launcherSource -Raw
$installerContent = Get-Content -LiteralPath $installer -Raw
foreach ($required in @(
    'ExpectedManifestSha256',
    "Role 'edge-connector'",
    "Role 'edge-connector-launcher'",
    "Role 'node-runtime'",
    "BROWSER_WORKER_ENABLED = 'false'",
    'OWNER_OAUTH_STATE_PATH',
    'OWNER_TOKEN = $ownerToken',
    'ValidateOnly'
)) {
    if (-not $launcherContent.Contains($required)) {
        throw "Edge Connector launcher contract is missing: $required"
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
    if (-not $installerContent.Contains($required)) {
        throw "Edge Connector task installer contract is missing: $required"
    }
}
if ($installerContent -match 'OWNER_TOKEN\s*=\s*["''][^$]') {
    throw 'Edge Connector task installer must not embed an Owner token value.'
}

$fixtureRoot = Join-Path $env:TEMP ('mcp-edge-persistence-' + [guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $fixtureRoot 'release'
$runtimeRoot = Join-Path $fixtureRoot 'private-runtime'
$launcher = Join-Path $releaseRoot 'deploy\windows\Start-McpEdgeConnector.ps1'
$edgeCli = Join-Path $releaseRoot 'services\mcp-gateway\dist\edge-connector-cli.js'
$nodePath = Join-Path $releaseRoot 'runtime\node\node.exe'
$connectorTokenFile = Join-Path $runtimeRoot 'connector-token.txt'
$ownerTokenFile = Join-Path $runtimeRoot 'owner-token.txt'
$policyPath = Join-Path $runtimeRoot 'policy.json'
$connectorToken = 'c' * 64
$ownerToken = 'o' * 64

try {
    New-Item -ItemType Directory -Force -Path `
        (Split-Path -Parent $launcher), `
        (Split-Path -Parent $edgeCli), `
        (Split-Path -Parent $nodePath), `
        $runtimeRoot | Out-Null
    Copy-Item -LiteralPath $launcherSource -Destination $launcher
    [IO.File]::WriteAllText($edgeCli, "console.log('edge-fixture');`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($nodePath, 'node-fixture', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($connectorTokenFile, $connectorToken, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($ownerTokenFile, $ownerToken, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($policyPath, "{}`n", [Text.UTF8Encoding]::new($false))

    function New-FixtureArtifact {
        param([string]$Role, [string]$Path, [string]$RelativePath, [bool]$AuthenticodeRequired)
        $item = Get-Item -LiteralPath $Path
        return [ordered]@{
            role = $Role
            path = $RelativePath
            sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
            sizeBytes = [long]$item.Length
            authenticodeRequired = $AuthenticodeRequired
        }
    }

    $manifest = [ordered]@{
        version = 1
        releaseId = 'edge-fixture'
        commit = ('a' * 40)
        platform = 'win32-x64'
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        runtimeMode = 'bundled-node'
        integrityRoot = 'signed-distribution-manifest'
        artifacts = @(
            (New-FixtureArtifact -Role 'edge-connector' -Path $edgeCli -RelativePath 'services/mcp-gateway/dist/edge-connector-cli.js' -AuthenticodeRequired $false),
            (New-FixtureArtifact -Role 'edge-connector-launcher' -Path $launcher -RelativePath 'deploy/windows/Start-McpEdgeConnector.ps1' -AuthenticodeRequired $true),
            (New-FixtureArtifact -Role 'node-runtime' -Path $nodePath -RelativePath 'runtime/node/node.exe' -AuthenticodeRequired $false)
        )
    }
    $manifestPath = Join-Path $releaseRoot 'execution-node-manifest.json'
    [IO.File]::WriteAllText(
        $manifestPath,
        (($manifest | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
    $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $validateArgs = @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', $launcher,
        '-ReleaseRoot', $releaseRoot,
        '-ExpectedManifestSha256', $manifestHash,
        '-RuntimeRoot', $runtimeRoot,
        '-EdgeBaseUrl', 'https://mcp-access-stack.example.workers.dev',
        '-ConnectorTokenFile', $connectorTokenFile,
        '-OwnerTokenFile', $ownerTokenFile,
        '-PolicyPath', $policyPath,
        '-ValidateOnly'
    )
    $validationOutput = @(& pwsh @validateArgs 2>&1)
    if ($LASTEXITCODE -ne 0 -or $validationOutput.Count -ne 1) {
        throw 'Edge Connector launcher fixture validation failed.'
    }
    $validationText = [string]$validationOutput[0]
    if ($validationText.Contains($connectorToken) -or $validationText.Contains($ownerToken)) {
        throw 'Edge Connector launcher leaked a fixture secret.'
    }
    $validation = $validationText | ConvertFrom-Json
    if ([string]$validation.status -ne 'validated' -or
        [string]$validation.executionManifestSha256 -ne $manifestHash -or
        $validation.browserEnabled -ne $false) {
        throw 'Edge Connector launcher returned unexpected validation evidence.'
    }

    $planOutput = @(& pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer `
        -InstallationRoot (Join-Path $fixtureRoot 'installation') `
        -ReleaseId 'edge-fixture' `
        -RuntimeRoot $runtimeRoot `
        -EdgeBaseUrl 'https://mcp-access-stack.example.workers.dev' `
        -ConnectorTokenFile $connectorTokenFile `
        -OwnerTokenFile $ownerTokenFile `
        -PolicyPath $policyPath 2>&1)
    if ($LASTEXITCODE -ne 0 -or $planOutput.Count -ne 1) {
        throw 'Edge Connector task installer plan smoke failed.'
    }
    $planText = [string]$planOutput[0]
    if ($planText.Contains($connectorToken) -or $planText.Contains($ownerToken)) {
        throw 'Edge Connector task installer leaked a fixture secret.'
    }
    $plan = $planText | ConvertFrom-Json
    if ([string]$plan.status -ne 'planned' -or
        [string]$plan.plan.multipleInstances -ne 'IgnoreNew' -or
        [string]$plan.plan.runLevel -ne 'Limited' -or
        $plan.plan.activated -ne $false) {
        throw 'Edge Connector task installer returned an unexpected plan.'
    }

    [IO.File]::AppendAllText($edgeCli, '//tampered', [Text.Encoding]::UTF8)
    $tamperedOutput = @(& pwsh @validateArgs 2>&1)
    if ($LASTEXITCODE -eq 0) {
        throw 'Edge Connector launcher accepted a tampered runtime artifact.'
    }
    $tamperedText = $tamperedOutput -join [Environment]::NewLine
    if (-not $tamperedText.Contains('artifact size mismatch') -and
        -not $tamperedText.Contains('artifact hash mismatch')) {
        throw 'Edge Connector launcher tamper failure did not identify artifact integrity.'
    }
    if ($tamperedText.Contains($connectorToken) -or $tamperedText.Contains($ownerToken)) {
        throw 'Edge Connector launcher leaked a fixture secret on failure.'
    }
}
finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}

Write-Output 'Edge Connector persistence contract passed.'