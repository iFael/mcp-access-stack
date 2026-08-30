[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$EdgeBaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$ConnectorTokenFile,

    [Parameter(Mandatory = $true)]
    [string]$OwnerTokenFile,

    [Parameter(Mandatory = $true)]
    [string]$OwnerOAuthStatePath,

    [switch]$Execute
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Execute) {
    throw 'Owner OAuth bootstrap is intentionally gated. Re-run with -Execute.'
}

function Resolve-McpBootstrapFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][long]$MaximumBytes
    )

    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "$Name file was not found: $resolved"
    }
    $item = Get-Item -LiteralPath $resolved -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Name file must not be a reparse point."
    }
    if ($item.Length -le 0 -or $item.Length -gt $MaximumBytes) {
        throw "$Name file size is invalid."
    }
    return $resolved
}

function Read-McpBootstrapToken {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][int]$MinimumLength
    )

    $raw = Get-Content -LiteralPath $Path -Raw
    $token = $raw.Trim()
    if ($token.Length -lt $MinimumLength -or $token.Length -gt 2048 -or $token -match '[\r\n\0]') {
        throw "$Name file contains an invalid token."
    }
    return $token
}

try {
    $edgeUri = [Uri]$EdgeBaseUrl
}
catch {
    throw 'EdgeBaseUrl must be a valid HTTPS origin.'
}
if (-not $edgeUri.IsAbsoluteUri -or
    $edgeUri.Scheme -ne 'https' -or
    [string]::IsNullOrWhiteSpace($edgeUri.Host) -or
    -not [string]::IsNullOrWhiteSpace($edgeUri.UserInfo) -or
    $edgeUri.AbsolutePath -ne '/' -or
    -not [string]::IsNullOrWhiteSpace($edgeUri.Query) -or
    -not [string]::IsNullOrWhiteSpace($edgeUri.Fragment)) {
    throw 'EdgeBaseUrl must be a credential-free HTTPS origin with no path, query or fragment.'
}
$edgeOrigin = $edgeUri.GetLeftPart([UriPartial]::Authority)
$expectedResource = "$edgeOrigin/mcp"
$bootstrapUri = "$edgeOrigin/_internal/owner-oauth/bootstrap"

$stateFile = Resolve-McpBootstrapFile -Path $OwnerOAuthStatePath -Name 'Owner OAuth state' -MaximumBytes (1024 * 1024)
$stateRaw = Get-Content -LiteralPath $stateFile -Raw
try {
    $state = $stateRaw | ConvertFrom-Json
}
catch {
    throw 'Owner OAuth state file contains invalid JSON.'
}
if ($null -eq $state -or [int]$state.version -ne 1 -or [string]$state.resourceServerUrl -ne $expectedResource) {
    throw 'Owner OAuth state does not match the target MCP resource.'
}
$clients = @($state.clients)
$accessTokens = @($state.accessTokens)
$refreshTokens = @($state.refreshTokens)
if ($clients.Count -gt 256 -or $accessTokens.Count -gt 4096 -or $refreshTokens.Count -gt 4096) {
    throw 'Owner OAuth state exceeds the migration limits.'
}
foreach ($client in $clients) {
    if ($null -eq $client -or [string]::IsNullOrWhiteSpace([string]$client.client_id)) {
        throw 'Owner OAuth state contains an invalid client record.'
    }
}
foreach ($record in @($accessTokens + $refreshTokens)) {
    if ($null -eq $record -or [string]$record.hash -notmatch '^[A-Za-z0-9_-]{43}$') {
        throw 'Owner OAuth state contains an invalid token hash record.'
    }
}
$stateSha256 = (Get-FileHash -LiteralPath $stateFile -Algorithm SHA256).Hash.ToLowerInvariant()

$connectorFile = Resolve-McpBootstrapFile -Path $ConnectorTokenFile -Name 'Connector token' -MaximumBytes 4096
$ownerFile = Resolve-McpBootstrapFile -Path $OwnerTokenFile -Name 'Owner token' -MaximumBytes 4096
$connectorToken = $null
$ownerToken = $null
$payload = $null
$headers = $null
try {
    $connectorToken = Read-McpBootstrapToken -Path $connectorFile -Name 'Connector token' -MinimumLength 32
    $ownerToken = Read-McpBootstrapToken -Path $ownerFile -Name 'Owner token' -MinimumLength 16
    if ($stateRaw.Contains($connectorToken) -or $stateRaw.Contains($ownerToken)) {
        throw 'Owner OAuth state must not contain raw credentials.'
    }

    $payload = [ordered]@{
        ownerToken = $ownerToken
        state = $state
    } | ConvertTo-Json -Depth 64 -Compress
    $headers = @{
        Authorization = "Bearer $connectorToken"
        Accept = 'application/json'
    }

    try {
        $response = Invoke-WebRequest `
            -UseBasicParsing `
            -Uri $bootstrapUri `
            -Method Post `
            -Headers $headers `
            -ContentType 'application/json' `
            -Body $payload `
            -TimeoutSec 30
    }
    catch {
        $statusCode = $null
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        $details = [string]$_.ErrorDetails.Message
        if ($statusCode -eq 409 -and $details.Contains('owner_bootstrap_already_complete')) {
            [pscustomobject]@{
                status = 'already-complete'
                httpStatus = 409
                stateSha256 = $stateSha256
                resource = $expectedResource
                clients = $clients.Count
                accessTokens = $accessTokens.Count
                refreshTokens = $refreshTokens.Count
            } | ConvertTo-Json -Compress
            return
        }
        if ($null -eq $statusCode) {
            throw 'Owner OAuth bootstrap request failed before receiving an HTTP response.'
        }
        throw "Owner OAuth bootstrap request failed with HTTP $statusCode."
    }

    if ([int]$response.StatusCode -ne 200) {
        throw "Owner OAuth bootstrap returned unexpected HTTP status $([int]$response.StatusCode)."
    }
    try {
        $responseBody = $response.Content | ConvertFrom-Json
    }
    catch {
        throw 'Owner OAuth bootstrap returned invalid JSON.'
    }
    if ([string]$responseBody.status -ne 'bootstrapped') {
        throw 'Owner OAuth bootstrap did not return the expected completion status.'
    }

    [pscustomobject]@{
        status = 'bootstrapped'
        httpStatus = 200
        stateSha256 = $stateSha256
        resource = $expectedResource
        clients = $clients.Count
        accessTokens = $accessTokens.Count
        refreshTokens = $refreshTokens.Count
    } | ConvertTo-Json -Compress
}
finally {
    $headers = $null
    $payload = $null
    $ownerToken = $null
    $connectorToken = $null
}