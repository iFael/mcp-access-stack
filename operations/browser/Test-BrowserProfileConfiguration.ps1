[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$persistentScript = Join-Path $PSScriptRoot 'Enable-PersistentBrowserProfile.ps1'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'mcp-browser-profile-test-' + [guid]::NewGuid().ToString('N')
)
$configPath = Join-Path $temporaryRoot 'gpt-only-production.json'
$dockerConfigPath = Join-Path $temporaryRoot 'docker-browser.json'
$privateDirectory = Join-Path $temporaryRoot 'browser-private'
$userDataDirectory = Join-Path $privateDirectory 'chrome-profile'

function Write-TestConfig {
    $legacyBrowser = [ordered]@{
        token = 'b' * 48
        mode = 'interactive'
        profileMode = 'extension'
        extensionTokenFile = 'legacy-extension-token.txt'
        cliSessionName = 'legacy-cli-session'
        privateDirectory = $privateDirectory
        userDataDirectory = $userDataDirectory
    }
    $config = [ordered]@{
        schemaVersion = 1
        browser = $legacyBrowser
    }
    $dockerConfig = [ordered]@{
        version = 1
        port = 3350
        token = 'b' * 48
        mode = 'interactive'
        profileMode = 'extension'
        extensionTokenFile = 'legacy-extension-token.txt'
        cliSessionName = 'legacy-cli-session'
        privateDirectory = $privateDirectory
        userDataDirectory = $userDataDirectory
    }
    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText(
        $configPath,
        ($config | ConvertTo-Json -Depth 16),
        $encoding
    )
    [System.IO.File]::WriteAllText(
        $dockerConfigPath,
        ($dockerConfig | ConvertTo-Json -Depth 16),
        $encoding
    )
}

function Invoke-TestScript {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$Arguments = @()
    )

    $global:LASTEXITCODE = 0
    $output = @(
        & pwsh -NoLogo -NoProfile -File $Path @Arguments 2>&1
    )
    return [pscustomobject]@{
        ExitCode = [int]$global:LASTEXITCODE
        Output = ($output -join [Environment]::NewLine)
    }
}

try {
    New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
    Write-TestConfig

    $migration = Invoke-TestScript -Path $persistentScript -Arguments @(
        '-ConfigurationPath', $configPath,
        '-DockerConfigurationPath', $dockerConfigPath
    )
    if ($migration.ExitCode -ne 0) {
        throw "Direct profile migration failed: $($migration.Output)"
    }

    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $dockerConfig = Get-Content -Raw -LiteralPath $dockerConfigPath | ConvertFrom-Json
    foreach ($browser in @($config.browser, $dockerConfig)) {
        if (
            [string]$browser.engine -ne 'playwright-direct' -or
            [string]$browser.profileMode -ne 'persistent' -or
            [string]$browser.browserChannel -ne 'chromium'
        ) {
            throw 'Browser configuration was not migrated to the direct persistent engine.'
        }
        if (
            $browser.PSObject.Properties['extensionTokenFile'] -or
            $browser.PSObject.Properties['cliSessionName']
        ) {
            throw 'Legacy extension or CLI configuration survived direct-engine migration.'
        }
        if ([string]$browser.userDataDirectory -ne $userDataDirectory) {
            throw 'Direct-engine migration changed the isolated profile path unexpectedly.'
        }
    }
    if ([int]$dockerConfig.version -ne 2) {
        throw 'Docker browser configuration was not upgraded to state version 2.'
    }

    $unsafeDirectory = Join-Path $temporaryRoot 'personal-chrome-profile'
    $unsafeResult = Invoke-TestScript -Path $persistentScript -Arguments @(
        '-ConfigurationPath', $configPath,
        '-DockerConfigurationPath', $dockerConfigPath,
        '-UserDataDirectory', $unsafeDirectory
    )
    if ($unsafeResult.ExitCode -eq 0) {
        throw 'Persistent profile enablement accepted a profile outside browser.privateDirectory.'
    }
    if ($unsafeResult.Output -notmatch 'must stay inside') {
        throw 'Persistent profile enablement returned an unexpected unsafe-path error.'
    }

    Write-Output 'Browser profile configuration tests passed: the direct engine is persistent, isolated and free of extension or CLI state.'
}
finally {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
