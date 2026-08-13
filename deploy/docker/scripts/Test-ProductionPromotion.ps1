[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'Common.ps1'
$lifecycleCommonPath = Join-Path $PSScriptRoot 'ProductionLifecycle.Common.ps1'
$promotionPath = Join-Path $PSScriptRoot 'Promote-McpProduction.ps1'
$detachedPath = Join-Path $PSScriptRoot 'Start-McpProductionPromotion.ps1'
$detachedRunnerPath = Join-Path $PSScriptRoot 'Run-McpProductionPromotionDetached.ps1'

foreach ($path in @($commonPath, $lifecycleCommonPath, $promotionPath, $detachedPath, $detachedRunnerPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required production promotion script is missing: $path"
    }
}

$promotion = Get-Content -Raw -LiteralPath $promotionPath
$detached = Get-Content -Raw -LiteralPath $detachedPath
$detachedRunner = Get-Content -Raw -LiteralPath $detachedRunnerPath
$common = Get-Content -Raw -LiteralPath $commonPath
$lifecycleCommon = Get-Content -Raw -LiteralPath $lifecycleCommonPath

function Assert-MarkersInOrder {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string[]]$Markers,
        [Parameter(Mandatory = $true)][string]$FlowName
    )

    $previousIndex = -1
    foreach ($marker in $Markers) {
        $index = $Content.IndexOf($marker, [StringComparison]::Ordinal)
        if ($index -lt 0) {
            throw "$FlowName marker is missing: $marker"
        }
        if ($index -le $previousIndex) {
            throw "$FlowName marker is out of order: $marker"
        }
        $previousIndex = $index
    }
}

Assert-MarkersInOrder -Content $promotion -FlowName 'Promotion' -Markers @(
    '# PROMOTION_STEP: compose-candidate',
    '# PROMOTION_STEP: gateway-live',
    '# PROMOTION_STEP: stop-previous-hosts',
    '# PROMOTION_STEP: snapshot-browser-registry',
    '# PROMOTION_STEP: install-candidate-hosts',
    '# PROMOTION_STEP: start-candidate-agent',
    '# PROMOTION_STEP: gateway-ready',
    '# PROMOTION_STEP: start-candidate-browser',
    '# PROMOTION_STEP: browser-live',
    '# PROMOTION_STEP: browser-bootstrap',
    '# PROMOTION_STEP: activate-pointer'
)

Assert-MarkersInOrder -Content $promotion -FlowName 'Rollback' -Markers @(
    '# ROLLBACK_STEP: stop-candidate-hosts',
    '# ROLLBACK_STEP: restore-browser-registry',
    '# ROLLBACK_STEP: restore-files-and-tasks',
    '# ROLLBACK_STEP: compose-previous',
    '# ROLLBACK_STEP: start-previous-agent',
    '# ROLLBACK_STEP: start-previous-browser',
    '# ROLLBACK_STEP: browser-bootstrap'
)

Assert-MarkersInOrder -Content $promotion -FlowName 'Promotion preflight' -Markers @(
    "if (-not `$Execute) {",
    '# PREFLIGHT_STEP: administrator',
    "Assert-McpAdministrator -Operation 'Production promotion'",
    '$root = Get-McpProjectRoot'
)

Assert-MarkersInOrder -Content $detached -FlowName 'Detached launcher preflight' -Markers @(
    "if (-not `$Execute) {",
    '# PREFLIGHT_STEP: administrator',
    "Assert-McpAdministrator -Operation 'Detached production promotion launcher'",
    '$root = Get-McpProjectRoot'
)

Assert-MarkersInOrder -Content $detachedRunner -FlowName 'Detached runner preflight' -Markers @(
    "if (-not `$Execute) {",
    '# PREFLIGHT_STEP: administrator',
    "Assert-McpAdministrator -Operation 'Detached production promotion runner'",
    '$root = [System.IO.Path]::GetFullPath($ProjectRoot)'
)

