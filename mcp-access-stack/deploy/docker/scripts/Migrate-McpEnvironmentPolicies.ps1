[CmdletBinding()]
param(
    [ValidateSet('development', 'production', 'all')]
    [string]$Environment = 'all',

    [switch]$Execute
)

. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Get-McpProjectRoot
$timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
$backupDirectory = Join-Path $root "runtime\policy-migration\$timestamp"
$targets = if ($Environment -eq 'all') {
    @('development', 'production')
}
else {
    @($Environment)
}

function Get-EnvironmentDescriptor {
    param([Parameter(Mandatory = $true)][string]$Name)

    if ($Name -eq 'development') {
        return [pscustomobject]@{
            name = 'development'
            runtimeEnvironmentId = 'development'
            configurationDirectoryName = 'development'
        }
    }
    return [pscustomobject]@{
        name = 'production'
        runtimeEnvironmentId = 'production'
        configurationDirectoryName = 'production'
    }
}

$plans = @()
foreach ($target in $targets) {
    $descriptor = Get-EnvironmentDescriptor -Name $target
    $configurationPath = Join-Path $root ".runtime-private\docker\$($descriptor.configurationDirectoryName)\agent.json"
    if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
        $plans += [pscustomobject]@{
            environment = $descriptor.name
            runtimeEnvironmentId = $descriptor.runtimeEnvironmentId
            status = 'configuration-missing'
            configurationPath = $configurationPath
            currentPolicyPath = $null
            targetPolicyDirectory = Get-McpEnvironmentPolicyDirectory -Environment $descriptor.runtimeEnvironmentId
        }
        continue
    }

    $configuration = Read-McpJsonFile -Path $configurationPath
    $currentPolicyPath = [string]$configuration.policyPath
    if ([string]::IsNullOrWhiteSpace($currentPolicyPath)) {
        throw "Environment agent configuration has no policyPath: $($descriptor.name)"
    }

    $targetPolicyDirectory = Get-McpEnvironmentPolicyDirectory -Environment $descriptor.runtimeEnvironmentId
    $targetPolicyPath = Join-Path $targetPolicyDirectory 'policy.json'
    $alreadyMigrated = [System.IO.Path]::GetFullPath($currentPolicyPath).Equals(
        [System.IO.Path]::GetFullPath($targetPolicyPath),
        [StringComparison]::OrdinalIgnoreCase
    )

    $plans += [pscustomobject]@{
        environment = $descriptor.name
        runtimeEnvironmentId = $descriptor.runtimeEnvironmentId
        status = if ($alreadyMigrated) { 'already-migrated' } else { 'migration-required' }
        configurationPath = $configurationPath
        currentPolicyPath = $currentPolicyPath
        targetPolicyDirectory = $targetPolicyDirectory
    }
}

if (-not $Execute) {
    [pscustomobject]@{
        status = 'dry-run'
        executeRequired = $true
        environments = $plans
    } | ConvertTo-Json -Depth 6
    return
}

New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
$results = @()
foreach ($plan in $plans) {
    if ($plan.status -eq 'configuration-missing') {
        $results += $plan
        continue
    }
    if ($plan.status -eq 'already-migrated') {
        $results += $plan
        continue
    }

    $configurationPath = [string]$plan.configurationPath
    $backupPath = Join-Path $backupDirectory ("$($plan.environment).agent.before.json")
    Copy-Item -LiteralPath $configurationPath -Destination $backupPath
    $productionSourceConfigPath = if ($plan.environment -eq 'production') {
        Join-Path $root '.runtime-private\gpt-only-production.json'
    }
    else { $null }
    $productionSourceBackupPath = $null
    if ($productionSourceConfigPath -and (Test-Path -LiteralPath $productionSourceConfigPath -PathType Leaf)) {
        $productionSourceBackupPath = Join-Path $backupDirectory 'gpt-only-production.before.json'
        Copy-Item -LiteralPath $productionSourceConfigPath -Destination $productionSourceBackupPath
    }

    try {
        $configuration = Read-McpJsonFile -Path $configurationPath
        $snapshot = Install-McpEnvironmentPolicySnapshot `
            -Environment ([string]$plan.runtimeEnvironmentId) `
            -SourcePolicyPath ([string]$plan.currentPolicyPath)

        Set-McpObjectProperty -InputObject $configuration -Name 'policyPath' -Value ([string]$snapshot.policyPath)
        Set-McpObjectProperty -InputObject $configuration -Name 'policyEnvironment' -Value ([string]$snapshot.environment)
        Set-McpObjectProperty -InputObject $configuration -Name 'policySha256' -Value ([string]$snapshot.policySha256)
        Set-McpObjectProperty -InputObject $configuration -Name 'policyManifestPath' -Value ([string]$snapshot.manifestPath)
        Write-McpJsonFile -Path $configurationPath -Value $configuration

        if ($productionSourceConfigPath -and (Test-Path -LiteralPath $productionSourceConfigPath -PathType Leaf)) {
            $productionSourceConfig = Read-McpJsonFile -Path $productionSourceConfigPath
            Set-McpObjectProperty `
                -InputObject $productionSourceConfig.gpt `
                -Name 'policy' `
                -Value ([string]$snapshot.policyPath)
            Write-McpJsonFile -Path $productionSourceConfigPath -Value $productionSourceConfig
        }

        $written = Read-McpJsonFile -Path $configurationPath
        if ([string]$written.policyPath -ne [string]$snapshot.policyPath) {
            throw 'Environment agent configuration did not persist the migrated policyPath.'
        }

        $results += [pscustomobject]@{
            environment = $plan.environment
            runtimeEnvironmentId = $plan.runtimeEnvironmentId
            status = 'migrated-restart-required'
            workspaceCount = [int]$snapshot.workspaceCount
            policySha256 = [string]$snapshot.policySha256
            policyPath = [string]$snapshot.policyPath
            policyManifestPath = [string]$snapshot.manifestPath
            configurationBackup = $backupPath
        }
    }
    catch {
        Copy-Item -LiteralPath $backupPath -Destination $configurationPath -Force
        if ($productionSourceBackupPath) {
            Copy-Item `
                -LiteralPath $productionSourceBackupPath `
                -Destination $productionSourceConfigPath `
                -Force
        }
        throw "Environment policy migration failed for $($plan.environment) and configuration was restored: $($_.Exception.Message)"
    }
}

[pscustomobject]@{
    status = 'migrated'
    restartPerformed = $false
    backupDirectory = $backupDirectory
    environments = $results
} | ConvertTo-Json -Depth 8
