export function buildWindowsSshRpcScript(request: unknown): string {
  const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  return `${POWERSHELL_RUNTIME}\n$RequestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))\n$Request = $RequestJson | ConvertFrom-Json\nInvoke-McpRequest -Request $Request\n`;
}

const POWERSHELL_RUNTIME = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Write-McpResult([object]$Result) {
    [Console]::Out.WriteLine((@{ ok = $true; result = $Result } | ConvertTo-Json -Depth 32 -Compress))
}

function Write-McpError([System.Management.Automation.ErrorRecord]$Record) {
    $message = [string]$Record.Exception.Message
    if ($message.Length -gt 800) { $message = $message.Substring(0, 800) }
    [Console]::Out.WriteLine((@{
        ok = $false
        error = @{
            type = $Record.Exception.GetType().FullName
            command = [string]$Record.InvocationInfo.MyCommand.Name
            message = $message
        }
    } | ConvertTo-Json -Depth 8 -Compress))
}

function Normalize-McpLogicalPath([string]$Value, [bool]$AllowDot = $true) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'Path must not be empty.' }
    $portable = $Value.Replace('\', '/')
    if ($portable -match '^[A-Za-z]:' -or $portable.StartsWith('/') -or $portable.StartsWith('//')) {
        throw 'Absolute paths are not allowed.'
    }
    $segments = [Collections.Generic.List[string]]::new()
    foreach ($segment in $portable.Split('/')) {
        if ($segment -eq '' -or $segment -eq '.') { continue }
        if ($segment -eq '..') { throw 'Path traversal is not allowed.' }
        if ($segment.Contains(':') -or $segment.EndsWith('.') -or $segment.EndsWith(' ')) {
            throw 'Path contains an invalid Windows segment.'
        }
        $segments.Add($segment)
    }
    if ($segments.Count -eq 0) {
        if ($AllowDot) { return '.' }
        throw 'Path must identify a file or directory.'
    }
    return [string]::Join('/', $segments)
}

function Get-McpRoot([string]$RootPath) {
    if (-not [IO.Path]::IsPathRooted($RootPath)) { throw 'Workspace root must be absolute.' }
    $root = [IO.Path]::GetFullPath($RootPath).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Workspace root does not exist.' }
    $item = Get-Item -LiteralPath $root -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Workspace root must not be a reparse point.'
    }
    return $root
}

