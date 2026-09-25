[CmdletBinding()]
param(
    [string]$InstallationRoot,
    [string]$StateRoot,
    [string]$ManagedRepositoriesRoot,
    [string]$TaskName = 'MCP V3 local companion',
    [string]$UpdateTaskName = 'MCP V3 local updater',

    [switch]$PurgeRepositories,
    [switch]$Execute,
    [switch]$AllowUnsignedDevelopment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'MCP V3 local uninstall is intentionally gated. Re-run with -Execute.'
}

$publicCommonPath = Join-Path $PSScriptRoot 'PublicDistribution.Common.ps1'
$executionCommonPath = Join-Path $PSScriptRoot 'WindowsExecutionNode.Common.ps1'
foreach ($bootstrapPath in @($PSCommandPath, $publicCommonPath, $executionCommonPath)) {
    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        throw "Required MCP V3 local uninstall dependency is missing: $bootstrapPath"
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

if ([string]::IsNullOrWhiteSpace([string]$env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is required for the per-user MCP V3 local uninstall.'
}

$defaultStateRoot = Join-Path $env:LOCALAPPDATA 'MCP V3'
$state = [IO.Path]::GetFullPath($(if ([string]::IsNullOrWhiteSpace($StateRoot)) { $defaultStateRoot } else { $StateRoot }))
$installation = [IO.Path]::GetFullPath($(if ([string]::IsNullOrWhiteSpace($InstallationRoot)) { Join-Path $state 'App' } else { $InstallationRoot }))
$managedRoot = [IO.Path]::GetFullPath($(if ([string]::IsNullOrWhiteSpace($ManagedRepositoriesRoot)) { Join-Path (Join-Path $HOME 'MCP V3') 'Repositórios' } else { $ManagedRepositoriesRoot }))

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ([string]::IsNullOrWhiteSpace($currentUser)) {
    throw 'Current Windows user identity could not be resolved.'
}

function Assert-McpV3RemovalBoundary {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $candidate = [IO.Path]::GetFullPath($Path).TrimEnd('\\', '/')
    $root = [IO.Path]::GetPathRoot($candidate).TrimEnd('\\', '/')
    if ([string]::IsNullOrWhiteSpace($candidate) -or
        $candidate -eq $root -or
        $candidate.Length -le ($root.Length + 4)) {
        throw ("Refusing unsafe MCP V3 removal boundary for {0}: {1}" -f $Label, $candidate)
    }

    $protected = @(
        $HOME,
        $env:USERPROFILE,
        $env:LOCALAPPDATA,
        $env:APPDATA,
        $env:SystemRoot,
        $env:ProgramFiles,
        [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }

    foreach ($protectedPath in $protected) {
        $resolvedProtected = [IO.Path]::GetFullPath([string]$protectedPath).TrimEnd('\\', '/')
        if ($candidate.Equals($resolvedProtected, [StringComparison]::OrdinalIgnoreCase)) {
            throw ("Refusing to remove protected path for {0}: {1}" -f $Label, $candidate)
        }
    }
}

function Remove-McpV3OwnedTask {
    param([Parameter(Mandatory = $true)][string]$Name)

    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $task) { return $false }
    if (-not (Test-McpWindowsAccountIdentityEquivalent -Left ([string]$task.Principal.UserId) -Right $currentUser)) {
        throw "Refusing to remove MCP V3 Scheduled Task owned by another user: $Name"
    }
    if ([string]$task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $Name
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 200
            $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
            if (-not $task -or [string]$task.State -ne 'Running') { break }
        } while ([DateTimeOffset]::UtcNow -lt $deadline)
        if ($task -and [string]$task.State -eq 'Running') {
            throw "MCP V3 Scheduled Task did not stop before uninstall: $Name"
        }
    }
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    return $true
}

function Get-McpV3OAuthCredentialTarget {
    param(
        [Parameter(Mandatory = $true)][string]$PrivateDirectory,
        [Parameter(Mandatory = $true)][string]$EdgeOrigin
    )
    $resolvedPrivate = [IO.Path]::GetFullPath($PrivateDirectory).ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($resolvedPrivate))
        $privateHash = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    } finally { $sha.Dispose() }

    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($EdgeOrigin))
        $edgeHash = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    } finally { $sha.Dispose() }

    $accountId = 'oauth-' + $edgeHash.Substring(0, 24)
    return 'McpAccessStack/{0}/mcp-v3/{1}' -f $privateHash.Substring(0, 24), $accountId
}