$promotionRequirements = @(
    "[switch]`$Execute",
    "[switch]`$RequireBrowserReady",
    'Assert-McpReleasePointerEligible',
    'Install-ProductionHostTasks',
    'Invoke-McpNativeCommand',
    'Invoke-McpNativeCommandCapture',
    'Invoke-McpBrowserBootstrap',
    'Initialize-ProductionBrowser',
    '$productionConfigPath',
    'Wait-ComponentRelease',
    'Assert-TaskRelease',
    'Export-ScheduledTask',
    'Restore-TaskDefinition',
    'rollbackAvailable = $true',
    "Wait-Http200 -Uri `$gatewayLiveUri",
    "Wait-Http200 -Uri `$gatewayReadyUri",
    "Wait-Http200 -Uri `$browserLiveUri",
    'if ($RequireBrowserReady)',
    'Get-McpPowerShellAncestorProcesses',
    'New-McpBrowserRegistrySnapshot',
    'Restore-McpBrowserRegistrySnapshot',
    '[int]$ExpectedPreviousBrowserRegistrySchemaVersion = 0',
    'browserRegistrySnapshotManifestSha256',
    'browserRegistryRollbackJournalPath',
    'browserRegistryQuarantineDirectory',
    '[string]$LifecycleResultPath',
    "status = 'rolled-back'",
    "status = 'rollback-failed'"
)
foreach ($requirement in $promotionRequirements) {
    if (-not $promotion.Contains($requirement)) {
        throw "Production promotion safety requirement is missing: $requirement"
    }
}

if ($promotion.Contains('runtime\production-promotion\Invoke-InstallMcpHostTasks.ps1')) {
    throw 'Versioned production promotion must not depend on a runtime-only installer wrapper.'
}
if ($promotion.Contains("Wait-Http200 -Uri `$gatewayReadyUri`n`n    # PROMOTION_STEP: stop-previous-hosts")) {
    throw 'Candidate Gateway readiness must not be required before the candidate Agent starts.'
}

$detachedRequirements = @(
    'Run-McpProductionPromotionDetached.ps1',
    'Start-Process',
    '-RedirectStandardOutput',
    '-RedirectStandardError',
    'result.json',
    'ExpectedPreviousBrowserRegistrySchemaVersion',
    "[switch]`$Execute"
)
foreach ($requirement in $detachedRequirements) {
    if (-not $detached.Contains($requirement)) {
        throw "Detached promotion safety requirement is missing: $requirement"
    }
}

$detachedRunnerRequirements = @(
    'Promote-McpProduction.ps1',
    'runtime\production-promotion',
    "`$global:LASTEXITCODE = 0",
    'Write-McpJsonFile',
    "status = 'running'",
    "status = `$status",
    "[switch]`$Execute",
    "'-LifecycleResultPath', `$resultPath",
    'ExpectedPreviousBrowserRegistrySchemaVersion',
    'Test-McpTerminalProductionLifecycleStatus'
)
foreach ($requirement in $detachedRunnerRequirements) {
    if (-not $detachedRunner.Contains($requirement)) {
        throw "Detached promotion runner requirement is missing: $requirement"
    }
}

if (-not $common.Contains('function Test-McpAdministrator')) {
    throw 'Common Docker helpers must expose the administrator detection preflight.'
}
if (-not $common.Contains('function Assert-McpAdministrator')) {
    throw 'Common Docker helpers must expose the administrator assertion preflight.'
}

$preflightFailure = & {
    . $commonPath
    function Test-McpAdministrator { return $false }
    try {
        Assert-McpAdministrator -Operation 'Production promotion'
        return $null
    }
    catch {
        return $_.Exception.Message
    }
}
if ([string]$preflightFailure -notmatch 'requires an elevated PowerShell session') {
    throw 'Administrator preflight did not reject a non-elevated session with the expected sanitized error.'
}

