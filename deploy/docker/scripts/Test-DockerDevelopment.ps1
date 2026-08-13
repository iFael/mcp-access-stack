[CmdletBinding()]
param(
    [switch]$Resilience,
    [int]$ReadyTimeoutSeconds = 120
)

. (Join-Path $PSScriptRoot 'Common.ps1')

Assert-McpCommand -Name 'docker'
Assert-McpCommand -Name 'node'

$root = Get-McpProjectRoot
$composeArguments = Get-McpComposeArguments -Environment 'development'

function Invoke-DevelopmentSmoke {
    Push-Location $root
    try {
        & node 'deploy/docker/scripts/smoke-development.mjs'
        if ($LASTEXITCODE -ne 0) {
            throw 'Development environment MCP smoke test failed.'
        }
    }
    finally {
        Pop-Location
    }
}

function Wait-DevelopmentReady {
    Wait-McpHttpEndpoint -Uri 'http://127.0.0.1:4310/health/live' -TimeoutSeconds $ReadyTimeoutSeconds | Out-Null
    Wait-McpHttpEndpoint -Uri 'http://127.0.0.1:4310/health/ready' -TimeoutSeconds $ReadyTimeoutSeconds | Out-Null
    Wait-McpHttpEndpoint -Uri 'http://127.0.0.1:4300/health/live' -TimeoutSeconds $ReadyTimeoutSeconds | Out-Null
}

function Assert-ContainerSecurity {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Service
    )

    Push-Location $root
    try {
        $containerId = (& docker compose @composeArguments ps -q $Service).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $containerId) {
            throw "Container is not running: $Service"
        }
        $inspection = (& docker inspect $containerId | ConvertFrom-Json)[0]
        if (-not $inspection.Config.User -or $inspection.Config.User -eq '0' -or $inspection.Config.User -eq 'root') {
            throw "$Service is running as root."
        }
        if (-not $inspection.HostConfig.ReadonlyRootfs) {
            throw "$Service does not use a read-only root filesystem."
        }
        if (@($inspection.HostConfig.CapDrop) -notcontains 'ALL') {
            throw "$Service does not drop all Linux capabilities."
        }
        if (@($inspection.HostConfig.SecurityOpt) -notcontains 'no-new-privileges:true') {
            throw "$Service does not enforce no-new-privileges."
        }
    }
    finally {
        Pop-Location
    }
}

Wait-DevelopmentReady
Assert-ContainerSecurity -Service 'gateway'
Assert-ContainerSecurity -Service 'proxy'
Invoke-DevelopmentSmoke

if ($Resilience) {
    Push-Location $root
    try {
        & docker compose @composeArguments restart gateway
        if ($LASTEXITCODE -ne 0) { throw 'Gateway restart failed.' }
    }
    finally {
        Pop-Location
    }
    Wait-DevelopmentReady
    Invoke-DevelopmentSmoke

    Push-Location $root
    try {
        & docker compose @composeArguments restart proxy
        if ($LASTEXITCODE -ne 0) { throw 'Proxy restart failed.' }
    }
    finally {
        Pop-Location
    }
    Wait-DevelopmentReady
    Invoke-DevelopmentSmoke
}

Write-Output "Docker development environment validation passed. Resilience tests: $Resilience"
