[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$hostSource = Join-Path $root 'tooling\windows-edge-host\McpEdgeHost.cs'
if (-not (Test-Path -LiteralPath $hostSource -PathType Leaf)) {
    throw "McpEdgeHost source is missing: $hostSource"
}

$compiler = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $compiler) {
    throw 'Unable to find the Windows C# compiler for McpEdgeHost qualification.'
}

function Write-TestUtf8 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $parent = Split-Path -Parent $Path
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Invoke-CSharpFixtureBuild {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [ValidateSet('exe', 'winexe')][string]$TargetType,
        [string[]]$References = @()
    )

    $args = @('/nologo', "/target:$TargetType", '/optimize+', '/platform:x64')
    foreach ($reference in $References) {
        $args += "/reference:$reference"
    }
    $args += "/out:$TargetPath"
    $args += $SourcePath
    & $compiler @args
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) {
        throw "Fixture compilation failed: $TargetPath"
    }
}

function New-ArtifactRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][bool]$AuthenticodeRequired
    )

    $item = Get-Item -LiteralPath $Path
    [ordered]@{
        role = $Role
        path = $RelativePath
        sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        sizeBytes = [long]$item.Length
        authenticodeRequired = $AuthenticodeRequired
    }
}

function Quote-TestWindowsArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"')) {
        throw 'McpEdgeHost fixture arguments cannot contain quotes.'
    }
    return '"' + $Value + '"'
}

function Invoke-EdgeHost {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.Arguments = (@($Arguments | ForEach-Object { Quote-TestWindowsArgument -Value $_ }) -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw 'McpEdgeHost fixture process did not start.'
        }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        [pscustomobject]@{
            exitCode = $process.ExitCode
            text = (($stdout, $stderr | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine)
        }
    }
    finally {
        $process.Dispose()
    }
}

