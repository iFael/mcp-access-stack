[CmdletBinding()]
param(
    [string[]]$WorkspaceIds = @(),
    [bool]$AllowWrite = $true,
    [bool]$AllowShell = $true,
    [switch]$Force,
    [switch]$SkipClipboard
)

$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$configPath = Join-Path $projectRoot '.runtime-private\gpt-only-production.json'

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'Private production configuration was not found.'
}

$configText = [System.IO.File]::ReadAllText($configPath).TrimStart([char]0xFEFF)
$config = $configText | ConvertFrom-Json

$allowedWorkspaceIds = @(
    $WorkspaceIds |
        ForEach-Object { ([string]$_).Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -Unique
)
if ($allowedWorkspaceIds.Count -eq 0 -and $null -ne $config.actions -and $null -ne $config.actions.PSObject.Properties['workspaceIds']) {
    $allowedWorkspaceIds = @(
        $config.actions.workspaceIds |
            ForEach-Object { ([string]$_).Trim() } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Select-Object -Unique
    )
}
if ($allowedWorkspaceIds.Count -eq 0) {
    throw 'Specify -WorkspaceIds explicitly for the local installation.'
}
if ($allowedWorkspaceIds | Where-Object { $_ -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }) {
    throw 'WorkspaceIds contains an unsupported workspace ID.'
}

if ([string]::IsNullOrWhiteSpace([string]$config.publicBaseUrl)) {
    throw 'Private production configuration is missing publicBaseUrl.'
}
if ([string]::IsNullOrWhiteSpace([string]$config.mcpPath)) {
    throw 'Private production configuration is missing mcpPath.'
}

function Get-ConfiguredWorkspaceIds {
    param([object]$Actions)

    if ($null -ne $Actions.PSObject.Properties['workspaceIds']) {
        return @($Actions.workspaceIds | ForEach-Object { [string]$_ })
    }
    if ($null -ne $Actions.PSObject.Properties['workspaceId']) {
        return @([string]$Actions.workspaceId)
    }
    return @()
}

function Test-ExactWorkspaceAllowlist {
    param([string[]]$WorkspaceIds)

    if ($WorkspaceIds.Count -ne $allowedWorkspaceIds.Count) {
        return $false
    }
    foreach ($workspaceId in $allowedWorkspaceIds) {
        if ($WorkspaceIds -notcontains $workspaceId) {
            return $false
        }
    }
    return $true
}

function Save-PrivateConfiguration {
    param([object]$Configuration)

    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$configPath.$timestamp.bak"
    Copy-Item -LiteralPath $configPath -Destination $backup
    $json = $Configuration | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText(
        $configPath,
        $json + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )
    return $backup
}

$existingActions = $null -ne $config.actions -and $config.actions.enabled -eq $true
$configurationChanged = $false
$backupPath = $null

if ($existingActions -and -not $Force) {
    if ([string]::IsNullOrWhiteSpace([string]$config.actions.token)) {
        throw 'Existing GPT Actions configuration does not contain the private API key.'
    }
    if ([string]$config.actions.tokenSha -notmatch '^[a-fA-F0-9]{64}$') {
        throw 'Existing GPT Actions configuration contains an invalid token hash.'
    }

    $token = [string]$config.actions.token
    $calculatedHash = [Convert]::ToHexString(
        [System.Security.Cryptography.SHA256]::HashData(
            [System.Text.Encoding]::UTF8.GetBytes($token)
        )
    ).ToLowerInvariant()
    if ($calculatedHash -ne [string]$config.actions.tokenSha) {
        throw 'Existing GPT Actions API key does not match its stored hash.'
    }

    $configuredWorkspaceIds = Get-ConfiguredWorkspaceIds -Actions $config.actions
    $invalidWorkspaceIds = @($configuredWorkspaceIds | Where-Object { $allowedWorkspaceIds -notcontains $_ })
    if ($invalidWorkspaceIds.Count -gt 0) {
        throw "Existing GPT Actions configuration contains unauthorized workspaces: $($invalidWorkspaceIds -join ', ')."
    }

    if (-not (Test-ExactWorkspaceAllowlist -WorkspaceIds $configuredWorkspaceIds)) {
        if ($null -eq $config.actions.PSObject.Properties['workspaceIds']) {
            $config.actions | Add-Member -NotePropertyName workspaceIds -NotePropertyValue $allowedWorkspaceIds
        }
        else {
            $config.actions.workspaceIds = $allowedWorkspaceIds
        }
        if ($null -ne $config.actions.PSObject.Properties['workspaceId']) {
            $config.actions.PSObject.Properties.Remove('workspaceId')
        }
        $backupPath = Save-PrivateConfiguration -Configuration $config
        $configurationChanged = $true
    }

    $AllowWrite = [bool]$config.actions.allowWrite
    $AllowShell = [bool]$config.actions.allowShell
}
else {
    $tokenBytes = [byte[]]::new(48)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
    $token = 'gpta_' + [Convert]::ToBase64String($tokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $tokenHashBytes = [System.Security.Cryptography.SHA256]::HashData(
        [System.Text.Encoding]::UTF8.GetBytes($token)
    )
    $tokenSha = [Convert]::ToHexString($tokenHashBytes).ToLowerInvariant()

    $actions = [ordered]@{
        enabled = $true
        workspaceIds = $allowedWorkspaceIds
        allowWrite = $AllowWrite
        allowShell = $AllowShell
        token = $token
        tokenSha = $tokenSha
    }

    if ($null -eq $config.actions) {
        $config | Add-Member -NotePropertyName actions -NotePropertyValue ([pscustomobject]$actions)
    }
    else {
        $config.actions = [pscustomobject]$actions
    }

    $backupPath = Save-PrivateConfiguration -Configuration $config
    $configurationChanged = $true
}

$baseUrl = ([string]$config.publicBaseUrl).TrimEnd('/')
$mcpPath = '/' + ([string]$config.mcpPath).Trim('/')
$setup = [ordered]@{
    authentication = 'API Key'
    authType = 'Bearer'
    apiKey = $token
    schemaUrl = "$baseUrl$mcpPath/actions/openapi.json?v=1.7.0"
    privacyPolicyUrl = "$baseUrl$mcpPath/actions/privacy"
    workspaceIds = $allowedWorkspaceIds
    allowWrite = $AllowWrite
    allowShell = $AllowShell
}

if (-not $SkipClipboard) {
    if (Get-Command Set-Clipboard -ErrorAction SilentlyContinue) {
        ($setup | ConvertTo-Json -Depth 5) | Set-Clipboard
        Write-Output 'GPT Actions configuration was copied to the clipboard.'
    }
    else {
        Write-Warning 'Set-Clipboard is unavailable. The API key remains stored only in the private production configuration.'
    }
}

if ($configurationChanged) {
    Write-Output ('GPT Actions private configuration prepared for ' + $allowedWorkspaceIds.Count + ' explicitly configured workspace(s).')
    Write-Output "Backup created: $([System.IO.Path]::GetFileName($backupPath))"
    Write-Output 'Restart or redeploy the gateway to load the new configuration.'
}
else {
    Write-Output 'GPT Actions were already configured; the existing key and allowlist were preserved.'
}
Write-Output 'The API key was not printed.'
