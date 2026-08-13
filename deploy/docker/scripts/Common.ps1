Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-McpProjectRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
}

function Test-McpAdministrator {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        return $false
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-McpAdministrator {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Operation
    )

    if (-not (Test-McpAdministrator)) {
        throw "$Operation requires an elevated PowerShell session. Open PowerShell as Administrator and re-run the command."
    }
}

function Read-McpJsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "JSON file not found: $Path"
    }

    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Write-McpUtf8NoBom {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Content
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
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 32
    Write-McpUtf8NoBom -Path $Path -Content ($json + [Environment]::NewLine)
}

function Assert-McpCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command is unavailable: $Name"
    }
}

function Get-McpNodeExecutable {
    param(
        [string]$ReleaseRoot,
        [string]$ExpectedVersion
    )

    $explicitPath = [string]$env:MCP_NODE_EXECUTABLE
    $candidatePaths = [System.Collections.Generic.List[string]]::new()
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
        if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
            continue
        }
        $global:LASTEXITCODE = 0
        $version = (& $candidatePath --version 2>$null | Select-Object -First 1)
        $versionExitCode = [int]$global:LASTEXITCODE
        if ($versionExitCode -ne 0 -or [string]::IsNullOrWhiteSpace([string]$version)) {
            continue
        }
        if (
            -not [string]::IsNullOrWhiteSpace($ExpectedVersion) -and
            [string]$version -ne $ExpectedVersion
        ) {
            continue
        }
        return $candidatePath
    }

    $requirement = if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) {
        'a valid Node.js runtime'
    }
    else {
        "Node.js $ExpectedVersion"
    }
    throw "Unable to resolve $requirement. Set MCP_NODE_EXECUTABLE to an absolute node.exe path."
}


function Get-McpNodeHostLauncherSourceRelativePath {
    return 'tooling\windows-host-launcher\McpNodeHostLauncher.cs'
}

function Get-McpReleaseNodeHostLauncherSourcePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReleaseRoot
    )

    $sourcePath = Join-Path (
        [System.IO.Path]::GetFullPath($ReleaseRoot)
    ) (Get-McpNodeHostLauncherSourceRelativePath)
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Native Node host launcher source not found in release: $sourcePath"
    }
    return $sourcePath
}

