[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$RemoteHost,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$RemoteUser,

    [int]$RemoteSshPort = 22,

    [int]$RemoteForwardPort = 22022,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$PrivateKeyPath,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$KnownHostsPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path -LiteralPath $ssh -PathType Leaf)) {
    throw "Windows OpenSSH client was not found: $ssh"
}

if ($RemoteSshPort -lt 1 -or $RemoteSshPort -gt 65535) {
    throw 'RemoteSshPort must be between 1 and 65535.'
}
if ($RemoteForwardPort -lt 1024 -or $RemoteForwardPort -gt 65535) {
    throw 'RemoteForwardPort must be between 1024 and 65535.'
}

$arguments = @(
    '-N'
    '-T'
    '-o', 'BatchMode=yes'
    '-o', 'StrictHostKeyChecking=yes'
    '-o', "UserKnownHostsFile=$KnownHostsPath"
    '-o', 'IdentitiesOnly=yes'
    '-o', 'ExitOnForwardFailure=yes'
    '-o', 'ServerAliveInterval=30'
    '-o', 'ServerAliveCountMax=3'
    '-i', $PrivateKeyPath
    '-p', [string]$RemoteSshPort
    '-R', "127.0.0.1:${RemoteForwardPort}:127.0.0.1:22"
    "${RemoteUser}@${RemoteHost}"
)

& $ssh @arguments
exit $LASTEXITCODE
