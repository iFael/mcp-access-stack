[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$installer = Join-Path $PSScriptRoot 'Install-McpBrowserWorkerTask.ps1'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Browser Worker persistence test dependency is missing: $installer"
}

$content = Get-Content -LiteralPath $installer -Raw
foreach ($required in @(
    'MCP Access Stack production browser-worker',
    "Role 'browser-worker'",
    "Role 'node-runtime'",
    "Role 'edge-native-launcher'",

    '--env-file',
    'BROWSER_WORKER_TOKEN=',
    'BROWSER_WORKER_PROFILE_MODE=persistent',
    "profile = 'dedicated-persistent'",
    'BROWSER_WORKER_USER_DATA_DIR=',
    'BROWSER_WORKER_SITE_POLICIES_PATH=',
    'BROWSER_WORKER_CREDENTIAL_BROKER_PATH=',
    'New-ScheduledTaskTrigger -AtLogOn',
    '-MultipleInstances IgnoreNew',
    '-RunLevel Limited'
)) {
    if (-not $content.Contains($required)) {
        throw "Browser Worker task installer contract is missing: $required"
    }
}
if ($content -match 'BROWSER_WORKER_TOKEN\s*=\s*["''][^$]') {
    throw 'Browser Worker task installer must not embed a Browser Worker token value.'
}

$fixtureRoot = Join-Path $env:TEMP ('mcp-browser-persistence-' + [guid]::NewGuid().ToString('N'))
$installationRoot = Join-Path $fixtureRoot 'installation'
$runtimeRoot = Join-Path $fixtureRoot 'runtime'
$privateRoot = Join-Path $fixtureRoot 'private'
$userDataRoot = Join-Path $privateRoot 'chrome-profile'
$tokenFile = Join-Path $runtimeRoot 'browser-token.txt'
$sitePolicies = Join-Path $privateRoot 'site-policies.json'
$fixtureToken = 'b' * 64

try {
    New-Item -ItemType Directory -Force -Path $installationRoot, $runtimeRoot, $privateRoot, $userDataRoot | Out-Null
    [IO.File]::WriteAllText($tokenFile, $fixtureToken, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($sitePolicies, "[]`n", [Text.UTF8Encoding]::new($false))

    $planOutput = @(& pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer `
        -InstallationRoot $installationRoot `
        -ReleaseId 'browser-fixture' `
        -RuntimeRoot $runtimeRoot `
        -BrowserTokenFile $tokenFile `
        -PrivateDirectory $privateRoot `
        -UserDataDirectory $userDataRoot `
        -SitePoliciesPath $sitePolicies 2>&1)
    if ($LASTEXITCODE -ne 0 -or $planOutput.Count -ne 1) {
        throw 'Browser Worker task installer plan smoke failed.'
    }
    $planText = [string]$planOutput[0]
    if ($planText.Contains($fixtureToken)) {
        throw 'Browser Worker task installer leaked a fixture secret.'
    }
    $plan = $planText | ConvertFrom-Json
    if ([string]$plan.status -ne 'planned' -or
        [string]$plan.plan.taskName -ne 'MCP Access Stack production browser-worker' -or
        [string]$plan.plan.profile -ne 'dedicated-persistent' -or
        [string]$plan.plan.mode -ne 'interactive' -or
        [int]$plan.plan.port -ne 3350 -or
        [string]$plan.plan.multipleInstances -ne 'IgnoreNew' -or
        [string]$plan.plan.runLevel -ne 'Limited' -or
        [string]$plan.plan.processSubsystem -ne 'windows-gui' -or
        $plan.plan.consoleAttached -ne $false -or
        $plan.plan.activated -ne $false) {
        throw 'Browser Worker task installer returned an unexpected plan.'
    }

    $outsideToken = Join-Path $fixtureRoot 'outside-browser-token.txt'
    [IO.File]::WriteAllText($outsideToken, $fixtureToken, [Text.UTF8Encoding]::new($false))
    $invalidTokenOutput = @(& pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer `
        -InstallationRoot $installationRoot `
        -ReleaseId 'browser-fixture' `
        -RuntimeRoot $runtimeRoot `
        -BrowserTokenFile $outsideToken `
        -PrivateDirectory $privateRoot `
        -UserDataDirectory $userDataRoot `
        -SitePoliciesPath $sitePolicies 2>&1)
    if ($LASTEXITCODE -eq 0 -or
        -not (($invalidTokenOutput -join [Environment]::NewLine).Contains('token file must stay inside its runtime directory'))) {
        throw 'Browser Worker task installer did not fail closed for a token outside runtime storage.'
    }

    $outsidePolicies = Join-Path $fixtureRoot 'outside-site-policies.json'
    [IO.File]::WriteAllText($outsidePolicies, "[]`n", [Text.UTF8Encoding]::new($false))
    $invalidPoliciesOutput = @(& pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer `
        -InstallationRoot $installationRoot `
        -ReleaseId 'browser-fixture' `
        -RuntimeRoot $runtimeRoot `
        -BrowserTokenFile $tokenFile `
        -PrivateDirectory $privateRoot `
        -UserDataDirectory $userDataRoot `
        -SitePoliciesPath $outsidePolicies 2>&1)
    if ($LASTEXITCODE -eq 0 -or
        -not (($invalidPoliciesOutput -join [Environment]::NewLine).Contains('site policies must stay inside its private directory'))) {
        throw 'Browser Worker task installer did not fail closed for site policies outside private storage.'
    }
    $outsideUserData = Join-Path $fixtureRoot 'outside-profile'
    New-Item -ItemType Directory -Force -Path $outsideUserData | Out-Null
    $invalidOutput = @(& pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer `
        -InstallationRoot $installationRoot `
        -ReleaseId 'browser-fixture' `
        -RuntimeRoot $runtimeRoot `
        -BrowserTokenFile $tokenFile `
        -PrivateDirectory $privateRoot `
        -UserDataDirectory $outsideUserData `
        -SitePoliciesPath $sitePolicies 2>&1)
    if ($LASTEXITCODE -eq 0) {
        throw 'Browser Worker task installer accepted user-data outside the private directory.'
    }
    $invalidText = $invalidOutput -join [Environment]::NewLine
    if (-not $invalidText.Contains('user-data directory must stay inside its private directory')) {
        throw 'Browser Worker task installer did not fail closed for an invalid persistent profile path.'
    }
    if ($invalidText.Contains($fixtureToken)) {
        throw 'Browser Worker task installer leaked a fixture secret on failure.'
    }
}
finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}

Write-Output 'Browser Worker persistence contract passed.'