$preflightPassed = & {
    . $commonPath
    function Test-McpAdministrator { return $true }
    try {
        Assert-McpAdministrator -Operation 'Production promotion'
        return $true
    }
    catch {
        return $false
    }
}
if (-not $preflightPassed) {
    throw 'Administrator preflight rejected an elevated session.'
}

if (-not $lifecycleCommon.Contains('function Get-McpPowerShellAncestorProcesses')) {
    throw 'Production lifecycle helpers must attribute PowerShell wrappers through process ancestry.'
}
if (-not $lifecycleCommon.Contains('function New-McpBrowserRegistrySnapshot')) {
    throw 'Production lifecycle helpers must snapshot Browser Worker persisted registry state.'
}
if (-not $lifecycleCommon.Contains('function Restore-McpBrowserRegistrySnapshot')) {
    throw 'Production lifecycle helpers must restore Browser Worker persisted registry state.'
}
foreach ($requirement in @(
    'function Get-McpBrowserRegistryManifest',
    'function Assert-McpBrowserRegistryManifestMatch',
    'browser-registry-rollback-journal.json',
    'browser-registry.after-candidate',
    "phase = 'current-quarantined'",
    "phase = 'completed'"
)) {
    if (-not $lifecycleCommon.Contains($requirement)) {
        throw "Production lifecycle rollback integrity requirement is missing: $requirement"
    }
}
if (-not $lifecycleCommon.Contains('function Test-McpTerminalProductionLifecycleStatus')) {
    throw 'Production lifecycle helpers must classify terminal detached lifecycle results.'
}
if ($promotion.Contains('([string]$_.CommandLine).Contains("releases\$ExpectedReleaseId")')) {
    throw 'PowerShell wrapper detection must not classify processes only by a release path substring.'
}

if (-not $common.Contains('function Invoke-McpNativeCommandCapture')) {
    throw 'Common Docker helpers must expose strict-mode-safe native command capture.'
}
if (-not $common.Contains('function Invoke-McpBrowserBootstrap')) {
    throw 'Common Docker helpers must expose the authenticated Browser Worker bootstrap.'
}
if (-not $common.Contains("operation = 'connect'")) {
    throw 'Browser bootstrap helper must use the connect operation.'
}
if (-not $common.Contains('$global:LASTEXITCODE = 0')) {
    throw 'Native command helpers must initialize LASTEXITCODE before reading it under strict mode.'
}

$global:LASTEXITCODE = 0
$gateOutput = @(
    & pwsh `
        -NoLogo `
        -NoProfile `
        -File $promotionPath `
        -ExpectedReleaseId 'test-release' 2>&1
)
$gateExitCode = [int]$global:LASTEXITCODE
if ($gateExitCode -eq 0) {
    throw 'Production promotion must fail when -Execute is omitted.'
}
if (($gateOutput -join "`n") -notmatch 'intentionally gated') {
    throw 'Production promotion gate did not return the expected error.'
}

$global:LASTEXITCODE = 0
$detachedGateOutput = @(
    & pwsh `
        -NoLogo `
        -NoProfile `
        -File $detachedPath `
        -ExpectedReleaseId 'test-release' 2>&1
)
$detachedGateExitCode = [int]$global:LASTEXITCODE
if ($detachedGateExitCode -eq 0 -or ($detachedGateOutput -join "`n") -notmatch 'intentionally gated') {
    throw 'Detached production promotion must fail when -Execute is omitted.'
}

$global:LASTEXITCODE = 0
$runnerGateOutput = @(
    & pwsh `
        -NoLogo `
        -NoProfile `
        -File $detachedRunnerPath `
        -ProjectRoot (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) `
        -ExpectedReleaseId 'test-release' `
        -RunDirectory (Join-Path ([System.IO.Path]::GetTempPath()) 'mcp-promotion-test-detached') 2>&1
)
$runnerGateExitCode = [int]$global:LASTEXITCODE
if ($runnerGateExitCode -eq 0 -or ($runnerGateOutput -join "`n") -notmatch 'intentionally gated') {
    throw 'Detached production promotion runner must fail when -Execute is omitted.'
}

