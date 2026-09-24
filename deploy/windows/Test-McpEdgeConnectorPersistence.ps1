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
    'ProjectRoot',
    'VS_CODE_GPT_STACK_ROOT',
    "'edge-connector'",
    "'edge-validation-launcher'",
    "'node-runtime'",
    "BROWSER_WORKER_ENABLED = 'false'",
    'EnableBrowserWorker',
    'BrowserWorkerTokenFile',
    'BROWSER_WORKER_URL',
    'OWNER_OAUTH_STATE_PATH',
    'MCP_SESSION_MODE',
    'McpSessionMode',
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
    'McpEdgeHost.exe',
    "'--restart-count', '5'",
    'ProjectRoot',
    '--project-root',
    '--connector-token-file',
    '--owner-token-file',
    '--mcp-session-mode',
    '--browser-worker-token-file',
    '--browser-enabled',
    'EnableBrowserWorker',
    'edge-host',
    'processSubsystem',
    'Assert-McpPublicSignature -Path $edgeHostPath',
    'Assert-McpPublicReleaseAttestation',
    'executionNode.manifestSha256',
    '--validate-only',
    'ValidateOnly',
    'ProcessStartInfo',
    'WaitForExit()'
)) {
    if (-not $installerContent.Contains($required)) {
        throw "Edge Connector task installer contract is missing: $required"
    }
}
if ($installerContent -match 'OWNER_TOKEN\s*=\s*["''][^$]') {
    throw 'Edge Connector task installer must not embed an Owner token value.'
}
foreach ($forbidden in @("'--env'", "'--env-file'", 'BROWSER_WORKER_TOKEN=', 'OWNER_TOKEN=', 'Assert-McpWindowsExecutionNodeRelease', '@(& $edgeHostPath')) {
    if ($installerContent.Contains($forbidden)) {
        throw "Edge Connector fixed host installer must not use generic environment injection: $forbidden"
    }
}

$fixtureRoot = Join-Path $env:TEMP ('mcp-edge-persistence-' + [guid]::NewGuid().ToString('N'))
$projectRoot = Join-Path $fixtureRoot 'project'
$releaseRoot = Join-Path $fixtureRoot 'release'
$runtimeRoot = Join-Path $fixtureRoot 'private-runtime'
$launcher = Join-Path $releaseRoot 'deploy\windows\Start-McpEdgeConnector.ps1'
$edgeCli = Join-Path $releaseRoot 'node_modules\@vs-code-gpt\remote-mcp-gateway\dist\edge-connector-cli.js'
$nodePath = Join-Path $releaseRoot 'runtime\node\node.exe'
$edgeHost = Join-Path $releaseRoot 'native\McpEdgeHost.exe'
$browserServer = Join-Path $releaseRoot 'services\browser-worker\dist\server.js'
$browserLauncher = Join-Path $releaseRoot 'compat\McpNodeHostLauncher.exe'
$browserBroker = Join-Path $releaseRoot 'compat\McpCredentialBroker.exe'
$connectorTokenFile = Join-Path $runtimeRoot 'connector-token.txt'
$ownerTokenFile = Join-Path $runtimeRoot 'owner-token.txt'
$browserTokenFile = Join-Path $runtimeRoot 'browser-token.txt'
$policyPath = Join-Path $runtimeRoot 'policy.json'
$connectorToken = 'c' * 64
$ownerToken = 'o' * 64
$browserToken = 'b' * 64