function Test-McpContained([string]$Root, [string]$Candidate) {
    if ($Candidate.Equals($Root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $Candidate.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-McpNoReparseAncestors([string]$Root, [string]$Candidate, [bool]$IncludeLeaf) {
    $relative = [IO.Path]::GetRelativePath($Root, $Candidate)
    if ($relative -eq '.') { return }
    $segments = $relative.Split([char]'\', [StringSplitOptions]::RemoveEmptyEntries)
    $limit = if ($IncludeLeaf) { $segments.Length } else { [Math]::Max(0, $segments.Length - 1) }
    $cursor = $Root
    for ($i = 0; $i -lt $limit; $i++) {
        $cursor = Join-Path $cursor $segments[$i]
        if (-not (Test-Path -LiteralPath $cursor)) { continue }
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Reparse points are not allowed in workspace paths.'
        }
    }
}

function Resolve-McpPath(
    [string]$RootPath,
    [string]$LogicalPath,
    [ValidateSet('Any','File','Directory','CreateFile')] [string]$Kind = 'Any'
) {
    $root = Get-McpRoot $RootPath
    $logical = Normalize-McpLogicalPath $LogicalPath $true
    $candidate = if ($logical -eq '.') {
        $root
    } else {
        [IO.Path]::GetFullPath((Join-Path $root ($logical.Replace('/', '\'))))
    }
    if (-not (Test-McpContained $root $candidate)) { throw 'Path resolves outside workspace.' }

    if ($Kind -eq 'CreateFile') {
        $parent = [IO.Path]::GetDirectoryName($candidate)
        Assert-McpNoReparseAncestors $root $candidate $false
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            [IO.Directory]::CreateDirectory($parent) | Out-Null
            Assert-McpNoReparseAncestors $root $candidate $false
        }
        if (Test-Path -LiteralPath $candidate) {
            $leaf = Get-Item -LiteralPath $candidate -Force
            if (($leaf.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point target is not allowed.' }
            if (-not $leaf.PSIsContainer -and $leaf.Length -ge 0) { return @{ Root=$root; Logical=$logical; Full=$candidate } }
            throw 'Write target is not a file.'
        }
        return @{ Root=$root; Logical=$logical; Full=$candidate }
    }

    if (-not (Test-Path -LiteralPath $candidate)) { throw 'Requested path does not exist.' }
    Assert-McpNoReparseAncestors $root $candidate $true
    $item = Get-Item -LiteralPath $candidate -Force
    if ($Kind -eq 'File' -and $item.PSIsContainer) { throw 'Requested path is not a file.' }
    if ($Kind -eq 'Directory' -and -not $item.PSIsContainer) { throw 'Requested path is not a directory.' }
    return @{ Root=$root; Logical=$logical; Full=$candidate }
}

function Get-McpRelative([string]$Root, [string]$Full) {
    $relative = [IO.Path]::GetRelativePath($Root, $Full).Replace('\','/')
    if ([string]::IsNullOrEmpty($relative)) { return '.' }
    return $relative
}

function Get-McpSha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([Convert]::ToHexString($sha.ComputeHash($Bytes))).ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function ConvertTo-McpEncodedCommand([string]$Script) {
    return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
}

function Invoke-McpProcess(
    [string]$WorkingDirectory,
    [string]$WrapperScript,
    [int]$TimeoutMs
) {
    $encoded = ConvertTo-McpEncodedCommand $WrapperScript
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'pwsh.exe'
    $psi.Arguments = "-NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded"
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $psi
    if (-not $process.Start()) { throw 'Failed to start remote process.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit($TimeoutMs)
    if ($timedOut) {
        try { $process.Kill($true) } catch { try { $process.Kill() } catch {} }
        $process.WaitForExit()
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = if ($timedOut) { $null } else { $process.ExitCode }
    $process.Dispose()
    return @{
        exitCode = $exitCode
        stdout = $stdout
        stderr = $stderr
        timedOut = $timedOut
    }
}

function Invoke-McpRequest([object]$Request) {
    try {
        switch ([string]$Request.operation) {
            'probe' {
                $root = Get-McpRoot ([string]$Request.rootPath)
                Write-McpResult @{ fullPath=$root; kind='directory' }
                return
            }
            'list' {
                $resolved = Resolve-McpPath ([string]$Request.rootPath) ([string]$Request.logicalRoot) 'Directory'
                $max = [Math]::Max(1, [int]$Request.maxEntries)
                $recursive = [bool]$Request.recursive
                $directoriesOnly = [bool]$Request.directoriesOnly
                $entries = [Collections.Generic.List[object]]::new()
                $queue = [Collections.Generic.Queue[string]]::new()
                $queue.Enqueue([string]$resolved.Full)
                $truncated = $false
                while ($queue.Count -gt 0 -and -not $truncated) {
                    $directory = $queue.Dequeue()
                    foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
                        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                        $relativePath = Get-McpRelative ([string]$resolved.Root) $item.FullName
                        $excluded = $false
                        foreach ($prefixValue in @($Request.excludedPrefixes)) {
                            $prefix = ([string]$prefixValue).Trim('/').ToLowerInvariant()
                            $candidatePath = $relativePath.ToLowerInvariant()
                            if ($prefix -and ($candidatePath -eq $prefix -or $candidatePath.StartsWith($prefix + '/'))) {
                                $excluded = $true
                                break
                            }
                        }
                        if ($excluded) { continue }
                        $kind = if ($item.PSIsContainer) { 'directory' } else { 'file' }
                        if (-not $directoriesOnly -or $kind -eq 'directory') {
                            if ($entries.Count -ge $max) { $truncated = $true; break }
                            $entries.Add(@{
                                path = $relativePath
                                kind = $kind
                                sizeBytes = if ($item.PSIsContainer) { 0 } else { [long]$item.Length }
                            })
                        }
                        if ($recursive -and $item.PSIsContainer) { $queue.Enqueue($item.FullName) }
                    }
                }
                Write-McpResult @{ entries=$entries.ToArray(); truncated=$truncated }
                return
            }
            'readBytes' {
                $resolved = Resolve-McpPath ([string]$Request.rootPath) ([string]$Request.logicalPath) 'File'
                $info = Get-Item -LiteralPath ([string]$resolved.Full) -Force
                if ($info.Length -gt [long]$Request.maxBytes) { throw 'File exceeds configured size limit.' }
                $bytes = [IO.File]::ReadAllBytes([string]$resolved.Full)
                Write-McpResult @{
                    contentBase64=[Convert]::ToBase64String($bytes)
                    sizeBytes=$bytes.Length
                    sha256=Get-McpSha256 $bytes
                }
                return
            }
            'writeBytes' {
                $resolved = Resolve-McpPath ([string]$Request.rootPath) ([string]$Request.logicalPath) 'CreateFile'
                $created = -not (Test-Path -LiteralPath ([string]$resolved.Full) -PathType Leaf)
                if ($Request.expectedSha256 -and -not $created) {
                    $current = [IO.File]::ReadAllBytes([string]$resolved.Full)
                    $actual = Get-McpSha256 $current
                    if (-not $actual.Equals([string]$Request.expectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
                        throw 'File hash changed before write.'
                    }
                }
                $bytes = [Convert]::FromBase64String([string]$Request.contentBase64)
                $parent = [IO.Path]::GetDirectoryName([string]$resolved.Full)
                $temp = Join-Path $parent ('.mcp-ssh-' + [Guid]::NewGuid().ToString('N') + '.tmp')
                try {
                    [IO.File]::WriteAllBytes($temp, $bytes)
                    Move-Item -LiteralPath $temp -Destination ([string]$resolved.Full) -Force
                } finally {
                    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
                }
                Write-McpResult @{ created=$created; sizeBytes=$bytes.Length; sha256=Get-McpSha256 $bytes }
                return
            }
            'exec' {
                $resolved = Resolve-McpPath ([string]$Request.rootPath) ([string]$Request.logicalCwd) 'Directory'
                $inner = @'
$ErrorActionPreference='Continue'
$payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__'))|ConvertFrom-Json
& ([string]$payload.executable) @($payload.args | ForEach-Object { [string]$_ })
exit $(if($null -eq $LASTEXITCODE){0}else{$LASTEXITCODE})
'@
                $execPayload = @{ executable=[string]$Request.executable; args=@($Request.args) } | ConvertTo-Json -Compress
                $execBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($execPayload))
                $inner = $inner.Replace('__PAYLOAD__', $execBase64)
                Write-McpResult (Invoke-McpProcess ([string]$resolved.Full) $inner ([int]$Request.timeoutMs))
                return
            }
            'runShell' {
                $resolved = Resolve-McpPath ([string]$Request.rootPath) ([string]$Request.logicalCwd) 'Directory'
                $inner = @'
$ErrorActionPreference='Continue'
$payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__'))|ConvertFrom-Json
$command=[string]$payload.command
switch([string]$payload.shell){
'powershell' { & powershell.exe -NoLogo -NoProfile -NonInteractive -Command $command }
'pwsh' { & pwsh.exe -NoLogo -NoProfile -NonInteractive -Command $command }
'cmd' { & cmd.exe /d /s /c $command }
'wsl' { & wsl.exe --exec bash -lc $command }
'git-bash' { $bash=(Get-Command bash.exe -ErrorAction Stop).Source; & $bash -lc $command }
default { Write-Error 'Unsupported shell.'; exit 2 }
}
exit $(if($null -eq $LASTEXITCODE){0}else{$LASTEXITCODE})
'@
                $runPayload = @{ shell=[string]$Request.shell; command=[string]$Request.command } | ConvertTo-Json -Compress
                $runBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($runPayload))
                $inner = $inner.Replace('__PAYLOAD__', $runBase64)
                Write-McpResult (Invoke-McpProcess ([string]$resolved.Full) $inner ([int]$Request.timeoutMs))
                return
            }
            default { throw 'Unsupported SSH workspace operation.' }
        }
    } catch {
        Write-McpError $_
        exit 1
    }
}
`;