$fixtureRoot = Join-Path $env:TEMP ('mcp-edge-host-' + [guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $fixtureRoot 'release'
$runtimeRoot = Join-Path $fixtureRoot 'runtime'
$hostBuild = Join-Path $fixtureRoot 'McpEdgeHost.exe'
$hostPath = Join-Path $releaseRoot 'native\McpEdgeHost.exe'
$nodePath = Join-Path $releaseRoot 'runtime\node\node.exe'
$edgeCli = Join-Path $releaseRoot 'node_modules\@vs-code-gpt\remote-mcp-gateway\dist\edge-connector-cli.js'
$launcherPath = Join-Path $releaseRoot 'deploy\windows\Start-McpEdgeConnector.ps1'
$connectorTokenFile = Join-Path $runtimeRoot 'connector-token.txt'
$ownerTokenFile = Join-Path $runtimeRoot 'owner-token.txt'
$browserTokenFile = Join-Path $runtimeRoot 'browser-token.txt'
$policyPath = Join-Path $runtimeRoot 'policy.json'
$connectorToken = 'c' * 64
$ownerToken = 'o' * 64
$browserToken = 'b' * 64

try {
    New-Item -ItemType Directory -Force -Path $fixtureRoot, $releaseRoot, $runtimeRoot | Out-Null

    Invoke-CSharpFixtureBuild `
        -SourcePath $hostSource `
        -TargetPath $hostBuild `
        -TargetType winexe `
        -References @('System.Web.Extensions.dll')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $hostPath) | Out-Null
    Copy-Item -LiteralPath $hostBuild -Destination $hostPath

    $fakeNodeSource = Join-Path $fixtureRoot 'FakeNode.cs'
    Write-TestUtf8 -Path $fakeNodeSource -Content @'
using System;
using System.IO;
using System.Text;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length != 1 || string.IsNullOrWhiteSpace(args[0]))
        {
            return 61;
        }
        string entry = File.ReadAllText(args[0], Encoding.UTF8);
        if (entry.Contains("edge-host-restart-fixture"))
        {
            string attemptsPath = args[0] + ".attempts";
            int attempts = 0;
            if (File.Exists(attemptsPath))
            {
                int.TryParse(File.ReadAllText(attemptsPath, Encoding.UTF8), out attempts);
            }
            attempts++;
            File.WriteAllText(attemptsPath, attempts.ToString(), new UTF8Encoding(false));
            return 7;
        }
        string probe = args[0] + ".probe";
        string[] names = new[]
        {
            "MCP_EDGE_BASE_URL",
            "MCP_CONNECTOR_TOKEN_FILE",
            "VS_CODE_GPT_POLICY_PATH",
            "VS_CODE_GPT_DATA_DIR",
            "VS_CODE_GPT_BACKGROUND_TASKS_DIR",
            "VS_CODE_GPT_COMMAND_INVOCATIONS_DIR",
            "MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS",
            "AUTH_MODE",
            "OWNER_TOKEN",
            "OWNER_OAUTH_SCOPES",
            "OWNER_OAUTH_STATE_PATH",
            "ALLOWED_ORIGINS",
            "BROWSER_WORKER_ENABLED",
            "BROWSER_WORKER_URL",
            "BROWSER_WORKER_TOKEN"
        };
        using (StreamWriter writer = new StreamWriter(probe, false, new UTF8Encoding(false)))
        {
            foreach (string name in names)
            {
                writer.WriteLine(name + "=" + (Environment.GetEnvironmentVariable(name) ?? string.Empty));
            }
        }
        return 0;
    }
}
'@
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $nodePath) | Out-Null
    Invoke-CSharpFixtureBuild -SourcePath $fakeNodeSource -TargetPath $nodePath -TargetType exe

    Write-TestUtf8 -Path $edgeCli -Content "console.log('edge-host-fixture');`n"
    Write-TestUtf8 -Path $launcherPath -Content "Write-Output 'validation-fixture'`n"
    Write-TestUtf8 -Path $connectorTokenFile -Content $connectorToken
    Write-TestUtf8 -Path $ownerTokenFile -Content $ownerToken
    Write-TestUtf8 -Path $browserTokenFile -Content $browserToken
    Write-TestUtf8 -Path $policyPath -Content "{}`n"

    $releaseManifest = [ordered]@{
        releaseId = 'edge-host-fixture'
        commit = ('a' * 40)
        nodeVersion = 'v22.13.1'
    }
    Write-TestUtf8 `
        -Path (Join-Path $releaseRoot 'manifest.json') `
        -Content (($releaseManifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine)

    $executionManifest = [ordered]@{
        version = 1
        releaseId = 'edge-host-fixture'
        commit = ('a' * 40)
        platform = 'win32-x64'
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        runtimeMode = 'bundled-node'
        integrityRoot = 'signed-distribution-manifest'
        artifacts = @(
            (New-ArtifactRecord -Role 'edge-connector' -Path $edgeCli -RelativePath 'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js' -AuthenticodeRequired $false),
            (New-ArtifactRecord -Role 'edge-connector-launcher' -Path $launcherPath -RelativePath 'deploy/windows/Start-McpEdgeConnector.ps1' -AuthenticodeRequired $true),
            (New-ArtifactRecord -Role 'edge-host' -Path $hostPath -RelativePath 'native/McpEdgeHost.exe' -AuthenticodeRequired $true),
            (New-ArtifactRecord -Role 'node-runtime' -Path $nodePath -RelativePath 'runtime/node/node.exe' -AuthenticodeRequired $false)
        )
    }
    $manifestPath = Join-Path $releaseRoot 'execution-node-manifest.json'
    Write-TestUtf8 -Path $manifestPath -Content (($executionManifest | ConvertTo-Json -Depth 12) + [Environment]::NewLine)
    $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $commonArgs = @(
        '--release-root', $releaseRoot,
        '--expected-manifest-sha256', $manifestHash,
        '--runtime-root', $runtimeRoot,
        '--edge-base-url', 'https://mcp-access-stack.example.workers.dev/',
        '--connector-token-file', $connectorTokenFile,
        '--owner-token-file', $ownerTokenFile,
        '--policy-path', $policyPath,
        '--allowed-origins', 'https://chatgpt.com,https://chat.openai.com',
        '--owner-oauth-scopes', 'workspaces:read',
        '--max-concurrent-requests', '8',
        '--restart-count', '0',
        '--restart-interval-seconds', '1',
        '--browser-enabled', 'false'
    )

    $validation = Invoke-EdgeHost -Executable $hostPath -Arguments (@($commonArgs) + '--validate-only')
    if ($validation.exitCode -ne 0) {
        throw "McpEdgeHost validate-only failed: $($validation.text)"
    }
    if ($validation.text.Contains($connectorToken) -or $validation.text.Contains($ownerToken) -or $validation.text.Contains($browserToken)) {
        throw 'McpEdgeHost validate-only leaked a fixture secret.'
    }
    $previousDataDir = [Environment]::GetEnvironmentVariable('VS_CODE_GPT_DATA_DIR', 'Process')
    $previousBackgroundTasksDir = [Environment]::GetEnvironmentVariable('VS_CODE_GPT_BACKGROUND_TASKS_DIR', 'Process')
    $previousCommandInvocationsDir = [Environment]::GetEnvironmentVariable('VS_CODE_GPT_COMMAND_INVOCATIONS_DIR', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('VS_CODE_GPT_DATA_DIR', (Join-Path $releaseRoot 'unsafe-data'), 'Process')
        [Environment]::SetEnvironmentVariable('VS_CODE_GPT_BACKGROUND_TASKS_DIR', (Join-Path $releaseRoot 'unsafe-background-tasks'), 'Process')
        [Environment]::SetEnvironmentVariable('VS_CODE_GPT_COMMAND_INVOCATIONS_DIR', (Join-Path $releaseRoot 'unsafe-command-invocations'), 'Process')
        $run = Invoke-EdgeHost -Executable $hostPath -Arguments $commonArgs
    }
    finally {
        [Environment]::SetEnvironmentVariable('VS_CODE_GPT_DATA_DIR', $previousDataDir, 'Process')
        [Environment]::SetEnvironmentVariable('VS_CODE_GPT_BACKGROUND_TASKS_DIR', $previousBackgroundTasksDir, 'Process')
        [Environment]::SetEnvironmentVariable('VS_CODE_GPT_COMMAND_INVOCATIONS_DIR', $previousCommandInvocationsDir, 'Process')
    }
    if ($run.exitCode -ne 0) {
        throw "McpEdgeHost fixture run failed: $($run.text)"
    }
    if ($run.text.Contains($connectorToken) -or $run.text.Contains($ownerToken) -or $run.text.Contains($browserToken)) {
        throw 'McpEdgeHost runtime output leaked a fixture secret.'
    }

    $probePath = $edgeCli + '.probe'
    if (-not (Test-Path -LiteralPath $probePath -PathType Leaf)) {
        throw 'McpEdgeHost did not execute the manifest-declared canonical Edge CLI through bundled Node.'
    }
    $probe = @{}
    foreach ($line in Get-Content -LiteralPath $probePath) {
        $separator = $line.IndexOf('=')
        if ($separator -gt 0) {
            $probe[$line.Substring(0, $separator)] = $line.Substring($separator + 1)
        }
    }
    $expected = [ordered]@{
        MCP_EDGE_BASE_URL = 'https://mcp-access-stack.example.workers.dev'
        MCP_CONNECTOR_TOKEN_FILE = [IO.Path]::GetFullPath($connectorTokenFile)
        VS_CODE_GPT_POLICY_PATH = [IO.Path]::GetFullPath($policyPath)
        VS_CODE_GPT_DATA_DIR = [IO.Path]::GetFullPath($runtimeRoot)
        VS_CODE_GPT_BACKGROUND_TASKS_DIR = ''
        VS_CODE_GPT_COMMAND_INVOCATIONS_DIR = ''
        MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS = '8'
        AUTH_MODE = 'owner'
        OWNER_TOKEN = $ownerToken
        OWNER_OAUTH_SCOPES = 'workspaces:read'
        OWNER_OAUTH_STATE_PATH = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'owner-oauth-state.json'))
        ALLOWED_ORIGINS = 'https://chatgpt.com,https://chat.openai.com'
        BROWSER_WORKER_ENABLED = 'false'
        BROWSER_WORKER_URL = ''
        BROWSER_WORKER_TOKEN = ''
    }
    foreach ($name in $expected.Keys) {
        if ([string]$probe[$name] -ne [string]$expected[$name]) {
            throw "McpEdgeHost child environment mismatch: $name"
        }
    }

    Write-TestUtf8 -Path $edgeCli -Content "// edge-host-restart-fixture`n"
    $executionManifest.artifacts[0] = New-ArtifactRecord `
        -Role 'edge-connector' `
        -Path $edgeCli `
        -RelativePath 'node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js' `
        -AuthenticodeRequired $false
    Write-TestUtf8 -Path $manifestPath -Content (($executionManifest | ConvertTo-Json -Depth 12) + [Environment]::NewLine)
    $restartManifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    for ($index = 0; $index -lt $commonArgs.Count; $index += 2) {
        if ($commonArgs[$index] -eq '--expected-manifest-sha256') {
            $commonArgs[$index + 1] = $restartManifestHash
        }
        elseif ($commonArgs[$index] -eq '--restart-count') {
            $commonArgs[$index + 1] = '2'
        }
    }
    $restartRun = Invoke-EdgeHost -Executable $hostPath -Arguments $commonArgs
    if ($restartRun.exitCode -eq 0) {
        throw 'McpEdgeHost restart-budget fixture unexpectedly succeeded.'
    }
    $attemptsPath = $edgeCli + '.attempts'
    if (-not (Test-Path -LiteralPath $attemptsPath -PathType Leaf) -or [int](Get-Content -LiteralPath $attemptsPath -Raw) -ne 3) {
        throw 'McpEdgeHost restart budget did not execute exactly initial attempt plus two retries.'
    }
    $stderrLog = Join-Path $runtimeRoot 'logs\edge-connector.stderr.log'
    $restartLog = Get-Content -LiteralPath $stderrLog -Raw
    if (-not $restartLog.Contains('edge_host_restart_exhausted')) {
        throw 'McpEdgeHost restart exhaustion was not recorded.'
    }
    if ($restartLog.Contains($connectorToken) -or $restartLog.Contains($ownerToken) -or $restartLog.Contains($browserToken)) {
        throw 'McpEdgeHost restart logging leaked a fixture secret.'
    }

    $unsupported = Invoke-EdgeHost -Executable $hostPath -Arguments (@($commonArgs) + @('--env', 'UNSAFE=value'))
    if ($unsupported.exitCode -eq 0) {
        throw 'McpEdgeHost accepted generic --env injection.'
    }
    if ($unsupported.text.Contains($connectorToken) -or $unsupported.text.Contains($ownerToken)) {
        throw 'McpEdgeHost leaked a fixture secret while rejecting an unsupported option.'
    }

    [IO.File]::AppendAllText($edgeCli, '//tampered', [Text.UTF8Encoding]::new($false))
    $tampered = Invoke-EdgeHost -Executable $hostPath -Arguments (@($commonArgs) + '--validate-only')
    if ($tampered.exitCode -eq 0) {
        throw 'McpEdgeHost accepted a tampered canonical Edge CLI.'
    }
    if ($tampered.text -notmatch 'artifact (size|hash) mismatch') {
        throw 'McpEdgeHost tamper rejection did not identify artifact integrity.'
    }
    if ($tampered.text.Contains($connectorToken) -or $tampered.text.Contains($ownerToken)) {
        throw 'McpEdgeHost leaked a fixture secret while rejecting tampered runtime content.'
    }
}
finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        $removed = $false
        for ($attempt = 0; $attempt -lt 20 -and -not $removed; $attempt++) {
            try {
                Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction Stop
                $removed = $true
            }
            catch [System.UnauthorizedAccessException] {
                Start-Sleep -Milliseconds 100
            }
            catch [System.IO.IOException] {
                Start-Sleep -Milliseconds 100
            }
        }
        if (-not $removed) {
            throw "Unable to clean McpEdgeHost fixture root: $fixtureRoot"
        }
    }
}

Write-Output 'McpEdgeHost contract passed.'
