[CmdletBinding()]
param()

$scriptPath = Join-Path $PSScriptRoot 'Set-QualifiedCommandRollout.ps1'
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("mcp-qualified-rollout-" + [Guid]::NewGuid().ToString('N'))
$configDirectory = Join-Path $root '.runtime-private\docker\development'
$configPath = Join-Path $configDirectory 'agent.json'
$brokerPath = Join-Path $root 'McpCredentialBroker.exe'

function Assert-WorkspaceAllowlist {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Config,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$Expected
    )

    $property = $Config.qualifiedCommand.PSObject.Properties['workspaceAllowlist']
    if (-not $property) {
        throw 'Workspace allowlist property is missing.'
    }
    if ($null -eq $property.Value -or -not ($property.Value -is [System.Array])) {
        throw 'Workspace allowlist must be serialized as a JSON array.'
    }

    $actual = @($property.Value | ForEach-Object { [string]$_ })
    if ($actual.Count -ne $Expected.Count) {
        throw "Workspace allowlist count mismatch: expected=$($Expected.Count) actual=$($actual.Count)"
    }
    for ($index = 0; $index -lt $Expected.Count; $index += 1) {
        if ($actual[$index] -ne $Expected[$index]) {
            throw "Workspace allowlist mismatch at index ${index}: expected=$($Expected[$index]) actual=$($actual[$index])"
        }
    }
}

try {
    New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
    [System.IO.File]::WriteAllText($brokerPath, 'fixture')
    [System.IO.File]::WriteAllText(
        $configPath,
        '{"version":1,"agentId":"fixture","qualifiedCommand":{}}',
        [System.Text.UTF8Encoding]::new($false)
    )

    & $scriptPath -Environment development -Mode Shadow -WorkspaceId project -ProjectRoot $root -ConfigurationPath $configPath | Out-Null
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not $config.qualifiedCommand.shadowMode -or $config.qualifiedCommand.qualifiedExecution) {
        throw 'Shadow rollout state is invalid.'
    }
    Assert-WorkspaceAllowlist -Config $config -Expected @('project')

    & $scriptPath -Environment development -Mode Qualified -WorkspaceId project, legacySite, project -ProjectRoot $root -ConfigurationPath $configPath | Out-Null
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not $config.qualifiedCommand.qualifiedExecution -or $config.qualifiedCommand.safeAutoCorrection) {
        throw 'Qualified rollout state is invalid.'
    }
    Assert-WorkspaceAllowlist -Config $config -Expected @('legacySite', 'project')

    & $scriptPath -Environment development -Mode Autocorrection -WorkspaceId project -ProjectRoot $root -ConfigurationPath $configPath | Out-Null
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not $config.qualifiedCommand.safeAutoCorrection -or $config.qualifiedCommand.providerEnabled) {
        throw 'Autocorrection rollout state is invalid.'
    }
    Assert-WorkspaceAllowlist -Config $config -Expected @('project')

    & $scriptPath -Environment development -Mode Provider -WorkspaceId project -ProviderModel gpt-5-mini -ProviderBrokerPath $brokerPath -ProjectRoot $root -ConfigurationPath $configPath | Out-Null
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not $config.qualifiedCommand.providerEnabled -or $config.qualifiedCommand.providerModel -ne 'gpt-5-mini') {
        throw 'Provider rollout state is invalid.'
    }
    Assert-WorkspaceAllowlist -Config $config -Expected @('project')

    & $scriptPath -Environment development -Mode Disabled -ProjectRoot $root -ConfigurationPath $configPath | Out-Null
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.qualifiedCommand.qualifiedExecution -or
        $config.qualifiedCommand.safeAutoCorrection -or
        $config.qualifiedCommand.shadowMode -or
        $config.qualifiedCommand.providerEnabled) {
        throw 'Disabled rollout state is invalid.'
    }
    Assert-WorkspaceAllowlist -Config $config -Expected @()

    $backups = @(Get-ChildItem -LiteralPath $configDirectory -Filter 'agent.json.qualified-command.*.bak')
    if ($backups.Count -lt 5) {
        throw 'Rollout changes did not preserve configuration backups.'
    }

    $failed = $false
    try {
        & $scriptPath -Environment development -Mode Shadow -ProjectRoot $root -ConfigurationPath $configPath | Out-Null
    }
    catch {
        $failed = $true
    }
    if (-not $failed) {
        throw 'Enabled rollout without an allowlist was not rejected.'
    }

    Write-Output 'Qualified command rollout tests passed: JSON array allowlists, modes, provider configuration and backups are enforced.'
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