function Get-McpNodeHostLauncherExecutable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,

        [Parameter(Mandatory = $true)]
        [string]$ReleaseRoot
    )

    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw 'The native Node host launcher is supported only on Windows.'
    }

    $resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
    $sourcePath = Get-McpReleaseNodeHostLauncherSourcePath -ReleaseRoot $ReleaseRoot
    $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $toolVersion = '1.0.0-' + $sourceHash.Substring(0, 12)
    $toolDirectory = Join-Path $resolvedProjectRoot ".runtime-tools\mcp-node-host-launcher\$toolVersion"
    $executablePath = Join-Path $toolDirectory 'McpNodeHostLauncher.exe'
    $metadataPath = Join-Path $toolDirectory 'metadata.json'

    if (
        (Test-Path -LiteralPath $executablePath -PathType Leaf) -and
        (Test-Path -LiteralPath $metadataPath -PathType Leaf)
    ) {
        try {
            $metadata = Read-McpJsonFile -Path $metadataPath
            $executableHash = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
            if (
                [string]$metadata.version -eq $toolVersion -and
                [string]$metadata.sourceSha256 -eq $sourceHash -and
                [string]$metadata.executableSha256 -eq $executableHash
            ) {
                return $executablePath
            }
        }
        catch {
        }
    }

    $compilerCandidates = [System.Collections.Generic.List[string]]::new()
    $explicitCompiler = [string]$env:MCP_CSC_EXECUTABLE
    if (-not [string]::IsNullOrWhiteSpace($explicitCompiler)) {
        $compilerCandidates.Add([System.IO.Path]::GetFullPath($explicitCompiler))
    }
    foreach ($candidate in @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    )) {
        $resolvedCandidate = [System.IO.Path]::GetFullPath($candidate)
        if (-not $compilerCandidates.Contains($resolvedCandidate)) {
            $compilerCandidates.Add($resolvedCandidate)
        }
    }
    $compilerPath = @(
        $compilerCandidates |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    ) | Select-Object -First 1
    if (-not $compilerPath) {
        throw 'Unable to find the Windows C# compiler. Set MCP_CSC_EXECUTABLE to an absolute csc.exe path.'
    }

    New-Item -ItemType Directory -Force -Path $toolDirectory | Out-Null
    $temporaryExecutablePath = Join-Path $toolDirectory (
        '.McpNodeHostLauncher.' + [guid]::NewGuid().ToString('N') + '.exe'
    )
    try {
        $compilerArguments = @(
            '/nologo',
            '/target:winexe',
            '/optimize+',
            '/platform:x64',
            "/out:$temporaryExecutablePath",
            $sourcePath
        )
        $global:LASTEXITCODE = 0
        & $compilerPath @compilerArguments
        $compilerExitCode = [int]$global:LASTEXITCODE
        if ($compilerExitCode -ne 0) {
            throw "Native Node host launcher compilation failed with exit code $compilerExitCode."
        }
        if (-not (Test-Path -LiteralPath $temporaryExecutablePath -PathType Leaf)) {
            throw 'Native Node host launcher compiler did not produce the expected executable.'
        }

        Move-Item -LiteralPath $temporaryExecutablePath -Destination $executablePath -Force
        $executableHash = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-McpJsonFile -Path $metadataPath -Value ([ordered]@{
            version = $toolVersion
            sourcePath = (Get-McpNodeHostLauncherSourceRelativePath)
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

function Get-McpCredentialBrokerSourceRelativePath {
    return 'tooling\windows-credential-broker\McpCredentialBroker.cs'
}

function Get-McpReleaseCredentialBrokerSourcePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReleaseRoot
    )

    $sourcePath = Join-Path (
        [System.IO.Path]::GetFullPath($ReleaseRoot)
    ) (Get-McpCredentialBrokerSourceRelativePath)
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Credential broker source not found in release: $sourcePath"
    }
    return $sourcePath
}

function Get-McpCredentialBrokerExecutable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,

        [Parameter(Mandatory = $true)]
        [string]$ReleaseRoot
    )

    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw 'The MCP credential broker is supported only on Windows.'
    }

    $resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
    $sourcePath = Get-McpReleaseCredentialBrokerSourcePath -ReleaseRoot $ReleaseRoot
    $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $toolVersion = '1.0.0-' + $sourceHash.Substring(0, 12)
    $toolDirectory = Join-Path $resolvedProjectRoot ".runtime-tools\mcp-credential-broker\$toolVersion"
    $executablePath = Join-Path $toolDirectory 'McpCredentialBroker.exe'
    $metadataPath = Join-Path $toolDirectory 'metadata.json'

    if (
        (Test-Path -LiteralPath $executablePath -PathType Leaf) -and
        (Test-Path -LiteralPath $metadataPath -PathType Leaf)
    ) {
        try {
            $metadata = Read-McpJsonFile -Path $metadataPath
            $executableHash = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
            if (
                [string]$metadata.version -eq $toolVersion -and
                [string]$metadata.sourceSha256 -eq $sourceHash -and
                [string]$metadata.executableSha256 -eq $executableHash
            ) {
                return $executablePath
            }
        }
        catch {
        }
    }

    $compilerCandidates = [System.Collections.Generic.List[string]]::new()
    $explicitCompiler = [string]$env:MCP_CSC_EXECUTABLE
    if (-not [string]::IsNullOrWhiteSpace($explicitCompiler)) {
        $compilerCandidates.Add([System.IO.Path]::GetFullPath($explicitCompiler))
    }
    foreach ($candidate in @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    )) {
        $resolvedCandidate = [System.IO.Path]::GetFullPath($candidate)
        if (-not $compilerCandidates.Contains($resolvedCandidate)) {
            $compilerCandidates.Add($resolvedCandidate)
        }
    }
    $compilerPath = @(
        $compilerCandidates |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    ) | Select-Object -First 1
    if (-not $compilerPath) {
        throw 'Unable to find the Windows C# compiler for the credential broker.'
    }

    New-Item -ItemType Directory -Force -Path $toolDirectory | Out-Null
    $temporaryExecutablePath = Join-Path $toolDirectory (
        '.McpCredentialBroker.' + [guid]::NewGuid().ToString('N') + '.exe'
    )
    try {
        $compilerArguments = @(
            '/nologo',
            '/target:winexe',
            '/optimize+',
            '/platform:x64',
            '/reference:System.Windows.Forms.dll',
            '/reference:System.Drawing.dll',
            "/out:$temporaryExecutablePath",
            $sourcePath
        )
        $global:LASTEXITCODE = 0
        & $compilerPath @compilerArguments
        $compilerExitCode = [int]$global:LASTEXITCODE
        if ($compilerExitCode -ne 0) {
            throw "Credential broker compilation failed with exit code $compilerExitCode."
        }
        if (-not (Test-Path -LiteralPath $temporaryExecutablePath -PathType Leaf)) {
            throw 'Credential broker compiler did not produce the expected executable.'
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

function Invoke-McpNativeCommandCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string[]]$Arguments = @(),

        [string]$WorkingDirectory = (Get-McpProjectRoot)
    )

    Push-Location $WorkingDirectory
    try {
        $global:LASTEXITCODE = 0
        $output = @(& $FilePath @Arguments)
        $exitCode = [int]$global:LASTEXITCODE
        if ($exitCode -ne 0) {
            throw "$FilePath exited with code $exitCode."
        }
        return $output
    }
    finally {
        Pop-Location
    }
}

