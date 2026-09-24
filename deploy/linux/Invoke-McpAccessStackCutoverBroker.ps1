param(
  [Parameter(Mandatory=$true)][string]$RequestPath,
  [Parameter(Mandatory=$true)][string]$ResultPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Optional($o,[string]$n) {
  if ($null -eq $o) { return $null }
  $p=$o.PSObject.Properties[$n]
  if ($null -eq $p) { return $null }
  return $p.Value
}
function Write-JsonAtomic([string]$Path,[object]$Value) {
  $dir=Split-Path -Parent $Path
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $tmp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($tmp,(($Value|ConvertTo-Json -Depth 20)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
  [IO.File]::Move($tmp,$Path,$true)
}
function Health([string]$Base) {
  Invoke-RestMethod -Uri ($Base.TrimEnd('/')+'/health') -Method Get -TimeoutSec 3 -ErrorAction Stop
}
function Wait-Selected([string]$Base,[string]$Revision,[string[]]$Excluded=@(),[int]$Timeout=30) {
  $deadline=[DateTimeOffset]::UtcNow.AddSeconds($Timeout)
  $expectedRevision=$Revision.Trim()
  $last='no health response'
  do {
    try {
      $h=Health $Base
      $r=Optional $h 'runtime'
      $id=([string](Optional $r 'connectorInstanceId')).Trim()
      $catalog=([string](Optional $r 'catalogContractRevision')).Trim()
      $active=([string](Optional $h 'activeContractRevision')).Trim()
      $candidate=([string](Optional $h 'candidateContractRevision')).Trim()
      $ready=(Optional $h 'connectorReady') -eq $true
      $execution=(Optional $h 'executionPlaneReady') -eq $true
      $compatible=(Optional $h 'contractCompatible') -eq $true
      $isExcluded=$Excluded -contains $id
      $idPresent=-not [string]::IsNullOrWhiteSpace($id)
      $catalogMatch=[StringComparer]::Ordinal.Equals($catalog,$expectedRevision)
      $activeMatch=[StringComparer]::Ordinal.Equals($active,$expectedRevision)
      $candidateEmpty=[string]::IsNullOrWhiteSpace($candidate)
      $matches=$ready -and $execution -and $compatible -and -not $isExcluded -and $idPresent -and $catalogMatch -and $activeMatch -and $candidateEmpty
      if ($matches) {
        return [pscustomobject]@{connectorInstanceId=$id;catalogContractRevision=$catalog;activeContractRevision=$active;executionPlaneReady=$execution;connectorReady=$ready;contractCompatible=$compatible}
      }
      $last="execution=$execution ready=$ready compatible=$compatible expected=$expectedRevision active=$active activeMatch=$activeMatch candidate=$candidate candidateEmpty=$candidateEmpty catalog=$catalog catalogMatch=$catalogMatch id=$id idPresent=$idPresent excluded=$isExcluded"
    } catch { $last=$_.Exception.Message }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Selected health gate failed. Last observation: $last"
}
function Wait-Candidate([string]$Base,[string]$Active,[string]$Candidate,[string]$Previous,[int]$Timeout=30) {
  $deadline=[DateTimeOffset]::UtcNow.AddSeconds($Timeout)
  $last='no candidate health response'
  do {
    try {
      $h=Health $Base
      $r=Optional $h 'candidateRuntime'
      $id=[string](Optional $r 'connectorInstanceId')
      $catalog=[string](Optional $r 'catalogContractRevision')
      $candidateReady=[bool](Optional $h 'candidateConnectorReady')
      $active=[string](Optional $h 'activeContractRevision')
      $candidate=[string](Optional $h 'candidateContractRevision')
      if ($candidateReady -and -not [string]::IsNullOrWhiteSpace($id) -and $id -ne $Previous -and $active -eq $Active -and $candidate -eq $Candidate -and $catalog -eq $Candidate) {
        return [pscustomobject]@{connectorInstanceId=$id;catalogContractRevision=$catalog;activeContractRevision=$active;candidateContractRevision=$candidate}
      }
      $last="ready=$candidateReady active=$active candidate=$candidate catalog=$catalog id=$id"
    } catch { $last=$_.Exception.Message }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Candidate health gate failed. Last observation: $last"
}
function Promote-Contract([string]$Base,[string]$TokenFile,[string]$Active,[string]$Candidate,[int]$Timeout=30) {
  $token=(Get-Content -LiteralPath $TokenFile -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($token)) { throw 'Contract promotion token is empty.' }
  $body=@{expectedActiveContractRevision=$Active;expectedCandidateContractRevision=$Candidate}|ConvertTo-Json -Compress
  $url=$Base.TrimEnd('/')+'/_internal/contract-rollout/promote'
  $requestError=$null
  try { Invoke-RestMethod -Uri $url -Method Post -Headers @{Authorization="Bearer $token"} -ContentType 'application/json' -Body $body -TimeoutSec 5 -ErrorAction Stop | Out-Null } catch { $requestError=$_.Exception.Message }
  $deadline=[DateTimeOffset]::UtcNow.AddSeconds($Timeout)
  do {
    try {
      $h=Health $Base
      $a=[string](Optional $h 'activeContractRevision')
      $c=[string](Optional $h 'candidateContractRevision')
      if ($a -eq $Candidate -and [string]::IsNullOrWhiteSpace($c)) { return [pscustomobject]@{status=if($null-eq$requestError){'promoted'}else{'reconciled'};activeContractRevision=$a;requestError=$requestError} }
    } catch {}
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Contract promotion did not reconcile. Initial request error: $requestError"
}
function Rollback-Contract([string]$Base,[string]$TokenFile,[string]$Active,[string]$Previous,[int]$Timeout=45) {
  $token=(Get-Content -LiteralPath $TokenFile -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($token)) { throw 'Contract rollback token is empty.' }
  $body=@{expectedActiveContractRevision=$Active;expectedPreviousContractRevision=$Previous}|ConvertTo-Json -Compress
  $url=$Base.TrimEnd('/')+'/_internal/contract-rollout/rollback'
  $deadline=[DateTimeOffset]::UtcNow.AddSeconds($Timeout)
  $last='rollback not attempted'
  do {
    $requestError=$null
    try { Invoke-RestMethod -Uri $url -Method Post -Headers @{Authorization="Bearer $token"} -ContentType 'application/json' -Body $body -TimeoutSec 5 -ErrorAction Stop | Out-Null } catch { $requestError=$_.Exception.Message }
    try {
      $h=Health $Base
      $a=[string](Optional $h 'activeContractRevision')
      if ($a -eq $Previous) { return [pscustomobject]@{status=if($null-eq$requestError){'rolled-back'}else{'reconciled'};activeContractRevision=$a;requestError=$requestError} }
      $last="requestError=$requestError active=$a"
    } catch { $last="requestError=$requestError healthError=$($_.Exception.Message)" }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Contract rollback did not reconcile. Last observation: $last"
}
function Start-Connector([string]$ReleaseRoot,[string]$RuntimeRoot,[string]$LogPrefix) {
  $launcher=Join-Path $ReleaseRoot 'deploy/linux/Start-McpEdgeConnector.sh'
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Launcher missing: $launcher" }
  New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
  $envMap=@{
    HOME=$installationRoot
    PATH='/usr/local/bin:/usr/bin:/bin'
    MCP_RELEASE_ROOT=$ReleaseRoot
    VS_CODE_GPT_STACK_ROOT=$projectRoot
    MCP_ACCESS_STACK_RUNTIME_ROOT=$RuntimeRoot
    MCP_ACCESS_STACK_INSTALLATION_ROOT=$installationRoot
    MCP_EDGE_BASE_URL=$edgeBaseUrl
    MCP_CONNECTOR_TOKEN_FILE=$connectorTokenFile
    MCP_OWNER_TOKEN_FILE=$ownerTokenFile
    VS_CODE_GPT_POLICY_PATH=$policyPath
    MCP_NODE_BINARY='/usr/local/bin/node'
    MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS=[string]$maxConcurrentRequests
    MCP_SESSION_MODE=$mcpSessionMode
    OWNER_OAUTH_SCOPES=$ownerOAuthScopes
    ALLOWED_ORIGINS=$allowedOrigins
  }
  Start-Process -FilePath '/usr/bin/bash' -ArgumentList @($launcher,'--from-environment') -WorkingDirectory $projectRoot -Environment $envMap -RedirectStandardOutput ($LogPrefix+'.stdout.log') -RedirectStandardError ($LogPrefix+'.stderr.log') -PassThru
}
function Stop-Connector($Process) {
  if ($null -eq $Process) { return }
  try {
    if (-not $Process.HasExited) {
      & /usr/bin/kill -TERM $Process.Id
      try { $Process.WaitForExit(5000)|Out-Null } catch {}
      if (-not $Process.HasExited) { & /usr/bin/kill -KILL $Process.Id }
    }
  } catch {}
}
function Set-Current([string]$ReleaseRoot) {
  $current=Join-Path $installationRoot 'current'
  $tmp=Join-Path $installationRoot ('.current.'+[guid]::NewGuid().ToString('N'))
  & /usr/bin/ln -s $ReleaseRoot $tmp
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create current release symlink.' }
  & /usr/bin/mv -Tf $tmp $current
  if ($LASTEXITCODE -ne 0) { throw 'Unable to replace current release symlink.' }
}
function Test-PersistentServiceActive([string]$ServiceName) {
  $probe=Start-Process -FilePath '/usr/bin/systemctl' -ArgumentList @('--user','is-active','--quiet',$ServiceName) -WorkingDirectory $installationRoot -NoNewWindow -Wait -PassThru
  return $probe.ExitCode -eq 0
}
function Restart-PersistentService([string]$ServiceName) {
  & /usr/bin/systemctl --user restart $ServiceName
  if ($LASTEXITCODE -ne 0) { throw "Unable to restart user service: $ServiceName" }
}
function Stop-PersistentService([string]$ServiceName) {
  & /usr/bin/systemctl --user stop $ServiceName
  if ($LASTEXITCODE -ne 0) { throw "Unable to stop user service: $ServiceName" }
}

$RequestPath=[IO.Path]::GetFullPath($RequestPath)
$ResultPath=[IO.Path]::GetFullPath($ResultPath)
$request=Get-Content -LiteralPath $RequestPath -Raw|ConvertFrom-Json
if ([int]$request.schemaVersion -ne 1) { throw 'Unsupported Linux cutover request schema.' }

$requestId=[string]$request.requestId
$releaseId=[string]$request.releaseId
$installationRoot=[IO.Path]::GetFullPath([string]$request.installationRoot)
$projectRoot=[IO.Path]::GetFullPath([string]$request.projectRoot)
$edgeRuntimeRoot=[IO.Path]::GetFullPath([string]$request.edgeRuntimeRoot)
$edgeBaseUrl=[string]$request.edgeBaseUrl
$connectorTokenFile=[IO.Path]::GetFullPath([string]$request.connectorTokenFile)
$ownerTokenFile=[IO.Path]::GetFullPath([string]$request.ownerTokenFile)
$policyPath=[IO.Path]::GetFullPath([string]$request.policyPath)
$allowedOrigins=[string]$request.allowedOrigins
$ownerOAuthScopes=[string]$request.ownerOAuthScopes
$mcpSessionMode=[string]$request.mcpSessionMode
$maxConcurrentRequests=[int]$request.maxConcurrentRequests
$edgeTaskName=[string]$request.edgeTaskName
$handoverDelaySeconds=[int]$request.handoverDelaySeconds
$startedAt=[DateTimeOffset]::UtcNow.ToString('O')

$statePath=Join-Path $installationRoot 'state/lifecycle-state.v1.json'
$recoveryConfigPath=Join-Path $installationRoot 'state/edge-task-config.v1.json'
$runRoot=Split-Path -Parent $ResultPath
$stateBeforeJson=Get-Content -LiteralPath $statePath -Raw
$stateBefore=$stateBeforeJson|ConvertFrom-Json
if ([string]$stateBefore.candidate.releaseId -ne $releaseId) { throw 'Linux cutover candidate changed after request creation.' }
$previousReleaseId=[string]$stateBefore.active.releaseId
$previousReleaseRoot=Join-Path $installationRoot ("releases/$previousReleaseId")
$candidateReleaseRoot=Join-Path $installationRoot ("releases/$releaseId")
$persistentServiceWasActive=Test-PersistentServiceActive $edgeTaskName

$handover=$null
$rollback=$null
$retainHandover=$false
$retainRollback=$false
$localCommitted=$false
$contractPromoted=$false
$promotionRequired=$false
$activeRevision=$null
$candidateRevision=$null
$previousId=$null
$handoverId=$null
$promotion=[pscustomobject]@{status='not-required';activeContractRevision=$null;requestError=$null}
$failureStage=$null
$failureCode=$null

try {
  Start-Sleep -Seconds $handoverDelaySeconds
  $before=Health $edgeBaseUrl
  $previousId=[string](Optional (Optional $before 'runtime') 'connectorInstanceId')
  $activeRevision=[string](Optional $before 'activeContractRevision')
  $candidateRevision=[string](Optional $before 'candidateContractRevision')
  if ([string]::IsNullOrWhiteSpace($previousId)-or[string]::IsNullOrWhiteSpace($activeRevision)) { throw 'Current Edge health is missing active identity.' }
  $promotionRequired=-not[string]::IsNullOrWhiteSpace($candidateRevision)

  $failureStage='handover-health';$failureCode='HANDOVER_HEALTH_FAILED'
  $handover=Start-Connector $candidateReleaseRoot (Join-Path $runRoot 'handover-runtime') (Join-Path $runRoot 'handover')
  if ($promotionRequired) {
    $handoverHealth=Wait-Candidate $edgeBaseUrl $activeRevision $candidateRevision $previousId
  } else {
    $handoverHealth=Wait-Selected $edgeBaseUrl $activeRevision @($previousId)
  }
  $handoverId=[string]$handoverHealth.connectorInstanceId

  if ($promotionRequired) {
    $failureStage='contract-promotion';$failureCode='CONTRACT_PROMOTION_FAILED'
    $promotion=Promote-Contract $edgeBaseUrl $connectorTokenFile $activeRevision $candidateRevision
    $contractPromoted=$true
    $promoted=Wait-Selected $edgeBaseUrl $candidateRevision @($previousId)
    if ([string]$promoted.connectorInstanceId -ne $handoverId) { throw 'Contract promotion did not select handover connector.' }
  }

  $failureStage='local-cutover';$failureCode='LOCAL_CUTOVER_FAILED'
  Set-Current $candidateReleaseRoot
  $newState=$stateBeforeJson|ConvertFrom-Json
  $newState.previous=$newState.active
  $newState.active=$newState.candidate
  $newState.candidate=$null
  $newState.updatedAt=[DateTimeOffset]::UtcNow.ToString('O')
  Write-JsonAtomic $statePath $newState
  $localCommitted=$true

  Restart-PersistentService $edgeTaskName

  $expectedRevision=if($promotionRequired){$candidateRevision}else{$activeRevision}
  $failureStage='post-cutover-health';$failureCode='CUTOVER_POST_HEALTH_FAILED'
  $healthGate=Wait-Selected $edgeBaseUrl $expectedRevision @($previousId,$handoverId) 45
  Stop-Connector $handover
  $handover=$null
  $final=Wait-Selected $edgeBaseUrl $expectedRevision @($previousId,$handoverId)

  $config=[ordered]@{schemaVersion=1;taskName=$edgeTaskName;projectRoot=$projectRoot;runtimeRoot=$edgeRuntimeRoot;edgeBaseUrl=$edgeBaseUrl;connectorTokenFile=$connectorTokenFile;ownerTokenFile=$ownerTokenFile;policyPath=$policyPath;allowedOrigins=$allowedOrigins;ownerOAuthScopes=$ownerOAuthScopes;mcpSessionMode=$mcpSessionMode;maxConcurrentRequests=$maxConcurrentRequests;delaySeconds=2;browserEnabled=$false;browserWorkerUrl=$null;browserWorkerTokenFile=$null;updatedAt=[DateTimeOffset]::UtcNow.ToString('O')}
  Write-JsonAtomic $recoveryConfigPath $config

  $result=[ordered]@{schemaVersion=1;requestId=$requestId;releaseId=$releaseId;status='passed';startedAt=$startedAt;completedAt=[DateTimeOffset]::UtcNow.ToString('O');ownershipMode='edge-only';edgeTask=$edgeTaskName;browserTask=$null;healthGate=[ordered]@{status='passed';connectorInstanceId=[string]$final.connectorInstanceId;catalogContractRevision=[string]$final.catalogContractRevision;executionPlaneReady=[bool]$final.executionPlaneReady;connectorReady=[bool]$final.connectorReady;contractCompatible=[bool]$final.contractCompatible};contractPromotion=[ordered]@{required=[bool]$promotionRequired;status=[string]$promotion.status;activeContractRevision=[string]$final.activeContractRevision;requestError=Optional $promotion 'requestError'};recoveryConfig=$recoveryConfigPath}
  Write-JsonAtomic $ResultPath $result
  exit 0
}
catch {
  $failure=$_
  $recoveryErrors=[Collections.Generic.List[string]]::new()
  $rollbackId=$null
  $contractRollbackStatus='not-attempted'

  if ($localCommitted) {
    try {
      Set-Current $previousReleaseRoot
      [IO.File]::WriteAllText(($statePath+'.rollback.tmp'),$stateBeforeJson,[Text.UTF8Encoding]::new($false))
      [IO.File]::Move(($statePath+'.rollback.tmp'),$statePath,$true)
    } catch { $recoveryErrors.Add("local rollback: $($_.Exception.Message)") }
  }

  if ($contractPromoted) {
    try {
      $rollback=Start-Connector $previousReleaseRoot (Join-Path $runRoot 'rollback-runtime') (Join-Path $runRoot 'rollback')
      $rb=Rollback-Contract $edgeBaseUrl $connectorTokenFile $candidateRevision $activeRevision 45
      $contractRollbackStatus=[string]$rb.status
      $rbHealth=Wait-Selected $edgeBaseUrl $activeRevision @($previousId,$handoverId)
      $rollbackId=[string]$rbHealth.connectorInstanceId
    } catch {
      $contractRollbackStatus='failed'
      $retainHandover=$true
      $recoveryErrors.Add("contract rollback: $($_.Exception.Message)")
    }
  }

  if ($localCommitted) {
    try {
      if ($persistentServiceWasActive) {
        Restart-PersistentService $edgeTaskName
        $excluded=@($previousId,$handoverId)
        if (-not[string]::IsNullOrWhiteSpace($rollbackId)) { $excluded+=$rollbackId }
        $null=Wait-Selected $edgeBaseUrl $activeRevision $excluded 45
        if ($null-ne$rollback) { Stop-Connector $rollback;$rollback=$null }
        if (-not$retainHandover) { Stop-Connector $handover;$handover=$null }
      } else {
        Stop-PersistentService $edgeTaskName
        if (-not$retainRollback -and $null-ne$rollback) { Stop-Connector $rollback;$rollback=$null }
        if (-not$retainHandover -and $null-ne$handover) { Stop-Connector $handover;$handover=$null }
        if ($retainRollback -or $retainHandover) { throw 'Offline rollback cannot restore the external owner while a transient recovery connector must be retained.' }
        $restored=Wait-Selected $edgeBaseUrl $activeRevision @() 45
        if ([string]$restored.connectorInstanceId -ne $previousId) { throw "Offline rollback selected unexpected connector: $([string]$restored.connectorInstanceId)" }
      }
    } catch {
      if ($null-ne$rollback) { $retainRollback=$true } else { $retainHandover=$true }
      $recoveryErrors.Add("persistent recovery: $($_.Exception.Message)")
    }
  }

  if (-not$retainHandover) { Stop-Connector $handover }
  if (-not$retainRollback) { Stop-Connector $rollback }

  $message=$failure.Exception.Message
  if ($recoveryErrors.Count-gt0) { $message+='. Recovery errors: '+($recoveryErrors-join'; ') }
  $result=[ordered]@{schemaVersion=1;requestId=$requestId;releaseId=$releaseId;status='failed';startedAt=$startedAt;completedAt=[DateTimeOffset]::UtcNow.ToString('O');failureStage=$failureStage;failureCode=$failureCode;rollback=[ordered]@{attempted=[bool]$localCommitted;restoredReleaseId=if($localCommitted){$previousReleaseId}else{$null}};contractRollback=[ordered]@{attempted=[bool]$contractPromoted;status=$contractRollbackStatus;handoverRetained=[bool]$retainHandover;rollbackConnectorRetained=[bool]$retainRollback};error=$message}
  Write-JsonAtomic $ResultPath $result
  [Console]::Error.WriteLine($message)
  exit 1
}