function Remove-McpV3OAuthCredential {
    $configPath = Join-Path $state 'config.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return 'config-unavailable' }
    try {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        $edgeUri = [Uri]([string]$config.edgeBaseUrl)
        if (-not $edgeUri.IsAbsoluteUri -or $edgeUri.Scheme -ne 'https') { return 'config-invalid' }
        $edgeOrigin = $edgeUri.GetLeftPart([UriPartial]::Authority)
        $privateDirectory = Join-Path $state 'private'
        $target = Get-McpV3OAuthCredentialTarget -PrivateDirectory $privateDirectory -EdgeOrigin $edgeOrigin

        $brokerPath = $null
        if (Test-Path -LiteralPath $installation -PathType Container) {
            $statePath = Get-McpWindowsExecutionNodeStatePath -InstallationRoot $installation
            $releaseState = Read-McpWindowsExecutionNodeState -Path $statePath
            if ($releaseState -and $releaseState.active) {
                $releaseId = [string]$releaseState.active.releaseId
                $releaseRoot = Join-Path $installation ("releases\$releaseId")
                if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
                    try {
                        $verified = Assert-McpWindowsExecutionNodeRelease -ReleaseRoot $releaseRoot -ExpectedReleaseId $releaseId -AllowUnsignedDevelopment:$AllowUnsignedDevelopment
                        $record = @($verified.executionManifest.artifacts | Where-Object { [string]$_.id -eq 'browser-credential-broker' })
                        if ($record.Count -eq 1) {
                            $candidate = Resolve-McpPublicChildPath -Root $releaseRoot -RelativePath ([string]$record[0].path)
                            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $brokerPath = $candidate }
                        }
                    } catch { $brokerPath = $null }
                }
            }
        }

        if ($brokerPath) {
            & $brokerPath --mode delete --target $target
            if ($LASTEXITCODE -eq 0) { return 'removed' }
        }

        $cmdkey = Join-Path $env:SystemRoot 'System32\cmdkey.exe'
        if (Test-Path -LiteralPath $cmdkey -PathType Leaf) {
            & $cmdkey "/delete:$target" | Out-Null
            if ($LASTEXITCODE -eq 0) { return 'removed' }
        }
        return 'not-removed'
    } catch {
        return 'not-removed'
    }
}

$companionTaskRemoved = Remove-McpV3OwnedTask -Name $TaskName
$updateTaskRemoved = Remove-McpV3OwnedTask -Name $UpdateTaskName
$credentialStatus = Remove-McpV3OAuthCredential

Assert-McpV3RemovalBoundary -Path $installation -Label 'installation root'
Assert-McpV3RemovalBoundary -Path $state -Label 'state root'
Assert-McpV3RemovalBoundary -Path $managedRoot -Label 'managed repositories root'

if (Test-Path -LiteralPath $installation) {
    Remove-Item -LiteralPath $installation -Recurse -Force
}
if (Test-Path -LiteralPath $state) {
    Remove-Item -LiteralPath $state -Recurse -Force
}

$managedRepositoriesRemoved = $false
if ($PurgeRepositories -and (Test-Path -LiteralPath $managedRoot)) {
    Remove-Item -LiteralPath $managedRoot -Recurse -Force
    $managedRepositoriesRemoved = $true
}

[pscustomobject]@{
    status = 'uninstalled'
    taskName = $TaskName
    companionTaskRemoved = [bool]$companionTaskRemoved
    updateTaskName = $UpdateTaskName
    updateTaskRemoved = [bool]$updateTaskRemoved
    credentialStatus = $credentialStatus
    installationRoot = $installation
    stateRoot = $state
    managedRepositoriesRoot = $managedRoot
    managedRepositoriesRemoved = $managedRepositoriesRemoved
    repositoriesPreserved = -not [bool]$PurgeRepositories
} | ConvertTo-Json -Compress
