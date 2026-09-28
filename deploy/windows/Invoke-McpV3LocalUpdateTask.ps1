[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationRoot,

    [Parameter(Mandatory = $true)]
    [string]$StateRoot,

    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'iFael/mcp-access-stack',

    [string]$CompanionTaskName = 'MCP V3 local companion',
    [string]$UpdaterTaskName = 'MCP V3 local updater',

    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'MCP V3 local updater task runner is intentionally gated. Re-run with -Execute.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required MCP V3 updater runner dependency is missing: $bootstrapPath"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $bootstrapPath
    if ($signature.Status -ne 'Valid' -and -not ($AllowUnsignedDevelopment -and $signature.Status -eq 'NotSigned')) {
        throw "Invalid Authenticode signature for $bootstrapPath. Status=$($signature.Status)"
    }
}

. $publicCommonPath
Assert-McpPublicSignature -Path $publicCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
Assert-McpPublicSignature -Path $executionCommonPath -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
. $executionCommonPath
Assert-McpPublicWindowsX64

$installation = [IO.Path]::GetFullPath($InstallationRoot)
$state = [IO.Path]::GetFullPath($StateRoot)
$requestPath = Join-Path $state 'update-request.v1.json'
$updatesRoot = Join-Path $state 'updates'
New-Item -ItemType Directory -Force -Path $updatesRoot | Out-Null

$request = $null
$operationId = $null
$requestedTag = $null
$restoreEnabled = $true
$resultPath = $null

function Write-McpV3UpdateResult {
    param([Parameter(Mandatory = $true)][object]$Value)
    if ([string]::IsNullOrWhiteSpace($script:resultPath)) {
        return
    }
    $temporary = "$($script:resultPath).tmp.$([guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText(
            $temporary,
            (($Value | ConvertTo-Json -Depth 6) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporary -Destination $script:resultPath -Force
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

try {
    if (Test-Path -LiteralPath $requestPath -PathType Leaf) {
        $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
        if ([int]$request.version -ne 1) {
            throw 'MCP V3 local update request version is unsupported.'
        }
        $operationId = [string]$request.operationId
        if ($operationId -notmatch '^[a-f0-9]{32}$') {
            throw 'MCP V3 local update request operationId is invalid.'
        }
        $requestedTag = [string]$request.tag
        if (-not [string]::IsNullOrWhiteSpace($requestedTag) -and
            $requestedTag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z.-]+)?$') {
            throw 'MCP V3 local update request tag is invalid.'
        }
        $restoreEnabled = [bool]$request.restoreEnabled
        $resultPath = Join-Path $updatesRoot ("result-$operationId.json")
    }

    $updater = Join-Path $PSScriptRoot 'Update-McpV3Local.ps1'
    Assert-McpPublicSignature -Path $updater -AllowUnsignedDevelopment:$AllowUnsignedDevelopment

    $updaterArguments = @{
        Repository = $Repository
        InstallationRoot = $installation
        StateRoot = $state
        TaskName = $CompanionTaskName
        Execute = $true
        AllowUnsignedDevelopment = [bool]$AllowUnsignedDevelopment
    }
    if (-not [string]::IsNullOrWhiteSpace($requestedTag)) {
        $updaterArguments.Tag = $requestedTag
    }

    $output = @(& $updater @updaterArguments)
    if ($null -ne $request) {
        Write-McpV3UpdateResult -Value ([ordered]@{
            version = 1
            operationId = $operationId
            status = 'succeeded'
            tag = if ([string]::IsNullOrWhiteSpace($requestedTag)) { $null } else { $requestedTag }
            completedAt = [DateTimeOffset]::UtcNow.ToString('O')
            updaterOutput = ($output -join [Environment]::NewLine)
        })
    }
    $output
}
catch {
    if ($null -ne $request) {
        Write-McpV3UpdateResult -Value ([ordered]@{
            version = 1
            operationId = $operationId
            status = 'failed'
            tag = if ([string]::IsNullOrWhiteSpace($requestedTag)) { $null } else { $requestedTag }
            completedAt = [DateTimeOffset]::UtcNow.ToString('O')
            error = $_.Exception.Message
        })
    }
    throw
}
finally {
    if ($null -ne $request) {
        Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
        if (-not $restoreEnabled) {
            Disable-ScheduledTask -TaskName $UpdaterTaskName -ErrorAction SilentlyContinue | Out-Null
        }
    }
}