function Invoke-McpNativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string[]]$Arguments = @(),

        [string]$WorkingDirectory = (Get-McpProjectRoot)
    )

    Invoke-McpNativeCommandCapture `
        -FilePath $FilePath `
        -Arguments $Arguments `
        -WorkingDirectory $WorkingDirectory
}

function Wait-McpHttpEndpoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,

        [int]$TimeoutSeconds = 90,

        [int[]]$AcceptedStatusCodes = @(200)
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastError = $null
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 5
            if ($AcceptedStatusCodes -contains [int]$response.StatusCode) {
                return $response
            }
            $lastError = "Unexpected HTTP status $($response.StatusCode)."
        }
        catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 500
    }

    throw "Endpoint did not become ready within $TimeoutSeconds seconds: $Uri. Last error: $lastError"
}

function Test-McpProcessAlive {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Assert-McpPortsFree {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$Ports
    )

    foreach ($port in $Ports) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener) {
            throw "TCP port $port is already in use by PID $($listener.OwningProcess)."
        }
    }
}

function Export-McpGitSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$Commit,

        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    $resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
    if (Test-Path -LiteralPath $resolvedDestination) {
        throw "Snapshot destination already exists: $resolvedDestination"
    }

    $global:LASTEXITCODE = 0
    $repositoryRoot = (& git -C $resolvedRoot rev-parse --show-toplevel).Trim()
    $repositoryExitCode = [int]$global:LASTEXITCODE
    if ($repositoryExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($repositoryRoot)) {
        throw "Unable to resolve the Git repository for: $resolvedRoot"
    }

    $global:LASTEXITCODE = 0
    $projectPrefix = (& git -C $resolvedRoot rev-parse --show-prefix).Trim()
    $prefixExitCode = [int]$global:LASTEXITCODE
    if ($prefixExitCode -ne 0) {
        throw "Unable to resolve the Git project prefix for: $resolvedRoot"
    }

    $archivePath = $resolvedDestination + '.tar'
    $parentDirectory = Split-Path -Parent $resolvedDestination
    if ($parentDirectory) {
        New-Item -ItemType Directory -Force -Path $parentDirectory | Out-Null
    }

    try {
        $archiveArguments = @(
            '-C', $repositoryRoot,
            'archive',
            '--format=tar',
            '--output', $archivePath,
            $Commit
        )

        $global:LASTEXITCODE = 0
        & git @archiveArguments
        $archiveExitCode = [int]$global:LASTEXITCODE
        if ($archiveExitCode -ne 0) {
            throw "Unable to export Git commit $Commit."
        }

        New-Item -ItemType Directory -Path $resolvedDestination | Out-Null
        [System.Formats.Tar.TarFile]::ExtractToDirectory(
            $archivePath,
            $resolvedDestination,
            $false
        )

        $snapshotRoot = if ([string]::IsNullOrWhiteSpace($projectPrefix)) {
            $resolvedDestination
        }
        else {
            Join-Path $resolvedDestination ($projectPrefix.TrimEnd('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar))
        }

        if (-not (Test-Path -LiteralPath $snapshotRoot -PathType Container)) {
            throw "Exported project root was not found: $snapshotRoot"
        }

        return [System.IO.Path]::GetFullPath($snapshotRoot)
    }
    catch {
        if (Test-Path -LiteralPath $resolvedDestination) {
            Remove-Item -LiteralPath $resolvedDestination -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw
    }
    finally {
        Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    }
}

function Get-McpReleaseHostScriptNames {
    return @(
        'Common.ps1',
        'Run-DockerHostComponent.mjs'
    )
}

function Copy-McpReleaseHostScripts {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRoot,

        [Parameter(Mandatory = $true)]
        [string]$DestinationRoot
    )

    $resolvedSourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)
    $resolvedDestinationRoot = [System.IO.Path]::GetFullPath($DestinationRoot)
    $sourceDirectory = Join-Path $resolvedSourceRoot 'deploy\docker\scripts'
    $destinationDirectory = Join-Path $resolvedDestinationRoot 'deploy\docker\scripts'
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null

    foreach ($scriptName in Get-McpReleaseHostScriptNames) {
        $sourcePath = Join-Path $sourceDirectory $scriptName
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Required host runtime script is missing: $sourcePath"
        }
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $destinationDirectory $scriptName)
    }

    $launcherSourceRelativePath = Get-McpNodeHostLauncherSourceRelativePath
    $launcherSourcePath = Join-Path $resolvedSourceRoot $launcherSourceRelativePath
    if (-not (Test-Path -LiteralPath $launcherSourcePath -PathType Leaf)) {
        throw "Native Node host launcher source is missing: $launcherSourcePath"
    }
    $launcherDestinationPath = Join-Path $resolvedDestinationRoot $launcherSourceRelativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcherDestinationPath) | Out-Null
    Copy-Item -LiteralPath $launcherSourcePath -Destination $launcherDestinationPath

    $brokerSourceRelativePath = Get-McpCredentialBrokerSourceRelativePath
    $brokerSourcePath = Join-Path $resolvedSourceRoot $brokerSourceRelativePath
    if (-not (Test-Path -LiteralPath $brokerSourcePath -PathType Leaf)) {
        throw "Credential broker source is missing: $brokerSourcePath"
    }
    $brokerDestinationPath = Join-Path $resolvedDestinationRoot $brokerSourceRelativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $brokerDestinationPath) | Out-Null
    Copy-Item -LiteralPath $brokerSourcePath -Destination $brokerDestinationPath
}

function Get-McpReleaseHostRunnerPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReleaseRoot
    )

    $runnerPath = Join-Path ([System.IO.Path]::GetFullPath($ReleaseRoot)) 'deploy\docker\scripts\Run-DockerHostComponent.mjs'
    if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
        throw "Immutable host component runner not found in release: $runnerPath"
    }
    return $runnerPath
}

function Get-McpReleasePointerPath {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('active', 'candidate')]
        [string]$Name,

        [string]$Root = (Get-McpProjectRoot)
    )

    return Join-Path ([System.IO.Path]::GetFullPath($Root)) "releases\$Name.json"
}

function Read-McpReleasePointer {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('active', 'candidate')]
        [string]$Name,

        [string]$Root = (Get-McpProjectRoot),

        [switch]$AllowMissing
    )

    $pointerPath = Get-McpReleasePointerPath -Name $Name -Root $Root
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) {
        if ($AllowMissing) { return $null }
        throw "Release pointer is missing: $Name"
    }
    return Read-McpJsonFile -Path $pointerPath
}

function Assert-McpGitHubCiRunEvidence {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Run,

        [Parameter(Mandatory = $true)]
        [long]$RunId,

        [Parameter(Mandatory = $true)]
        [ValidatePattern('^[a-f0-9]{40}$')]
        [string]$ExpectedCommit
    )

    $requiredProperties = @(
        'databaseId',
        'headSha',
        'status',
        'conclusion',
        'workflowName',
        'event',
        'headBranch',
        'url'
    )
    foreach ($propertyName in $requiredProperties) {
        if (-not $Run.PSObject.Properties[$propertyName]) {
            throw "GitHub CI run evidence is missing property: $propertyName"
        }
    }

    if ([long]$Run.databaseId -ne $RunId) {
        throw 'GitHub CI run ID does not match the requested run.'
    }
    if ([string]$Run.headSha -ne $ExpectedCommit) {
        throw 'GitHub CI run commit does not match the release commit.'
    }
    if ([string]$Run.status -ne 'completed' -or [string]$Run.conclusion -ne 'success') {
        throw 'GitHub CI run is not completed successfully.'
    }
    if ([string]$Run.workflowName -ne 'CI') {
        throw 'GitHub CI attestation must come from the canonical CI workflow.'
    }
    if ([string]$Run.event -ne 'push' -or [string]$Run.headBranch -ne 'main') {
        throw 'GitHub CI attestation must come from a push of the canonical main branch.'
    }

    return [ordered]@{
        mode = 'github-actions'
        provider = 'github-actions'
        runId = [long]$Run.databaseId
        workflowName = [string]$Run.workflowName
        event = [string]$Run.event
        branch = [string]$Run.headBranch
        headSha = [string]$Run.headSha
        conclusion = [string]$Run.conclusion
        verifiedAt = [DateTimeOffset]::UtcNow.ToString('O')
        url = [string]$Run.url
    }
}

function Get-McpGitHubCiAttestation {
    param(
        [Parameter(Mandatory = $true)]
        [long]$RunId,

        [Parameter(Mandatory = $true)]
        [ValidatePattern('^[a-f0-9]{40}$')]
        [string]$ExpectedCommit
    )

    Assert-McpCommand -Name 'gh'
    $raw = @(& gh run view $RunId --json databaseId,headSha,status,conclusion,workflowName,event,headBranch,url 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read GitHub CI run $RunId."
    }

    try {
        $run = ($raw -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw "GitHub CI run $RunId returned invalid JSON."
    }

    return Assert-McpGitHubCiRunEvidence -Run $run -RunId $RunId -ExpectedCommit $ExpectedCommit
}

function Assert-McpReleasePointerEligible {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Pointer,

        [string]$Root = (Get-McpProjectRoot)
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    $releasesRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot 'releases'))
    $releaseId = [string]$Pointer.releaseId
    $releasePath = [System.IO.Path]::GetFullPath([string]$Pointer.path)
    if ($releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw 'Release pointer contains an invalid release ID.'
    }
    $releasePrefix = $releasesRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $releasePath.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Release pointer path is outside the releases directory.'
    }
    if ([System.IO.Path]::GetFileName($releasePath) -ne $releaseId) {
        throw 'Release pointer path does not match its release ID.'
    }

    $manifestPath = Join-Path $releasePath 'manifest.json'
    $manifest = Read-McpJsonFile -Path $manifestPath

    if ($manifest.PSObject.Properties['validation']) {
        $validation = $manifest.validation
        if (-not $validation.PSObject.Properties['mode']) {
            throw "Release validation evidence is malformed: $releaseId"
        }

        switch ([string]$validation.mode) {
            'local-check' {
                if (
                    -not $validation.PSObject.Properties['command'] -or
                    [string]$validation.command -ne 'npm run check'
                ) {
                    throw "Local release validation evidence is invalid: $releaseId"
                }
            }
            'github-actions' {
                $requiredValidationProperties = @(
                    'provider',
                    'runId',
                    'workflowName',
                    'event',
                    'branch',
                    'headSha',
                    'conclusion',
                    'verifiedAt'
                )
                foreach ($propertyName in $requiredValidationProperties) {
                    if (-not $validation.PSObject.Properties[$propertyName]) {
                        throw "GitHub release validation evidence is incomplete: $releaseId"
                    }
                }
                if (
                    [string]$validation.provider -ne 'github-actions' -or
                    [long]$validation.runId -le 0 -or
                    [string]$validation.workflowName -ne 'CI' -or
                    [string]$validation.event -ne 'push' -or
                    [string]$validation.branch -ne 'main' -or
                    [string]$validation.headSha -ne [string]$manifest.commit -or
                    [string]$validation.conclusion -ne 'success'
                ) {
                    throw "GitHub release validation evidence is invalid: $releaseId"
                }
                $verifiedAt = [DateTimeOffset]::MinValue
                if (-not [DateTimeOffset]::TryParse(
                    [string]$validation.verifiedAt,
                    [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::RoundtripKind,
                    [ref]$verifiedAt
                )) {
                    throw "GitHub release validation timestamp is invalid: $releaseId"
                }
            }
            default {
                throw "Release validation mode is not eligible: $releaseId"
            }
        }
    }

    if (
        [string]$manifest.releaseId -ne $releaseId -or
        [string]$manifest.commit -ne [string]$Pointer.commit -or
        $manifest.testsPassed -ne $true -or
        $manifest.dirty -eq $true -or
        [string]$manifest.source -ne 'clean-git-snapshot'
    ) {
        throw "Release pointer is not eligible: $releaseId"
    }

    return [pscustomobject]@{
        releaseId = $releaseId
        path = $releasePath
        commit = [string]$manifest.commit
        manifest = $manifest
    }
}

function Write-McpReleasePointer {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('active', 'candidate')]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [object]$Value,

        [string]$Root = (Get-McpProjectRoot)
    )

    Write-McpJsonFile -Path (Get-McpReleasePointerPath -Name $Name -Root $Root) -Value $Value
}

function Get-McpReleaseIdFromText {
    param([AllowEmptyString()][string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $normalizedText = $Text.Replace('\', '/')
    $matches = [regex]::Matches($normalizedText, '(?i)(?:^|/)releases/(?<id>[A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:/|$)')
    $ids = @($matches | ForEach-Object { [string]$_.Groups['id'].Value } | Select-Object -Unique)
    if ($ids.Count -gt 1) {
        throw 'Scheduled task references multiple release IDs.'
    }
    if ($ids.Count -eq 0) { return $null }
    return $ids[0]
}

function Get-McpScheduledTaskReleaseId {
    param([Parameter(Mandatory = $true)][object]$Task)

    $ids = [System.Collections.Generic.List[string]]::new()
    foreach ($action in @($Task.Actions)) {
        foreach ($text in @([string]$action.WorkingDirectory, [string]$action.Arguments)) {
            $id = Get-McpReleaseIdFromText -Text $text
            if ($id -and -not $ids.Contains($id)) { $ids.Add($id) }
        }
    }
    if ($ids.Count -gt 1) {
        throw 'Scheduled task action and working directory reference different releases.'
    }
    if ($ids.Count -eq 0) { return $null }
    return $ids[0]
}

function Get-McpScheduledTaskNodeRuntimeDescriptor {
    param([Parameter(Mandatory = $true)][object]$Task)

    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) {
        return [pscustomobject]@{
            mode = 'invalid'
            nodePath = $null
            runtimeRoot = $null
            releaseId = $null
        }
    }

    $arguments = [string]$actions[0].Arguments
    $directMatch = [regex]::Match(
        $arguments,
        '(?i)(?:^|\s)--node\s+(?:"(?<quoted>[^"]+)"|(?<bare>\S+))'
    )
    $runtimeRootMatch = [regex]::Match(
        $arguments,
        '(?i)(?:^|\s)--node-runtime-root\s+(?:"(?<quoted>[^"]+)"|(?<bare>\S+))'
    )
    $releaseIdMatch = [regex]::Match(
        $arguments,
        '(?i)(?:^|\s)--node-release-id\s+(?:"(?<quoted>[^"]+)"|(?<bare>\S+))'
    )

    $hasDirect = $directMatch.Success
    $hasRuntimeRoot = $runtimeRootMatch.Success
    $hasReleaseId = $releaseIdMatch.Success
    if ($hasDirect -and -not $hasRuntimeRoot -and -not $hasReleaseId) {
        $nodePath = if ($directMatch.Groups['quoted'].Success) {
            [string]$directMatch.Groups['quoted'].Value
        }
        else {
            [string]$directMatch.Groups['bare'].Value
        }
        return [pscustomobject]@{
            mode = 'direct-pinned'
            nodePath = $nodePath
            runtimeRoot = $null
            releaseId = $null
        }
    }
    if (-not $hasDirect -and $hasRuntimeRoot -and $hasReleaseId) {
        $runtimeRoot = if ($runtimeRootMatch.Groups['quoted'].Success) {
            [string]$runtimeRootMatch.Groups['quoted'].Value
        }
        else {
            [string]$runtimeRootMatch.Groups['bare'].Value
        }
        $releaseId = if ($releaseIdMatch.Groups['quoted'].Success) {
            [string]$releaseIdMatch.Groups['quoted'].Value
        }
        else {
            [string]$releaseIdMatch.Groups['bare'].Value
        }
        return [pscustomobject]@{
            mode = 'managed'
            nodePath = $null
            runtimeRoot = $runtimeRoot
            releaseId = $releaseId
        }
    }

    return [pscustomobject]@{
        mode = if (-not $hasDirect -and -not $hasRuntimeRoot -and -not $hasReleaseId) { 'unknown' } else { 'invalid' }
        nodePath = $null
        runtimeRoot = $null
        releaseId = $null
    }
}

function Get-McpCanonicalEnvironmentName {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('development', 'production')]
        [string]$Environment
    )

    if ($Environment -eq 'development') {
        return 'development'
    }
    return 'production'
}

function Get-McpEnvironmentPolicyDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('development', 'production')]
        [string]$Environment,

        [string]$LocalApplicationDataRoot
    )

    if ([string]::IsNullOrWhiteSpace($LocalApplicationDataRoot)) {
        $LocalApplicationDataRoot = [Environment]::GetFolderPath('LocalApplicationData')
    }
    if ([string]::IsNullOrWhiteSpace($LocalApplicationDataRoot)) {
        throw 'Unable to resolve LocalApplicationData for environment policy storage.'
    }

    $canonicalEnvironment = Get-McpCanonicalEnvironmentName -Environment $Environment
    return Join-Path $LocalApplicationDataRoot "McpAccessStack\environments\$canonicalEnvironment\workspace-agent"
}

function Install-McpEnvironmentPolicySnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('development', 'production')]
        [string]$Environment,

        [Parameter(Mandatory = $true)]
        [string]$SourcePolicyPath,

        [string]$LocalApplicationDataRoot
    )

    $sourcePath = [System.IO.Path]::GetFullPath($SourcePolicyPath)
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Workspace policy not found: $sourcePath"
    }

    try {
        $policy = Get-Content -LiteralPath $sourcePath -Raw | ConvertFrom-Json -Depth 64
    }
    catch {
        throw "Workspace policy is not valid JSON: $($_.Exception.Message)"
    }
    if ([int]$policy.version -ne 1 -or $null -eq $policy.workspaces) {
        throw 'Workspace policy does not contain the expected version/workspaces structure.'
    }

    $sourceBytes = [System.IO.File]::ReadAllBytes($sourcePath)
    $sourceSha256 = [Convert]::ToHexString(
        [System.Security.Cryptography.SHA256]::HashData($sourceBytes)
    ).ToLowerInvariant()
    $policyDirectory = Get-McpEnvironmentPolicyDirectory `
        -Environment $Environment `
        -LocalApplicationDataRoot $LocalApplicationDataRoot
    New-Item -ItemType Directory -Force -Path $policyDirectory | Out-Null

    $policyPath = Join-Path $policyDirectory 'policy.json'
    $temporaryPath = Join-Path $policyDirectory ('.policy.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllBytes($temporaryPath, $sourceBytes)
        Move-Item -LiteralPath $temporaryPath -Destination $policyPath -Force
    }
    finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }

    $installedBytes = [System.IO.File]::ReadAllBytes($policyPath)
    $installedSha256 = [Convert]::ToHexString(
        [System.Security.Cryptography.SHA256]::HashData($installedBytes)
    ).ToLowerInvariant()
    if ($installedSha256 -ne $sourceSha256) {
        throw 'Environment policy snapshot integrity check failed.'
    }

    $canonicalEnvironment = Get-McpCanonicalEnvironmentName -Environment $Environment
    $manifestPath = Join-Path $policyDirectory 'policy.manifest.json'
    Write-McpJsonFile -Path $manifestPath -Value ([ordered]@{
        schemaVersion = 1
        environment = $canonicalEnvironment
        runtimeEnvironmentId = $Environment
        policySha256 = $installedSha256
        workspaceCount = @($policy.workspaces).Count
        installedAt = [DateTimeOffset]::UtcNow.ToString('O')
    })

    return [pscustomobject]@{
        environment = $canonicalEnvironment
        runtimeEnvironmentId = $Environment
        policyPath = $policyPath
        manifestPath = $manifestPath
        policySha256 = $installedSha256
        workspaceCount = @($policy.workspaces).Count
    }
}
function Get-McpComposeArguments {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('development', 'production')]
        [string]$Environment
    )

    $root = Get-McpProjectRoot
    $composeFile = Join-Path $root "deploy\docker\compose.$Environment.yml"
    $envFile = Join-Path $root ".runtime-private\docker\$Environment\compose.env"
    return @('--env-file', $envFile, '-f', $composeFile)
}

function Invoke-McpBrowserBootstrap {
    param(
        [Parameter(Mandatory = $true)]
        [ValidatePattern('^https?://')]
        [string]$Uri,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Token,

        [ValidateRange(1, 900)]
        [int]$TimeoutSeconds = 120
    )

    if ([string]::IsNullOrWhiteSpace($Token)) {
        throw 'Browser Worker bootstrap token is unavailable.'
    }

    $body = [ordered]@{
        operation = 'connect'
        input = [ordered]@{}
    } | ConvertTo-Json -Depth 4 -Compress

    try {
        $response = Invoke-WebRequest `
            -Uri $Uri `
            -Method Post `
            -Headers @{
                Authorization = "Bearer $Token"
                'x-mcp-call-id' = ('production-bootstrap-{0}' -f [guid]::NewGuid().ToString('N'))
            } `
            -ContentType 'application/json' `
            -Body $body `
            -UseBasicParsing `
            -TimeoutSec $TimeoutSeconds
    }
    catch {
        throw "Browser Worker bootstrap request failed: $($_.Exception.Message)"
    }

    if ([int]$response.StatusCode -ne 200) {
        throw "Browser Worker bootstrap returned HTTP $([int]$response.StatusCode)."
    }

    try {
        $payload = [string]$response.Content | ConvertFrom-Json -Depth 16
    }
    catch {
        throw 'Browser Worker bootstrap returned invalid JSON.'
    }
    if ($payload.ok -ne $true -or $payload.result.ready -ne $true) {
        throw 'Browser Worker bootstrap did not reach ready state.'
    }

    return $payload.result
}

function Set-McpObjectProperty {
    param(
        [Parameter(Mandatory = $true)]
        [object]$InputObject,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [AllowNull()]
        [object]$Value
    )

    $property = $InputObject.PSObject.Properties[$Name]
    if ($property) {
        $property.Value = $Value
        return
    }

    $InputObject | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
}
. (Join-Path $PSScriptRoot 'NodeRuntime.Common.ps1')
