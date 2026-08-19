[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [ValidateSet('development', 'production')]
    [string]$Environment,

    [string]$TaskName,
    [string]$PersistentTaskName,
    [string]$LegacyAgentTaskName,
    [string]$LegacyBrowserTaskName,
    [switch]$EdgeOnly,
    [switch]$Execute,
    [switch]$Force,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'Execution-node cutover task installation is intentionally gated. Re-run with -Execute.'
}
if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath)) {
    throw 'Execution-node cutover task installer must run as a script file.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required cutover-task dependency is missing: $bootstrapPath"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $bootstrapPath
    if ($signature.Status -ne 'Valid' -and
        -not ($AllowUnsignedDevelopment -and $signature.Status -eq 'NotSigned')) {
        throw "Invalid Authenticode signature for $bootstrapPath. Status=$($signature.Status)"
    }
}
. $publicCommonPath
Assert-McpPublicSignature -Path $publicCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature -Path $executionCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
. $executionCommonPath
Assert-McpPublicWindowsX64

$installationRoot = [IO.Path]::GetFullPath($InstallationRoot)
$projectRoot = [IO.Path]::GetFullPath($ProjectRoot)
if ([string]::IsNullOrWhiteSpace($TaskName)) {
    $TaskName = "MCP Access Stack $Environment cutover"
}
if ([string]::IsNullOrWhiteSpace($PersistentTaskName)) { $PersistentTaskName = "MCP Access Stack $Environment host" }
if ([string]::IsNullOrWhiteSpace($LegacyAgentTaskName)) { $LegacyAgentTaskName = "MCP Access Stack Docker $Environment agent" }
if ([string]::IsNullOrWhiteSpace($LegacyBrowserTaskName)) { $LegacyBrowserTaskName = "MCP Access Stack Docker $Environment browser-worker" }
foreach ($rootPath in @($installationRoot, $projectRoot)) {
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
        throw "Execution-node cutover task root was not found: $rootPath"
    }
    if (((Get-Item -LiteralPath $rootPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Execution-node cutover task rejects reparse-point root: $rootPath"
    }
}

$controlFiles = @(
    'PublicDistribution.Common.ps1',
    'WindowsExecutionNode.Common.ps1',
    'Invoke-McpWindowsExecutionNodeTransition.ps1',
    'Install-McpWindowsExecutionNodeHostTask.ps1',
    'Invoke-McpWindowsExecutionNodeCutover.ps1',
    'Invoke-McpWindowsExecutionNodeCutoverTask.ps1',
    'Request-McpWindowsExecutionNodeCutover.ps1'
)
foreach ($name in $controlFiles) {
    $source = Join-Path $PSScriptRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Execution-node cutover control file is missing: $name"
    }
    Assert-McpPublicSignature -Path $source -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
}

$brokerSource = Join-Path $PSScriptRoot 'Invoke-McpWindowsExecutionNodeCutoverTask.ps1'
$bundleId = (Get-FileHash -LiteralPath $brokerSource -Algorithm SHA256).Hash.ToLowerInvariant().Substring(0, 16)
$controlRoot = Join-Path $installationRoot 'control'
$bundleRoot = Join-Path $controlRoot $bundleId
New-Item -ItemType Directory -Force -Path $controlRoot | Out-Null
if (((Get-Item -LiteralPath $controlRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Execution-node control root must not be a reparse point.'
}

if (-not (Test-Path -LiteralPath $bundleRoot -PathType Container)) {
    $staging = Join-Path $controlRoot ('.staging-' + $bundleId + '-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Force -Path $staging | Out-Null
        foreach ($name in $controlFiles) {
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $staging $name)
            Assert-McpPublicSignature -Path (Join-Path $staging $name) -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
            $sourceHash = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash
            $copyHash = (Get-FileHash -LiteralPath (Join-Path $staging $name) -Algorithm SHA256).Hash
            if ($sourceHash -ne $copyHash) {
                throw "Execution-node cutover control file changed while materializing: $name"
            }
        }
        [IO.Directory]::Move($staging, $bundleRoot)
        $staging = $null
    }
    finally {
        if ($staging -and (Test-Path -LiteralPath $staging)) {
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
else {
    foreach ($name in $controlFiles) {
        $source = Join-Path $PSScriptRoot $name
        $target = Join-Path $bundleRoot $name
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "Existing cutover control bundle is incomplete: $name"
        }
        Assert-McpPublicSignature -Path $target -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) {
            throw "Existing cutover control bundle does not match the requested bundle: $name"
        }
    }
}

$brokerPath = Join-Path $bundleRoot 'Invoke-McpWindowsExecutionNodeCutoverTask.ps1'
$pwsh = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
function Quote-McpCutoverTaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) { throw 'Cutover task arguments cannot contain quotes.' }
    return '"' + $Value + '"'
}
$executionPolicy = if ($AllowUnsignedDevelopment) { 'Bypass' } else { 'AllSigned' }
$arguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', $executionPolicy,
    '-File', (Quote-McpCutoverTaskArgument $brokerPath),
    '-InstallationRoot', (Quote-McpCutoverTaskArgument $installationRoot),
    '-ProjectRoot', (Quote-McpCutoverTaskArgument $projectRoot),
    '-Environment', $Environment,
    '-PersistentTaskName', (Quote-McpCutoverTaskArgument $PersistentTaskName),
    '-LegacyAgentTaskName', (Quote-McpCutoverTaskArgument $LegacyAgentTaskName),
    '-LegacyBrowserTaskName', (Quote-McpCutoverTaskArgument $LegacyBrowserTaskName)
)
if ($EdgeOnly) { $arguments += '-EdgeOnly' }
if ($AllowUnsignedDevelopment) { $arguments += '-AllowUnsignedDevelopment' }
$argumentText = $arguments -join ' '
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$alreadyInstalled = $false
if ($existing) {
    $actions = @($existing.Actions)
    $matches = $actions.Count -eq 1 -and
        [IO.Path]::GetFullPath([string]$actions[0].Execute) -eq [IO.Path]::GetFullPath($pwsh) -and
        [string]$actions[0].Arguments -eq $argumentText -and
        [string]$actions[0].WorkingDirectory -eq $bundleRoot -and
        (Test-McpWindowsAccountIdentityEquivalent -Left ([string]$existing.Principal.UserId) -Right $userId) -and
        [string]$existing.Principal.LogonType -in @('Interactive','InteractiveToken') -and
        [string]$existing.Principal.RunLevel -eq 'Limited'
    if ($matches) {
        $alreadyInstalled = $true
    }
    elseif (-not $Force) {
        throw "Scheduled Task exists with a different cutover broker contract: $TaskName"
    }
    else {
        if ([string]$existing.State -eq 'Running') {
            throw "Cutover broker Task is running and cannot be replaced: $TaskName"
        }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
}

if (-not $alreadyInstalled) {
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
        -Hidden
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $argumentText -WorkingDirectory $bundleRoot
    $task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings `
        -Description $(if ($EdgeOnly) { 'Runs Edge-only execution-node lifecycle cutover without recreating McpHost.' } else { 'Runs execution-node ownership cutover independently from the Workspace Agent being replaced.' })
    Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null
}

[pscustomobject]@{
    status = if ($alreadyInstalled) { 'already-installed' } else { 'installed' }
    changed = -not $alreadyInstalled
    taskName = $TaskName
    bundleId = $bundleId
    brokerPath = $brokerPath
    independentOwner = $true
    edgeOnly = [bool]$EdgeOnly
} | ConvertTo-Json -Compress