try {
    New-Item -ItemType Directory -Force -Path `
        (Split-Path -Parent $launcher), `
        (Split-Path -Parent $edgeCli), `
        (Split-Path -Parent $nodePath), `
        (Split-Path -Parent $edgeHost), `
        (Split-Path -Parent $browserServer), `
        (Split-Path -Parent $browserLauncher), `
        $runtimeRoot, `
        $projectRoot | Out-Null
    Copy-Item -LiteralPath $launcherSource -Destination $launcher
    [IO.File]::WriteAllText($edgeCli, "console.log('edge-fixture');`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($nodePath, 'node-fixture', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($edgeHost, 'edge-host-fixture', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($browserServer, 'browser-fixture', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($browserLauncher, 'browser-launcher-fixture', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($browserBroker, 'browser-broker-fixture', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($connectorTokenFile, $connectorToken, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($ownerTokenFile, $ownerToken, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($browserTokenFile, $browserToken, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($policyPath, "{}`n", [Text.UTF8Encoding]::new($false))

    function New-FixtureArtifact {
        param([string]$Id, [string]$Owner, [string]$Path, [string]$RelativePath, [bool]$AuthenticodeRequired)
        $item = Get-Item -LiteralPath $Path
        return [ordered]@{
            id = $Id
            owner = $Owner
            path = $RelativePath
            sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
            sizeBytes = [long]$item.Length
            authenticodeRequired = $AuthenticodeRequired
        }
    }

    $manifest = [ordered]@{
        version = 2
        releaseId = 'edge-fixture'
        commit = ('a' * 40)
        platform = 'win32-x64'
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        runtimeMode = 'bundled-node'
        integrityRoot = 'signed-distribution-manifest'
        services = @(
            [ordered]@{ id = 'edge-runtime'; entryArtifactId = 'edge-host' },
            [ordered]@{ id = 'browser-worker'; entryArtifactId = 'browser-native-launcher' }
        )
        artifacts = @(
            (New-FixtureArtifact -Id 'edge-host' -Owner 'edge-runtime' -Path $edgeHost -RelativePath 'native/McpEdgeHost.exe' -AuthenticodeRequired $true),
            (New-FixtureArtifact -Id 'edge-connector' -Owner 'edge-runtime' -Path $edgeCli -RelativePath 'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js' -AuthenticodeRequired $false),
            (New-FixtureArtifact -Id 'edge-validation-launcher' -Owner 'edge-runtime' -Path $launcher -RelativePath 'deploy/windows/Start-McpEdgeConnector.ps1' -AuthenticodeRequired $true),
            (New-FixtureArtifact -Id 'browser-worker-server' -Owner 'browser-worker' -Path $browserServer -RelativePath 'services/browser-worker/dist/server.js' -AuthenticodeRequired $false),
            (New-FixtureArtifact -Id 'browser-native-launcher' -Owner 'browser-worker' -Path $browserLauncher -RelativePath 'compat/McpNodeHostLauncher.exe' -AuthenticodeRequired $true),
            (New-FixtureArtifact -Id 'browser-credential-broker' -Owner 'browser-worker' -Path $browserBroker -RelativePath 'compat/McpCredentialBroker.exe' -AuthenticodeRequired $true),
            (New-FixtureArtifact -Id 'node-runtime' -Owner 'shared' -Path $nodePath -RelativePath 'runtime/node/node.exe' -AuthenticodeRequired $false)
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
        '-ProjectRoot', $projectRoot,
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
    $expectedProjectRoot = [IO.Path]::GetFullPath((Get-Item -LiteralPath $projectRoot).FullName)
    $observedProjectRoot = [IO.Path]::GetFullPath((Get-Item -LiteralPath ([string]$validation.projectRoot)).FullName)
    if ([string]$validation.status -ne 'validated' -or
        -not $observedProjectRoot.Equals($expectedProjectRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$validation.executionManifestSha256 -ne $manifestHash -or
        [string]$validation.mcpSessionMode -ne 'stateless' -or
        $validation.browserEnabled -ne $false) {
        throw 'Edge Connector launcher returned unexpected validation evidence.'
    }

    $statefulValidateArgs = @($validateArgs[0..($validateArgs.Count - 2)]) + @(
        '-McpSessionMode', 'stateful-experiment',
        '-ValidateOnly'
    )
    $statefulValidationOutput = @(& pwsh @statefulValidateArgs 2>&1)
    if ($LASTEXITCODE -ne 0 -or $statefulValidationOutput.Count -ne 1) {
        throw 'Edge Connector stateful launcher fixture validation failed.'
    }
    $statefulValidation = [string]$statefulValidationOutput[0] | ConvertFrom-Json
    if ([string]$statefulValidation.status -ne 'validated' -or
        [string]$statefulValidation.mcpSessionMode -ne 'stateful-experiment') {
        throw 'Edge Connector stateful launcher returned unexpected validation evidence.'
    }
    $enabledValidateArgs = @($validateArgs[0..($validateArgs.Count - 2)]) + @(
        '-EnableBrowserWorker',
        '-BrowserWorkerUrl', 'http://127.0.0.1:3350',
        '-BrowserWorkerTokenFile', $browserTokenFile,
        '-ValidateOnly'
    )
    $enabledValidationOutput = @(& pwsh @enabledValidateArgs 2>&1)
    if ($LASTEXITCODE -ne 0 -or $enabledValidationOutput.Count -ne 1) {
        throw 'Edge Connector browser-enabled launcher fixture validation failed.'
    }
    $enabledValidationText = [string]$enabledValidationOutput[0]
    if ($enabledValidationText.Contains($connectorToken) -or
        $enabledValidationText.Contains($ownerToken) -or
        $enabledValidationText.Contains($browserToken)) {
        throw 'Edge Connector browser-enabled validation leaked a fixture secret.'
    }
    $enabledValidation = $enabledValidationText | ConvertFrom-Json
    if ([string]$enabledValidation.status -ne 'validated' -or
        [string]$enabledValidation.executionManifestSha256 -ne $manifestHash -or
        $enabledValidation.browserEnabled -ne $true -or
        [string]$enabledValidation.browserWorkerUrl -ne 'http://127.0.0.1:3350') {
        throw 'Edge Connector browser-enabled launcher returned unexpected validation evidence.'
    }

    $planOutput = @(& pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer `
        -InstallationRoot (Join-Path $fixtureRoot 'installation') `
        -ProjectRoot $projectRoot `
        -ReleaseId 'edge-fixture' `
        -RuntimeRoot $runtimeRoot `
        -EdgeBaseUrl 'https://mcp-access-stack.example.workers.dev' `
        -ConnectorTokenFile $connectorTokenFile `
        -OwnerTokenFile $ownerTokenFile `
        -PolicyPath $policyPath `
        -EnableBrowserWorker `
        -BrowserWorkerUrl 'http://127.0.0.1:3350' `
        -BrowserWorkerTokenFile $browserTokenFile 2>&1)
    if ($LASTEXITCODE -ne 0 -or $planOutput.Count -ne 1) {
        $diagnostic = ($planOutput -join [Environment]::NewLine)
        foreach ($secret in @($connectorToken, $ownerToken, $browserToken)) {
            $diagnostic = $diagnostic.Replace($secret, '<redacted>')
        }
        throw "Edge Connector task installer plan smoke failed. exit=$LASTEXITCODE count=$($planOutput.Count) diagnostic=$diagnostic"
    }
    $planText = [string]$planOutput[0]
    if ($planText.Contains($connectorToken) -or $planText.Contains($ownerToken) -or $planText.Contains($browserToken)) {
        throw 'Edge Connector task installer leaked a fixture secret.'
    }
    $plan = $planText | ConvertFrom-Json
    $observedPlanProjectRoot = [IO.Path]::GetFullPath((Get-Item -LiteralPath ([string]$plan.plan.projectRoot)).FullName)
    if ([string]$plan.status -ne 'planned' -or
        -not $observedPlanProjectRoot.Equals($expectedProjectRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$plan.plan.multipleInstances -ne 'IgnoreNew' -or
        [string]$plan.plan.runLevel -ne 'Limited' -or
        [string]$plan.plan.processSubsystem -ne 'windows-gui' -or
        [string]$plan.plan.mcpSessionMode -ne 'stateless' -or
        $plan.plan.browserEnabled -ne $true -or
        [string]$plan.plan.browserWorkerUrl -ne 'http://127.0.0.1:3350' -or
        $plan.plan.consoleAttached -ne $false -or
        [string]$plan.plan.execute -notmatch 'McpEdgeHost\.exe$' -or
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
