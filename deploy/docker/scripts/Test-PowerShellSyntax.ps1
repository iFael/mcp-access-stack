[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$files = Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.ps1'
$issues = @()

foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $file.FullName,
        [ref]$tokens,
        [ref]$errors
    ) | Out-Null

    foreach ($parseError in $errors) {
        $issues += "$($file.Name): $($parseError.Message)"
    }
}

if ($issues.Count -gt 0) {
    $issues | ForEach-Object { Write-Error $_ }
    exit 1
}

. (Join-Path $PSScriptRoot 'Common.ps1')
$root = Get-McpProjectRoot
foreach ($environment in @('development', 'production')) {
    $arguments = Get-McpComposeArguments -Environment $environment
    $composeIndex = [Array]::IndexOf($arguments, '-f')
    $envIndex = [Array]::IndexOf($arguments, '--env-file')
    if ($composeIndex -lt 0 -or $envIndex -lt 0) {
        throw "Compose arguments are incomplete for $environment."
    }

    $actualCompose = [System.IO.Path]::GetFullPath($arguments[$composeIndex + 1])
    $expectedCompose = [System.IO.Path]::GetFullPath(
        (Join-Path $root "deploy\docker\compose.$environment.yml")
    )
    if ($actualCompose -ne $expectedCompose) {
        throw "Unexpected Compose path for ${environment}: $actualCompose"
    }

    $actualEnv = [System.IO.Path]::GetFullPath($arguments[$envIndex + 1])
    $expectedEnv = [System.IO.Path]::GetFullPath(
        (Join-Path $root ".runtime-private\docker\$environment\compose.env")
    )
    if ($actualEnv -ne $expectedEnv) {
        throw "Unexpected Compose env path for ${environment}: $actualEnv"
    }
}

Write-Output 'Docker PowerShell scripts have valid syntax and current Compose paths.'
