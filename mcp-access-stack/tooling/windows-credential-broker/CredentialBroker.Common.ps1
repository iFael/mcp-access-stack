Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-McpProjectRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}

function Read-McpJsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "JSON file not found: $Path"
    }
    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Write-McpUtf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )
    $directory = Split-Path -Parent $Path
    if ($directory) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    [System.IO.File]::WriteAllText(
        [System.IO.Path]::GetFullPath($Path),
        $Content,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Write-McpJsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )
    Write-McpUtf8NoBom -Path $Path -Content (($Value | ConvertTo-Json -Depth 32) + [Environment]::NewLine)
}

function Get-McpNodeExecutable {
    param(
        [string]$ReleaseRoot,
        [string]$ExpectedVersion
    )

    $candidatePaths = [System.Collections.Generic.List[string]]::new()
    $explicitPath = [string]$env:MCP_NODE_EXECUTABLE
    if (-not [string]::IsNullOrWhiteSpace($explicitPath)) {
        $candidatePaths.Add([System.IO.Path]::GetFullPath($explicitPath))
    }
    foreach ($candidate in @(
        Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue |
            Where-Object { Test-Path -LiteralPath $_.Source -PathType Leaf } |
            Select-Object -ExpandProperty Source -Unique |
            Sort-Object
    )) {
        $resolved = [System.IO.Path]::GetFullPath([string]$candidate)
        if (-not $candidatePaths.Contains($resolved)) {
            $candidatePaths.Add($resolved)
        }
    }

    if ([string]::IsNullOrWhiteSpace($ExpectedVersion) -and $ReleaseRoot) {
        $manifestPath = Join-Path ([System.IO.Path]::GetFullPath($ReleaseRoot)) 'manifest.json'
        if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
            $ExpectedVersion = [string](Read-McpJsonFile -Path $manifestPath).nodeVersion
        }
    }

    foreach ($candidatePath in $candidatePaths) {
        if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) { continue }
        $global:LASTEXITCODE = 0
        $version = (& $candidatePath --version 2>$null | Select-Object -First 1)
        if ([int]$global:LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$version)) { continue }
        if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion) -and [string]$version -ne $ExpectedVersion) { continue }
        return $candidatePath
    }

    $requirement = if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) { 'a valid Node.js runtime' } else { "Node.js $ExpectedVersion" }
    throw "Unable to resolve $requirement. Set MCP_NODE_EXECUTABLE to an absolute node.exe path."
}

function Get-McpCredentialBrokerSourceRelativePath {
    return 'tooling\windows-credential-broker\McpCredentialBroker.cs'
}

function New-McpCSharpTemporaryExecutablePath {
    param(
        [Parameter(Mandatory = $true)]
        [ValidatePattern('^[A-Za-z0-9._-]{1,64}$')]
        [string]$Prefix
    )
    return Join-Path ([System.IO.Path]::GetTempPath()) ($Prefix + '.' + [guid]::NewGuid().ToString('N') + '.exe')
}

function Get-McpCredentialBrokerExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot
    )

    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw 'The MCP credential broker is supported only on Windows.'
    }

    $resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
    $sourcePath = Join-Path ([System.IO.Path]::GetFullPath($ReleaseRoot)) (Get-McpCredentialBrokerSourceRelativePath)
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Credential broker source not found: $sourcePath"
    }
    $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $toolVersion = '1.0.0-' + $sourceHash.Substring(0, 12)
    $toolDirectory = Join-Path $resolvedProjectRoot ".runtime-tools\mcp-credential-broker\$toolVersion"
    $executablePath = Join-Path $toolDirectory 'McpCredentialBroker.exe'
    $metadataPath = Join-Path $toolDirectory 'metadata.json'

    if ((Test-Path -LiteralPath $executablePath -PathType Leaf) -and (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
        try {
            $metadata = Read-McpJsonFile -Path $metadataPath
            $executableHash = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ([string]$metadata.version -eq $toolVersion -and [string]$metadata.sourceSha256 -eq $sourceHash -and [string]$metadata.executableSha256 -eq $executableHash) {
                return $executablePath
            }
        }
        catch {
        }
    }

    $compilerCandidates = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace([string]$env:MCP_CSC_EXECUTABLE)) {
        $compilerCandidates.Add([System.IO.Path]::GetFullPath([string]$env:MCP_CSC_EXECUTABLE))
    }
    foreach ($candidate in @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    )) {
        $resolved = [System.IO.Path]::GetFullPath($candidate)
        if (-not $compilerCandidates.Contains($resolved)) { $compilerCandidates.Add($resolved) }
    }
    $compilerPath = @($compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }) | Select-Object -First 1
    if (-not $compilerPath) {
        throw 'Unable to find the Windows C# compiler for the credential broker.'
    }

    New-Item -ItemType Directory -Force -Path $toolDirectory | Out-Null
    $temporaryExecutablePath = New-McpCSharpTemporaryExecutablePath -Prefix 'McpCredentialBroker'
    try {
        $global:LASTEXITCODE = 0
        & $compilerPath @(
            '/nologo',
            '/target:winexe',
            '/optimize+',
            '/platform:x64',
            '/reference:System.Windows.Forms.dll',
            '/reference:System.Drawing.dll',
            "/out:$temporaryExecutablePath",
            $sourcePath
        )
        if ([int]$global:LASTEXITCODE -ne 0) {
            throw "Credential broker compilation failed with exit code $global:LASTEXITCODE."
        }
        Move-Item -LiteralPath $temporaryExecutablePath -Destination $executablePath -Force
        $executableHash = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-McpJsonFile -Path $metadataPath -Value ([ordered]@{
            version = $toolVersion
            sourcePath = (Get-McpCredentialBrokerSourceRelativePath)
            sourceSha256 = $sourceHash
            executableSha256 = $executableHash
            compilerPath = [System.IO.Path]::GetFullPath([string]$compilerPath)
            builtAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
        })
    }
    finally {
        Remove-Item -LiteralPath $temporaryExecutablePath -Force -ErrorAction SilentlyContinue
    }

    return $executablePath
}
