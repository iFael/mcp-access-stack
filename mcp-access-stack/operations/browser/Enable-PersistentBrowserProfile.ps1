[CmdletBinding()]
param(
    [string]$ConfigurationPath,
    [string]$DockerConfigurationPath,
    [string]$UserDataDirectory,
    [ValidateSet('interactive', 'auto', 'efficient', 'diagnostic')]
    [string]$Mode = 'interactive'
)

$ErrorActionPreference = 'Stop'

function Get-ProjectRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    $content = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if ($content.Length -gt 0 -and [int][char]$content[0] -eq 0xFEFF) {
        $content = $content.Substring(1)
    }
    return $content | ConvertFrom-Json
}

function Write-JsonFileAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $directory = Split-Path -Parent $Path
    if ($directory) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }

    $json = $Value | ConvertTo-Json -Depth 64
    $temporaryPath = "$Path.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tmp"
    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($temporaryPath, $json, $encoding)
    Move-Item -Force -LiteralPath $temporaryPath -Destination $Path
}

function Test-PathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Candidate
    )

    $relative = [System.IO.Path]::GetRelativePath($Parent, $Candidate)
    return $relative.Length -gt 0 -and
        -not $relative.StartsWith('..', [StringComparison]::Ordinal) -and
        -not [System.IO.Path]::IsPathRooted($relative)
}

$projectRoot = Get-ProjectRoot
$configurationPathWasExplicit = $PSBoundParameters.ContainsKey('ConfigurationPath')
$dockerConfigurationPathWasExplicit = $PSBoundParameters.ContainsKey('DockerConfigurationPath')
if (-not $ConfigurationPath) {
    $ConfigurationPath = Join-Path $projectRoot '.runtime-private\gpt-only-production.json'
}
$ConfigurationPath = [System.IO.Path]::GetFullPath($ConfigurationPath)

if (-not $DockerConfigurationPath -and -not $configurationPathWasExplicit) {
    $DockerConfigurationPath = Join-Path $projectRoot '.runtime-private\docker\production\browser.json'
}
if ($DockerConfigurationPath) {
    $DockerConfigurationPath = [System.IO.Path]::GetFullPath($DockerConfigurationPath)
}

if (-not (Test-Path -LiteralPath $ConfigurationPath -PathType Leaf)) {
    throw 'Production configuration file was not found.'
}
if (
    $dockerConfigurationPathWasExplicit -and
    -not (Test-Path -LiteralPath $DockerConfigurationPath -PathType Leaf)
) {
    throw 'Docker production browser configuration file was not found.'
}

$config = Read-JsonFile -Path $ConfigurationPath
if (-not $config.browser) {
    $config | Add-Member -NotePropertyName browser -NotePropertyValue ([pscustomobject]@{})
}
$dockerConfig = if (
    $DockerConfigurationPath -and
    (Test-Path -LiteralPath $DockerConfigurationPath -PathType Leaf)
) {
    Read-JsonFile -Path $DockerConfigurationPath
}
else {
    $null
}

$privateDirectoryProperty = $config.browser.PSObject.Properties['privateDirectory']
$privateDirectory = if ($privateDirectoryProperty -and $privateDirectoryProperty.Value) {
    [System.IO.Path]::GetFullPath([string]$privateDirectoryProperty.Value)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.runtime-private\browser'))
}

if (-not $UserDataDirectory) {
    $configuredUserDataDirectory = $config.browser.PSObject.Properties['userDataDirectory']
    $UserDataDirectory = if ($configuredUserDataDirectory -and $configuredUserDataDirectory.Value) {
        [string]$configuredUserDataDirectory.Value
    }
    else {
        Join-Path $privateDirectory 'chrome-profile'
    }
}
$UserDataDirectory = [System.IO.Path]::GetFullPath($UserDataDirectory)

if (-not (Test-PathInside -Parent $privateDirectory -Candidate $UserDataDirectory)) {
    throw 'The persistent Chrome profile must stay inside browser.privateDirectory.'
}

$config.browser | Add-Member -Force -NotePropertyName mode -NotePropertyValue $Mode
$config.browser | Add-Member -Force -NotePropertyName engine -NotePropertyValue 'playwright-direct'
$config.browser | Add-Member -Force -NotePropertyName profileMode -NotePropertyValue 'persistent'
$config.browser | Add-Member -Force -NotePropertyName browserChannel -NotePropertyValue 'chromium'
$config.browser | Add-Member -Force -NotePropertyName privateDirectory -NotePropertyValue $privateDirectory
$config.browser | Add-Member -Force -NotePropertyName userDataDirectory -NotePropertyValue $UserDataDirectory
$config.browser.PSObject.Properties.Remove('extensionTokenFile')
$config.browser.PSObject.Properties.Remove('cliSessionName')

if ($dockerConfig) {
    $dockerConfig | Add-Member -Force -NotePropertyName version -NotePropertyValue 2
    $dockerConfig | Add-Member -Force -NotePropertyName engine -NotePropertyValue 'playwright-direct'
    $dockerConfig | Add-Member -Force -NotePropertyName mode -NotePropertyValue $Mode
    $dockerConfig | Add-Member -Force -NotePropertyName profileMode -NotePropertyValue 'persistent'
    $dockerConfig | Add-Member -Force -NotePropertyName browserChannel -NotePropertyValue 'chromium'
    $dockerConfig | Add-Member -Force -NotePropertyName privateDirectory -NotePropertyValue $privateDirectory
    $dockerConfig | Add-Member -Force -NotePropertyName userDataDirectory -NotePropertyValue $UserDataDirectory
    $dockerConfig.PSObject.Properties.Remove('extensionTokenFile')
    $dockerConfig.PSObject.Properties.Remove('cliSessionName')
}

Write-JsonFileAtomic -Path $ConfigurationPath -Value $config
if ($dockerConfig) {
    Write-JsonFileAtomic -Path $DockerConfigurationPath -Value $dockerConfig
}

[pscustomobject]@{
    status = 'configured'
    mode = $Mode
    engine = 'playwright-direct'
    profileMode = 'persistent'
    browserChannel = 'chromium'
    userDataDirectory = $UserDataDirectory
    isolatedFromDefaultChrome = $true
    dockerConfigurationUpdated = ($null -ne $dockerConfig)
    requiresBrowserWorkerRestart = $true
} | ConvertTo-Json -Depth 4
