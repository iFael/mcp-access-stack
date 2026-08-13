$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Write-Output 'Credential broker test skipped: Windows is required.'
    exit 0
}

. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Get-McpProjectRoot
$sourcePath = Join-Path $root (Get-McpCredentialBrokerSourceRelativePath)
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Credential broker source is missing: $sourcePath"
}
$source = Get-Content -Raw -LiteralPath $sourcePath
foreach ($forbidden in @(
    'Console.Write',
    'Console.Error',
    'Environment.GetEnvironmentVariable',
    '--username',
    '--password'
)) {
    if ($source.Contains($forbidden)) {
        throw "Credential broker source contains a forbidden secret transport or console surface: $forbidden"
    }
}
foreach ($required in @(
    'NamedPipeServerStream',
    'PipeSecurity',
    'WindowsIdentity.GetCurrent',
    'CredReadW',
    'CredWriteW',
    'CredDeleteW',
    'RequireCredentialTarget',
    '^McpAccessStack/',
    'UseSystemPasswordChar = true',
    'Array.Clear'
)) {
    if (-not $source.Contains($required)) {
        throw "Credential broker source is missing required hardening: $required"
    }
}

$broker = Get-McpCredentialBrokerExecutable -ProjectRoot $root -ReleaseRoot $root
if (-not (Test-Path -LiteralPath $broker -PathType Leaf)) {
    throw 'Credential broker compilation did not produce an executable.'
}

$pipeName = 'mcp-credential-broker-test-' + [guid]::NewGuid().ToString('N')
$nonce = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$target = 'McpAccessStack/000000000000000000000000/test/' + [guid]::NewGuid().ToString('N')
$arguments = @(
    '--mode', 'read',
    '--pipe', $pipeName,
    '--nonce', $nonce,
    '--target', $target,
    '--protocol', '1',
    '--client-pid', [string]$PID,
    '--timeout-ms', '10000'
)

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $broker
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.RedirectStandardOutput = $false
$startInfo.RedirectStandardError = $false
foreach ($argument in $arguments) {
    if ($argument.Contains('"')) {
        throw 'Credential broker test argument contains an unsupported quote.'
    }
    $startInfo.Arguments += if ($startInfo.Arguments.Length -eq 0) {
        '"' + $argument + '"'
    }
    else {
        ' "' + $argument + '"'
    }
}

$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) {
    throw 'Credential broker process did not start.'
}

$pipe = [IO.Pipes.NamedPipeClientStream]::new(
    '.',
    $pipeName,
    [IO.Pipes.PipeDirection]::In,
    [IO.Pipes.PipeOptions]::None
)
try {
    $pipe.Connect(10000)
    $reader = [IO.BinaryReader]::new($pipe, [Text.Encoding]::UTF8, $true)
    try {
        $magic = [Text.Encoding]::ASCII.GetString($reader.ReadBytes(8))
        $version = $reader.ReadInt32()
        $status = $reader.ReadInt32()
        $processId = $reader.ReadInt32()
        $nonceLength = $reader.ReadInt32()
        if ($nonceLength -lt 1 -or $nonceLength -gt 4096) {
            throw "Credential broker nonce length is invalid: $nonceLength"
        }
        $actualNonce = [Text.Encoding]::UTF8.GetString($reader.ReadBytes($nonceLength))
        $usernameLength = $reader.ReadInt32()
        $username = $reader.ReadBytes($usernameLength)
        $passwordLength = $reader.ReadInt32()
        $password = $reader.ReadBytes($passwordLength)

        if ($magic -ne 'MCPCRD01') { throw "Unexpected broker magic: $magic" }
        if ($version -ne 1) { throw "Unexpected broker protocol version: $version" }
        if ($status -ne 1) { throw "Missing credential must return unavailable status 1, got $status" }
        if ($processId -ne $process.Id) { throw 'Credential broker process identity mismatch.' }
        if ($actualNonce -ne $nonce) { throw 'Credential broker nonce mismatch.' }
        if ($usernameLength -ne 0 -or $passwordLength -ne 0) {
            throw 'Unavailable credential response must contain zero secret bytes.'
        }
        [Array]::Clear($username, 0, $username.Length)
        [Array]::Clear($password, 0, $password.Length)
    }
    finally {
        $reader.Dispose()
    }
}
finally {
    $pipe.Dispose()
    if (-not $process.WaitForExit(10000)) {
        $process.Kill()
        throw 'Credential broker process did not terminate after the one-shot response.'
    }
    $process.Dispose()
}

Write-Output 'Credential broker test passed: compiled helper, one-shot ACL pipe and unavailable response are valid.'