. $commonPath
$isAdministrator = Test-McpAdministrator

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'mcp-production-promotion-test-' + [guid]::NewGuid().ToString('N')
)
$temporaryRunDirectory = Join-Path $temporaryRoot 'runtime\production-promotion\detached-test'
try {
    $global:LASTEXITCODE = 0
    $runnerFailureOutput = @(
        & pwsh `
            -NoLogo `
            -NoProfile `
            -File $detachedRunnerPath `
            -Execute `
            -ProjectRoot $temporaryRoot `
            -ExpectedReleaseId 'test-release' `
            -RunDirectory $temporaryRunDirectory 2>&1
    )
    $runnerFailureExitCode = [int]$global:LASTEXITCODE
    if ($runnerFailureExitCode -eq 0) {
        throw 'Detached runner fixture must fail.'
    }

    $resultPath = Join-Path $temporaryRunDirectory 'result.json'
    if ($isAdministrator) {
        if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
            throw 'Elevated detached runner did not persist a failure result.'
        }
        $result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
        if (
            [string]$result.status -ne 'failed' -or
            [int]$result.exitCode -eq 0 -or
            [string]$result.error -notmatch 'script is missing'
        ) {
            throw 'Elevated detached runner persisted an invalid failure result.'
        }
    }
    else {
        if (Test-Path -LiteralPath $temporaryRoot) {
            throw 'Non-elevated detached runner created artifacts before the administrator preflight failed.'
        }
        if (($runnerFailureOutput -join "`n") -notmatch 'requires an elevated PowerShell session') {
            throw 'Non-elevated detached runner did not return the expected administrator preflight error.'
        }
    }
}
finally {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}

. $commonPath
Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
$resolvedNode = Get-McpNodeExecutable
if (-not (Test-Path -LiteralPath $resolvedNode -PathType Leaf)) {
    throw 'Get-McpNodeExecutable did not resolve Node after LASTEXITCODE was removed.'
}

Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
$captured = @(
    Invoke-McpNativeCommandCapture `
        -FilePath $resolvedNode `
        -Arguments @('-e', 'process.stdout.write("native-ok")')
)
if (($captured -join '') -ne 'native-ok') {
    throw 'Strict-mode-safe native command capture returned unexpected output.'
}

