$ErrorActionPreference = 'Stop'

$scriptPaths = @(
    (Join-Path $PSScriptRoot 'Initialize-ValidationTools.ps1'),
    (Join-Path $PSScriptRoot '..\inspector\Start-McpInspector.ps1')
)

foreach ($scriptPath in $scriptPaths) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $scriptPath,
        [ref]$tokens,
        [ref]$errors
    ) | Out-Null

    if ($errors.Count -gt 0) {
        $messages = $errors | ForEach-Object { $_.Message }
        throw "PowerShell syntax validation failed for $([System.IO.Path]::GetFileName($scriptPath)): $($messages -join '; ')"
    }
}

Write-Output 'Validation tool PowerShell scripts have valid syntax.'