$bootstrapContract = & {
    . $commonPath
    $script:bootstrapRequest = $null
    $script:bootstrapReady = $true

    function Invoke-WebRequest {
        param(
            [string]$Uri,
            [string]$Method,
            [hashtable]$Headers,
            [string]$ContentType,
            [string]$Body,
            [switch]$UseBasicParsing,
            [int]$TimeoutSec
        )

        $script:bootstrapRequest = [pscustomobject]@{
            uri = $Uri
            method = $Method
            headers = $Headers
            contentType = $ContentType
            body = $Body | ConvertFrom-Json -Depth 8
            timeoutSec = $TimeoutSec
            useBasicParsing = $UseBasicParsing.IsPresent
        }
        $ready = [bool]$script:bootstrapReady
        return [pscustomobject]@{
            StatusCode = 200
            Content = ([ordered]@{
                ok = $true
                result = [ordered]@{
                    state = if ($ready) { 'connected' } else { 'disconnected' }
                    ready = $ready
                }
            } | ConvertTo-Json -Depth 8 -Compress)
        }
    }

    $result = Invoke-McpBrowserBootstrap `
        -Uri 'http://127.0.0.1:3350/operations' `
        -Token 'test-browser-token' `
        -TimeoutSeconds 17
    $readyRequest = $script:bootstrapRequest

    $script:bootstrapReady = $false
    $notReadyError = try {
        Invoke-McpBrowserBootstrap `
            -Uri 'http://127.0.0.1:3350/operations' `
            -Token 'test-browser-token' `
            -TimeoutSeconds 17 | Out-Null
        $null
    }
    catch {
        $_.Exception.Message
    }

    $missingTokenError = try {
        Invoke-McpBrowserBootstrap `
            -Uri 'http://127.0.0.1:3350/operations' `
            -Token '' `
            -TimeoutSeconds 17 | Out-Null
        $null
    }
    catch {
        $_.Exception.Message
    }

    [pscustomobject]@{
        result = $result
        request = $readyRequest
        notReadyError = $notReadyError
        missingTokenError = $missingTokenError
    }
}

if (
    $bootstrapContract.result.ready -ne $true -or
    [string]$bootstrapContract.result.state -ne 'connected'
) {
    throw 'Browser bootstrap helper did not return the connected ready result.'
}
$bootstrapRequest = $bootstrapContract.request
if (
    [string]$bootstrapRequest.uri -ne 'http://127.0.0.1:3350/operations' -or
    [string]$bootstrapRequest.method -ne 'Post' -or
    [string]$bootstrapRequest.headers.Authorization -ne 'Bearer test-browser-token' -or
    [string]$bootstrapRequest.headers.'x-mcp-call-id' -notmatch '^production-bootstrap-[a-f0-9]{32}$' -or
    [string]$bootstrapRequest.contentType -ne 'application/json' -or
    [int]$bootstrapRequest.timeoutSec -ne 17 -or
    $bootstrapRequest.useBasicParsing -ne $true -or
    [string]$bootstrapRequest.body.operation -ne 'connect' -or
    @($bootstrapRequest.body.input.PSObject.Properties).Count -ne 0
) {
    throw 'Browser bootstrap helper emitted an invalid authenticated HTTP contract.'
}
if ([string]$bootstrapContract.notReadyError -notmatch 'did not reach ready state') {
    throw 'Browser bootstrap helper accepted a non-ready response.'
}
if ([string]$bootstrapContract.missingTokenError -notmatch 'token is unavailable') {
    throw 'Browser bootstrap helper accepted a missing token.'
}

. $lifecycleCommonPath

$processFixture = @(
    [pscustomobject]@{ ProcessId = 10; ParentProcessId = 1; Name = 'node.exe'; CommandLine = 'agent' },
    [pscustomobject]@{ ProcessId = 11; ParentProcessId = 2; Name = 'node.exe'; CommandLine = 'browser' },
    [pscustomobject]@{ ProcessId = 1; ParentProcessId = 0; Name = 'McpNodeHostLauncher.exe'; CommandLine = 'native agent' },
    [pscustomobject]@{ ProcessId = 2; ParentProcessId = 3; Name = 'McpNodeHostLauncher.exe'; CommandLine = 'native browser' },
    [pscustomobject]@{ ProcessId = 3; ParentProcessId = 0; Name = 'pwsh.exe'; CommandLine = 'legacy permanent wrapper' },
    [pscustomobject]@{ ProcessId = 99; ParentProcessId = 0; Name = 'pwsh.exe'; CommandLine = 'transient promotion orchestrator releases\candidate' }
)
$attributedWrappers = @(
    Get-McpPowerShellAncestorProcesses -ProcessIds @(10, 11) -Processes $processFixture
)
if ($attributedWrappers.Count -ne 1 -or [int]$attributedWrappers[0].ProcessId -ne 3) {
    throw 'PowerShell wrapper attribution did not isolate the actual Browser Worker ancestor.'
}

foreach ($terminalStatus in @('passed', 'rolled-back', 'rollback-failed', 'failed', 'passed-after-controlled-recovery')) {
    if (-not (Test-McpTerminalProductionLifecycleStatus -Status $terminalStatus)) {
        throw "Detached lifecycle status was not classified as terminal: $terminalStatus"
    }
}
if (Test-McpTerminalProductionLifecycleStatus -Status 'running') {
    throw 'Detached lifecycle running status must not be classified as terminal.'
}

$registryTestRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'mcp-browser-registry-rollback-test-' + [guid]::NewGuid().ToString('N')
)
try {
    $runtimeDirectory = Join-Path $registryTestRoot 'runtime\browser'
    $registryDirectory = Join-Path $runtimeDirectory 'registry'
    $backupDirectory = Join-Path $registryTestRoot 'backup'
    $configurationPath = Join-Path $registryTestRoot 'production.json'
    New-Item -ItemType Directory -Force -Path $registryDirectory | Out-Null
    Write-McpUtf8NoBom -Path (Join-Path $registryDirectory 'browser-session.json') -Content '{"schemaVersion":3}'
    Write-McpUtf8NoBom -Path (Join-Path $registryDirectory 'navigation-cache.json') -Content '{"schemaVersion":1}'
    Write-McpJsonFile -Path $configurationPath -Value ([ordered]@{
        browser = [ordered]@{ runtimeDirectory = $runtimeDirectory }
    })

    $unsafeConfigurationPath = Join-Path $registryTestRoot 'unsafe-production.json'
    Write-McpJsonFile -Path $unsafeConfigurationPath -Value ([ordered]@{
        browser = [ordered]@{ runtimeDirectory = (Join-Path $registryTestRoot 'outside-runtime') }
    })
    $unsafeRegistryError = try {
        New-McpBrowserRegistrySnapshot `
            -ProductionConfigPath $unsafeConfigurationPath `
            -ProjectRoot $registryTestRoot `
            -BackupDirectory (Join-Path $registryTestRoot 'unsafe-backup') | Out-Null
        $null
    }
    catch {
        $_.Exception.Message
    }
    if ([string]$unsafeRegistryError -notmatch 'must be inside the project runtime directory') {
        throw 'Browser registry snapshot accepted a runtime path outside the project runtime directory.'
    }

    $snapshot = New-McpBrowserRegistrySnapshot `
        -ProductionConfigPath $configurationPath `
        -ProjectRoot $registryTestRoot `
        -BackupDirectory $backupDirectory
    Write-McpUtf8NoBom -Path (Join-Path $registryDirectory 'browser-session.json') -Content '{"schemaVersion":4}'
    Write-McpUtf8NoBom -Path (Join-Path $registryDirectory 'candidate-only.json') -Content '{}'
    Remove-Item -LiteralPath (Join-Path $registryDirectory 'navigation-cache.json') -Force

    Restore-McpBrowserRegistrySnapshot -Snapshot $snapshot | Out-Null
    if ((Get-Content -Raw -LiteralPath (Join-Path $registryDirectory 'browser-session.json')) -ne '{"schemaVersion":3}') {
        throw 'Browser session registry was not restored to the pre-promotion schema.'
    }
    if ((Get-Content -Raw -LiteralPath (Join-Path $registryDirectory 'navigation-cache.json')) -ne '{"schemaVersion":1}') {
        throw 'Browser navigation registry state was not restored.'
    }
    if (Test-Path -LiteralPath (Join-Path $registryDirectory 'candidate-only.json')) {
        throw 'Candidate-only Browser Worker registry state survived rollback.'
    }

    Remove-Item -LiteralPath $registryDirectory -Recurse -Force
    $missingSnapshot = New-McpBrowserRegistrySnapshot `
        -ProductionConfigPath $configurationPath `
        -ProjectRoot $registryTestRoot `
        -BackupDirectory (Join-Path $registryTestRoot 'missing-backup')
    New-Item -ItemType Directory -Force -Path $registryDirectory | Out-Null
    Write-McpUtf8NoBom -Path (Join-Path $registryDirectory 'candidate-only.json') -Content '{}'
    Restore-McpBrowserRegistrySnapshot -Snapshot $missingSnapshot | Out-Null
    if (Test-Path -LiteralPath $registryDirectory) {
        throw 'Rollback did not remove a registry created only by the candidate.'
    }
}
finally {
    Remove-Item -LiteralPath $registryTestRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output 'Production promotion tests passed: cutover order, process-ancestry wrapper attribution, Browser Worker registry rollback, terminal detached results, authenticated bootstrap, gating and strict-mode native commands are enforced.'
