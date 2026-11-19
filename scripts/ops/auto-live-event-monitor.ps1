param(
  [string]$ProductionRoot = 'F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master',
  [string]$ExpectedSourceCommit = '',
  [int]$IssueNumber = 28,
  [switch]$Notify
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'auto-live-offline-lease.ps1')

$RepositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($ExpectedSourceCommit)) {
  $resolvedMain = & git -C $RepositoryRoot rev-parse refs/remotes/origin/main 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$resolvedMain)) {
    throw 'Unable to resolve canonical origin/main for AUTO LIVE monitor expected source.'
  }
  $ExpectedSourceCommit = ([string]$resolvedMain).Trim()
}
$ExpectedSourceCommit = $ExpectedSourceCommit.Trim().ToLowerInvariant()
if ($ExpectedSourceCommit -notmatch '^[0-9a-f]{40}$') {
  throw "Invalid AUTO LIVE monitor expected source commit: $ExpectedSourceCommit"
}

function Get-ObjectProperty {
  param([object]$Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $p = $Object.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

function Get-Sha256 {
  param([string[]]$Lines)
  $text = [string]::Join([Environment]::NewLine, @($Lines | Sort-Object))
  if ([string]::IsNullOrEmpty($text)) { return '' }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-InterestingPairs {
  param(
    [object]$Value,
    [string]$Path,
    [string]$Pattern,
    [System.Collections.Generic.List[string]]$Output
  )

  if ($null -eq $Value) { return }

  if ($Value -is [string] -or $Value -is [ValueType]) {
    if ($Path -match $Pattern) {
      $Output.Add("$Path=$Value")
    }
    return
  }

  if ($Value -is [System.Collections.IDictionary]) {
    foreach ($key in $Value.Keys) {
      $next = if ([string]::IsNullOrEmpty($Path)) { [string]$key } else { "$Path.$key" }
      Get-InterestingPairs -Value $Value[$key] -Path $next -Pattern $Pattern -Output $Output
    }
    return
  }

  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    $i = 0
    foreach ($item in $Value) {
      Get-InterestingPairs -Value $item -Path "$Path[$i]" -Pattern $Pattern -Output $Output
      $i++
    }
    return
  }

  foreach ($property in $Value.PSObject.Properties) {
    $next = if ([string]::IsNullOrEmpty($Path)) { $property.Name } else { "$Path.$($property.Name)" }
    Get-InterestingPairs -Value $property.Value -Path $next -Pattern $Pattern -Output $Output
  }
}

function Read-BridgeArray {
  param([string]$Uri, [hashtable]$Headers)
  $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Headers $Headers -Method Get -TimeoutSec 10
  if ([string]::IsNullOrWhiteSpace($response.Content)) { return }
  $parsed = $response.Content | ConvertFrom-Json
  if ($null -eq $parsed) { return }
  foreach ($item in @($parsed)) {
    if ($null -ne $item) { Write-Output $item }
  }
}

function Invoke-GitHubJson {
  param([string]$Method, [string]$Uri, [object]$Body = $null)
  if ([string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) {
    throw 'GITHUB_TOKEN is required for issue persistence'
  }
  $headers = @{
    Authorization = "Bearer $($env:GITHUB_TOKEN)"
    Accept = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent' = 'xauusd-auto-live-readonly-monitor'
  }
  $params = @{
    Uri = $Uri
    Method = $Method
    Headers = $headers
    TimeoutSec = 20
  }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
  }
  return Invoke-RestMethod @params
}


function Write-BridgeFailureState {
  param([string]$FailureCategory, [switch]$ExpectedOffline)
  $targetBridgeStatus = if ($ExpectedOffline) { 'OFFLINE_EXPECTED' } else { 'FAILED' }
  $bridgeEvent = if ($ExpectedOffline) { 'BRIDGE_OFFLINE_EXPECTED' } else { 'BRIDGE_READ_FAILED' }
  $bridgeTitle = if ($ExpectedOffline) { 'operator-declared planned downtime' } else { 'bridge read failure' }
  $statusNote = if ($ExpectedOffline) {
    'A short-lived local maintenance lease authorizes the OFFLINE_EXPECTED classification only. Bot/ARM/position state is NOT VERIFIED; no current health claim is made.'
  } else {
    'The bridge could not be read, and no valid offline lease was established. Treat this as an incident until investigated.'
  }

  $repo = $env:GITHUB_REPOSITORY
  if ([string]::IsNullOrWhiteSpace($repo)) { throw 'GITHUB_REPOSITORY is missing' }
  $issueUri = "https://api.github.com/repos/$repo/issues/$IssueNumber"
  $failureIssue = Invoke-GitHubJson -Method Get -Uri $issueUri
  $pattern = '(?m)^<!-- XAUUSD_AUTO_LIVE_MONITOR_STATE_JSON:(.*) -->$'
  $match = [regex]::Match([string]$failureIssue.body, $pattern)
  if (-not $match.Success) { throw 'AUTO_LIVE_MONITOR_STATE_MARKER_MISSING' }
  $previous = $match.Groups[1].Value | ConvertFrom-Json

  if ([string](Get-ObjectProperty $previous 'bridgeReadStatus') -eq $targetBridgeStatus) {
    Write-Host 'MONITOR_BRIDGE_INCIDENT=ALREADY_RECORDED'
    return
  }

  $failedAt = [DateTime]::UtcNow.ToString('o')
  $lastObservedAt = [string](Get-ObjectProperty $previous 'observedAt')
  $comment = @"
## AUTO LIVE monitor $bridgeTitle

- **Event:** $bridgeEvent
- **Observed at (UTC):** $failedAt
- **Failure category:** $FailureCategory
- **Last complete observation:** $lastObservedAt

The monitor could not complete a fresh production observation. The issue's existing bot mode, ARM, positions, pending orders, and strategy fields were **not refreshed** and must be treated as historical, not as current live status. $statusNote

~~~text
BRIDGE_READ_STATUS=$targetBridgeStatus
BRIDGE_FAILURE_CATEGORY=$FailureCategory
PRODUCTION_READ_ONLY=TRUE
PRODUCTION_HTTP_METHODS=GET_ONLY
MODE_MUTATION=NONE
ARM_MUTATION=NONE
ACCOUNT_SWITCH=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
~~~
"@
  Invoke-GitHubJson -Method Post -Uri "$issueUri/comments" -Body @{ body = $comment } | Out-Null

  if ($ExpectedOffline) {
    $previous | Add-Member -NotePropertyName bridgeReadStatus -NotePropertyValue 'OFFLINE_EXPECTED' -Force
  } else {
    $previous | Add-Member -NotePropertyName bridgeReadStatus -NotePropertyValue 'FAILED' -Force
  }
  $previous | Add-Member -NotePropertyName bridgeFailureObservedAt -NotePropertyValue $failedAt -Force
  $stateJson = $previous | ConvertTo-Json -Depth 12 -Compress
  $newMarker = "<!-- XAUUSD_AUTO_LIVE_MONITOR_STATE_JSON:$stateJson -->"
  $newBody = [regex]::Replace([string]$failureIssue.body, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $newMarker })
  Invoke-GitHubJson -Method Patch -Uri $issueUri -Body @{ body = $newBody } | Out-Null
  Write-Host 'MONITOR_BRIDGE_INCIDENT=RECORDED'
}

$accountPath = Join-Path $ProductionRoot '.runtime\phase7c-account-mode.json'
$lib = Join-Path $ProductionRoot 'scripts\lib\phase7c-account-mode.ps1'
. $lib

$accountState = Get-Content -LiteralPath $accountPath -Raw | ConvertFrom-Json
$envFile = [string]$accountState.envFile
if (-not [System.IO.Path]::IsPathRooted($envFile)) { $envFile = Join-Path $ProductionRoot $envFile }
# Monitoring is GET-only: a deliberate trading-disable must not prevent planned-offline classification.
# Keep the strict LIVE config/localhost/key validation, but do not require execution permission.
$envInfo = Assert-Phase7CAccountEnv -EnvFile $envFile -AccountMode LIVE
$bridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$bridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

$bridgeFailureCategory = ''
$bridgeFailureErrorType = ''
try {
  $positions = @(Read-BridgeArray -Uri "$bridgeBase/v1/positions?symbol=XAUUSD" -Headers $bridgeHeaders)
  $orders = @(Read-BridgeArray -Uri "$bridgeBase/v1/orders?symbol=XAUUSD" -Headers $bridgeHeaders)
  $bridgeHealth = Invoke-RestMethod -Uri "$bridgeBase/health" -Headers $bridgeHeaders -Method Get -TimeoutSec 10
} catch {
  $bridgeFailureErrorType = $_.Exception.GetType().Name
  $bridgeFailureCategory = Get-AutoLiveBridgeFailureCategory -Exception $_.Exception
}

if (-not [string]::IsNullOrWhiteSpace($bridgeFailureCategory)) {
  # Only explicit, unexpired operator intent + connectivity loss can be expected offline.
  # READ_FAILURE (including authentication/HTTP failures) always remains an incident.
  $offlineLeaseState = Get-AutoLiveOfflineLeaseState -ProductionRoot $ProductionRoot
  if (Test-AutoLiveExpectedOffline -FailureCategory $bridgeFailureCategory -LeaseState $offlineLeaseState) {
    Write-Host 'MONITOR_BRIDGE_READ_STATUS=OFFLINE_EXPECTED'
    Write-Host 'MONITOR_RUNTIME_HEALTH=NOT_VERIFIED'
    Write-Host 'MONITOR_DATA_FRESHNESS=UNAVAILABLE'
    Write-Host 'MONITOR_BOT_MODE=UNKNOWN'
    Write-Host 'MONITOR_ARM_STATUS=UNKNOWN'
    Write-Host 'MONITOR_POSITION_COUNT=UNKNOWN'
    Write-Host 'MONITOR_PRODUCTION_HTTP_METHODS=GET_ONLY'
    if ($Notify) {
      Write-BridgeFailureState -FailureCategory $bridgeFailureCategory -ExpectedOffline
      Write-Host 'MONITOR_REPOSITORY_MUTATION=ISSUE_METADATA_ONLY'
    } else {
      Write-Host 'MONITOR_NOTIFY=FALSE'
      Write-Host 'MONITOR_REPOSITORY_MUTATION=NONE'
    }
    Write-Host 'MONITOR_PRODUCTION_MUTATION=NONE'
    exit 0
  }
  Write-Host "MONITOR_OFFLINE_LEASE_STATUS=$offlineLeaseState"
  Write-Host 'MONITOR_BRIDGE_READ_STATUS=FAILED'
  Write-Host "MONITOR_BRIDGE_FAILURE_CATEGORY=$bridgeFailureCategory"
  Write-Host "MONITOR_BRIDGE_ERROR_TYPE=$bridgeFailureErrorType"
  Write-Host 'MONITOR_PRODUCTION_HTTP_METHODS=GET_ONLY'
  if (-not $Notify) {
    Write-Host 'MONITOR_NOTIFY=FALSE'
    Write-Host 'MONITOR_REPOSITORY_MUTATION=NONE'
    throw "AUTO_LIVE_BRIDGE_READ_FAILED: $bridgeFailureCategory"
  }
  Write-BridgeFailureState -FailureCategory $bridgeFailureCategory
  throw "AUTO_LIVE_BRIDGE_READ_FAILED: $bridgeFailureCategory"
}

$life = Invoke-RestMethod -Uri 'http://127.0.0.1:3711/api/v1/phase7c/lifecycle' -Method Get -TimeoutSec 10
$cap = Invoke-RestMethod -Uri 'http://127.0.0.1:3711/api/v1/phase7c-live-arm-control/capability' -Method Get -TimeoutSec 10
$mt5 = Invoke-RestMethod -Uri 'http://127.0.0.1:3711/api/v1/mt5/status?symbol=XAUUSD' -Method Get -TimeoutSec 10
$att = Invoke-RestMethod -Uri 'http://127.0.0.1:3711/api/v1/phase7c/runtime-source-attestation/' -Method Get -TimeoutSec 10
$regime = Invoke-RestMethod -Uri 'http://127.0.0.1:3711/api/v1/phase7c/live-regime?symbol=XAUUSD&count=320' -Method Get -TimeoutSec 12
$decision = Invoke-RestMethod -Uri 'http://127.0.0.1:3711/api/v1/phase7c/decision-monitor?symbol=XAUUSD' -Method Get -TimeoutSec 12

$productionHead = (& git -C $ProductionRoot rev-parse HEAD).Trim()
$sourceCommit = [string](Get-ObjectProperty (Get-ObjectProperty $att 'deployment') 'sourceCommit')
$runtimeOverall = [string](Get-ObjectProperty $att 'overall')
$componentMismatches = @(
  @(Get-ObjectProperty $att 'components') |
    Where-Object { [string](Get-ObjectProperty $_ 'verdict') -ne 'EXACT_MATCH' } |
    ForEach-Object { "$([string](Get-ObjectProperty $_ 'component'))=$([string](Get-ObjectProperty $_ 'verdict'))" }
)

$positionLines = @(
  $positions | ForEach-Object {
    "ticket=$([string](Get-ObjectProperty $_ 'ticket'))|type=$([string](Get-ObjectProperty $_ 'type'))|volume=$([string](Get-ObjectProperty $_ 'volume'))|magic=$([string](Get-ObjectProperty $_ 'magic'))|comment=$([string](Get-ObjectProperty $_ 'comment'))"
  }
)
$orderLines = @(
  $orders | ForEach-Object {
    "ticket=$([string](Get-ObjectProperty $_ 'ticket'))|type=$([string](Get-ObjectProperty $_ 'type'))|volume=$([string](Get-ObjectProperty $_ 'volume'))|price=$([string](Get-ObjectProperty $_ 'price'))|magic=$([string](Get-ObjectProperty $_ 'magic'))|comment=$([string](Get-ObjectProperty $_ 'comment'))"
  }
)

$managementPairs = New-Object 'System.Collections.Generic.List[string]'
$ownershipPairs = New-Object 'System.Collections.Generic.List[string]'
Get-InterestingPairs -Value $decision -Path 'decision' -Pattern '(?i)(fast.?move|m5|handoff|peak|giveback|partial|break.?even|management|managed)' -Output $managementPairs
Get-InterestingPairs -Value $decision -Path 'decision' -Pattern '(?i)(ownership|owner|orphan|unmanaged|magic|comment|ticket)' -Output $ownershipPairs

$ownershipAlertLines = @()
foreach ($r in @(Get-ObjectProperty $decision 'recentDecisions')) {
  $reasonCode = [string](Get-ObjectProperty $r 'reasonCode')
  $reason = [string](Get-ObjectProperty $r 'reason')
  if (("$reasonCode $reason") -match '(?i)(ownership|orphan|unmanaged)') {
    $ownershipAlertLines += "reasonCode=$reasonCode|reason=$reason"
  }
}

$effectiveStrategy = [string](Get-ObjectProperty (Get-ObjectProperty $decision 'mode') 'effectiveStrategy')
$botMode = [string](Get-ObjectProperty (Get-ObjectProperty $life 'mode') 'mode')
$accountMode = [string](Get-ObjectProperty (Get-ObjectProperty $life 'accountMode') 'accountMode')
$armStatus = [string](Get-ObjectProperty $cap 'liveArmStatus')
$liveExecutionArmed = [bool](Get-ObjectProperty $cap 'liveExecutionArmed')
$lifecycleRunning = [bool](Get-ObjectProperty $life 'running')
$lifecycleReady = [bool](Get-ObjectProperty $life 'ready')
$telegramReady = [bool](Get-ObjectProperty $life 'telegramReady')
$telegramStatus = [string](Get-ObjectProperty $life 'telegramStatus')
$mt5Status = [string](Get-ObjectProperty $mt5 'status')
$currentRegime = [string](Get-ObjectProperty $regime 'regime')
$recommendedMode = [string](Get-ObjectProperty $regime 'recommendedMode')

$state = [ordered]@{
  version = 1
  observedAt = [DateTime]::UtcNow.ToString('o')
  bridgeReadStatus = 'OK'
  bridgeFailureObservedAt = ''
  expectedSourceCommit = $ExpectedSourceCommit
  sourceCommit = $sourceCommit
  productionHead = $productionHead
  botMode = $botMode
  accountMode = $accountMode
  lifecycleRunning = $lifecycleRunning
  lifecycleReady = $lifecycleReady
  telegramReady = $telegramReady
  telegramStatus = $telegramStatus
  mt5Status = $mt5Status
  armStatus = $armStatus
  liveExecutionArmed = $liveExecutionArmed
  runtimeSourceOverall = $runtimeOverall
  sourceComponentMismatches = [string]::Join(',', $componentMismatches)
  regime = $currentRegime
  recommendedMode = $recommendedMode
  effectiveStrategy = $effectiveStrategy
  positionCount = $positions.Count
  pendingOrderCount = $orders.Count
  positionSignature = (Get-Sha256 -Lines $positionLines)
  pendingOrderSignature = (Get-Sha256 -Lines $orderLines)
  ownershipFingerprint = if ($positions.Count -gt 0) { Get-Sha256 -Lines @($ownershipPairs) } else { '' }
  ownershipAlertSignature = Get-Sha256 -Lines $ownershipAlertLines
  managementFingerprint = if ($positions.Count -gt 0) { Get-Sha256 -Lines @($managementPairs) } else { '' }
}

Write-Host "MONITOR_EXPECTED_SOURCE_COMMIT=$ExpectedSourceCommit"
Write-Host "MONITOR_SOURCE_COMMIT=$sourceCommit"
Write-Host "MONITOR_PRODUCTION_HEAD=$productionHead"
Write-Host "MONITOR_ACCOUNT_MODE=$accountMode"
Write-Host "MONITOR_BOT_MODE=$botMode"
Write-Host "MONITOR_LIFECYCLE_RUNNING=$lifecycleRunning"
Write-Host "MONITOR_LIFECYCLE_READY=$lifecycleReady"
Write-Host "MONITOR_TELEGRAM_READY=$telegramReady"
Write-Host "MONITOR_TELEGRAM_STATUS=$telegramStatus"
Write-Host "MONITOR_MT5_STATUS=$mt5Status"
Write-Host "MONITOR_ARM_STATUS=$armStatus"
Write-Host "MONITOR_LIVE_EXECUTION_ARMED=$liveExecutionArmed"
Write-Host "MONITOR_RUNTIME_SOURCE_OVERALL=$runtimeOverall"
Write-Host "MONITOR_SOURCE_COMPONENT_MISMATCHES=$([string]::Join(',', $componentMismatches))"
Write-Host "MONITOR_REGIME=$currentRegime"
Write-Host "MONITOR_RECOMMENDED_MODE=$recommendedMode"
Write-Host "MONITOR_EFFECTIVE_STRATEGY=$effectiveStrategy"
Write-Host "MONITOR_POSITION_COUNT=$($positions.Count)"
Write-Host "MONITOR_PENDING_ORDER_COUNT=$($orders.Count)"
Write-Host "MONITOR_MANAGEMENT_EVIDENCE_COUNT=$($managementPairs.Count)"
Write-Host "MONITOR_OWNERSHIP_EVIDENCE_COUNT=$($ownershipPairs.Count)"
Write-Host "MONITOR_OWNERSHIP_ALERT_COUNT=$($ownershipAlertLines.Count)"
Write-Host "MONITOR_BRIDGE_READ_STATUS=OK"
Write-Host "MONITOR_PRODUCTION_HTTP_METHODS=GET_ONLY"

if (-not $Notify) {
  Write-Host 'MONITOR_NOTIFY=FALSE'
  Write-Host 'MONITOR_REPOSITORY_MUTATION=NONE'
  exit 0
}

$repo = $env:GITHUB_REPOSITORY
if ([string]::IsNullOrWhiteSpace($repo)) { throw 'GITHUB_REPOSITORY is missing' }
$issueUri = "https://api.github.com/repos/$repo/issues/$IssueNumber"
$issue = Invoke-GitHubJson -Method Get -Uri $issueUri

$pattern = '(?m)^<!-- XAUUSD_AUTO_LIVE_MONITOR_STATE_JSON:(\{.*\}) -->$'
$match = [regex]::Match([string]$issue.body, $pattern)
if (-not $match.Success) { throw 'AUTO_LIVE_MONITOR_STATE_MARKER_MISSING' }
$previous = $match.Groups[1].Value | ConvertFrom-Json

function Prev {
  param([string]$Name)
  return Get-ObjectProperty $previous $Name
}

$events = New-Object 'System.Collections.Generic.List[string]'

if ([string](Prev 'bridgeReadStatus') -in @('FAILED', 'OFFLINE_EXPECTED')) {
  $events.Add("BRIDGE_READ_RECOVERED: previous failure observed at $([string](Prev 'bridgeFailureObservedAt'))")
}

if ([string](Prev 'regime') -ne $currentRegime -or
    [string](Prev 'recommendedMode') -ne $recommendedMode -or
    [string](Prev 'effectiveStrategy') -ne $effectiveStrategy) {
  $events.Add("REGIME_OR_STRATEGY_CHANGED: $([string](Prev 'regime'))/$([string](Prev 'recommendedMode'))/$([string](Prev 'effectiveStrategy')) -> $currentRegime/$recommendedMode/$effectiveStrategy")
}

$prevPositionCount = [int](Prev 'positionCount')
$prevOrderCount = [int](Prev 'pendingOrderCount')
if ($positions.Count -gt $prevPositionCount) {
  $events.Add("POSITION_OPENED: $prevPositionCount -> $($positions.Count)")
} elseif ($positions.Count -lt $prevPositionCount) {
  $events.Add("POSITION_CLOSED: $prevPositionCount -> $($positions.Count)")
} elseif ([string](Prev 'positionSignature') -ne [string]$state.positionSignature) {
  $events.Add('POSITION_SET_CHANGED')
}

if ($orders.Count -ne $prevOrderCount -or [string](Prev 'pendingOrderSignature') -ne [string]$state.pendingOrderSignature) {
  $events.Add("PENDING_ORDER_SET_CHANGED: $prevOrderCount -> $($orders.Count)")
}

if ($prevPositionCount -gt 0 -and $positions.Count -gt 0 -and [string](Prev 'managementFingerprint') -ne [string]$state.managementFingerprint) {
  $events.Add('FASTMOVE_OR_M5_MANAGEMENT_STATE_CHANGED')
}

if ([string](Prev 'ownershipFingerprint') -ne [string]$state.ownershipFingerprint -and ($prevPositionCount -gt 0 -or $positions.Count -gt 0)) {
  $events.Add('POSITION_OWNERSHIP_EVIDENCE_CHANGED')
}
if (-not [string]::IsNullOrEmpty([string]$state.ownershipAlertSignature) -and [string](Prev 'ownershipAlertSignature') -ne [string]$state.ownershipAlertSignature) {
  $events.Add('POSITION_OWNERSHIP_ALERT')
}

if (-not $telegramReady -or $telegramStatus -ne 'READY') {
  if ([bool](Prev 'telegramReady') -ne $telegramReady -or [string](Prev 'telegramStatus') -ne $telegramStatus) {
    $events.Add("TELEGRAM_NOT_READY: ready=$telegramReady status=$telegramStatus")
  }
}

if ($armStatus -ne 'ARMED' -or -not $liveExecutionArmed) {
  if ([string](Prev 'armStatus') -ne $armStatus -or [bool](Prev 'liveExecutionArmed') -ne $liveExecutionArmed) {
    $events.Add("ARM_LOST: status=$armStatus armed=$liveExecutionArmed")
  }
}

if (-not $lifecycleRunning -or -not $lifecycleReady) {
  if ([bool](Prev 'lifecycleRunning') -ne $lifecycleRunning -or [bool](Prev 'lifecycleReady') -ne $lifecycleReady) {
    $events.Add("LIFECYCLE_NOT_READY: running=$lifecycleRunning ready=$lifecycleReady")
  }
}

if ($mt5Status -ne 'HEALTHY') {
  if ([string](Prev 'mt5Status') -ne $mt5Status) {
    $events.Add("MT5_NOT_HEALTHY: status=$mt5Status")
  }
}

$sourceBad = (
  $runtimeOverall -ne 'EXACT_MATCH' -or
  $sourceCommit -ne $ExpectedSourceCommit -or
  $productionHead -ne $ExpectedSourceCommit -or
  $componentMismatches.Count -gt 0
)
if ($sourceBad) {
  $previousSourceHealthy = (
    [string](Prev 'runtimeSourceOverall') -eq 'EXACT_MATCH' -and
    [string](Prev 'sourceCommit') -eq $ExpectedSourceCommit -and
    ([string](Prev 'sourceComponentMismatches')) -eq ''
  )
  if ($previousSourceHealthy -or [string](Prev 'sourceCommit') -ne $sourceCommit -or [string](Prev 'runtimeSourceOverall') -ne $runtimeOverall -or [string](Prev 'sourceComponentMismatches') -ne [string]$state.sourceComponentMismatches) {
    $events.Add("RUNTIME_SOURCE_DRIFT: productionHead=$productionHead attested=$sourceCommit overall=$runtimeOverall mismatches=$([string]$state.sourceComponentMismatches)")
  }
}

if ($accountMode -ne 'LIVE' -or $botMode -ne 'AUTO') {
  if ([string](Prev 'accountMode') -ne $accountMode -or [string](Prev 'botMode') -ne $botMode) {
    $events.Add("AUTO_LIVE_STATE_CHANGED: account=$accountMode botMode=$botMode")
  }
}

$stateJson = $state | ConvertTo-Json -Depth 12 -Compress
$newMarker = "<!-- XAUUSD_AUTO_LIVE_MONITOR_STATE_JSON:$stateJson -->"

$comparisonNames = @(
  'bridgeReadStatus','bridgeFailureObservedAt','expectedSourceCommit','sourceCommit','productionHead','botMode','accountMode','lifecycleRunning','lifecycleReady',
  'telegramReady','telegramStatus','mt5Status','armStatus','liveExecutionArmed',
  'runtimeSourceOverall','sourceComponentMismatches','regime','recommendedMode','effectiveStrategy',
  'positionCount','pendingOrderCount','positionSignature','pendingOrderSignature',
  'ownershipFingerprint','ownershipAlertSignature','managementFingerprint'
)
$changed = $false
foreach ($name in $comparisonNames) {
  if ([string](Prev $name) -ne [string](Get-ObjectProperty ([pscustomobject]$state) $name)) {
    $changed = $true
    break
  }
}

if ($events.Count -gt 0) {
  $eventText = ($events | ForEach-Object { "- **$_**" }) -join [Environment]::NewLine
  $positionText = if ($positionLines.Count -gt 0) { ($positionLines | ForEach-Object { "- $_" }) -join [Environment]::NewLine } else { '- none' }
  $orderText = if ($orderLines.Count -gt 0) { ($orderLines | ForEach-Object { "- $_" }) -join [Environment]::NewLine } else { '- none' }
  $managementText = if ($managementPairs.Count -gt 0) { (@($managementPairs) | Select-Object -First 20 | ForEach-Object { "- $_" }) -join [Environment]::NewLine } else { '- none' }
  $ownershipText = if ($ownershipPairs.Count -gt 0) { (@($ownershipPairs) | Select-Object -First 20 | ForEach-Object { "- $_" }) -join [Environment]::NewLine } else { '- none' }

  $comment = @"
## AUTO LIVE monitor event

$eventText

~~~text
OBSERVED_AT=$($state.observedAt)
EXPECTED_SOURCE_COMMIT=$ExpectedSourceCommit
SOURCE_COMMIT=$sourceCommit
PRODUCTION_HEAD=$productionHead
ACCOUNT_MODE=$accountMode
BOT_MODE=$botMode
LIFECYCLE_RUNNING=$lifecycleRunning
LIFECYCLE_READY=$lifecycleReady
TELEGRAM_READY=$telegramReady
TELEGRAM_STATUS=$telegramStatus
MT5_STATUS=$mt5Status
ARM_STATUS=$armStatus
LIVE_EXECUTION_ARMED=$liveExecutionArmed
RUNTIME_SOURCE_OVERALL=$runtimeOverall
REGIME=$currentRegime
RECOMMENDED_MODE=$recommendedMode
EFFECTIVE_STRATEGY=$effectiveStrategy
POSITIONS=$($positions.Count)
PENDING_ORDERS=$($orders.Count)
~~~

### Positions
$positionText

### Pending orders
$orderText

### FastMove / M5 management evidence
$managementText

### Ownership evidence
$ownershipText

~~~text
PRODUCTION_READ_ONLY=TRUE
PRODUCTION_HTTP_METHODS=GET_ONLY
MODE_MUTATION=NONE
ARM_MUTATION=NONE
ACCOUNT_SWITCH=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
LIVE_TEST_ORDER=NONE
~~~
"@

  Invoke-GitHubJson -Method Post -Uri "$issueUri/comments" -Body @{ body = $comment } | Out-Null
}

if ($changed) {
  $newBody = [regex]::Replace([string]$issue.body, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $newMarker })
  Invoke-GitHubJson -Method Patch -Uri $issueUri -Body @{ body = $newBody } | Out-Null
}

if ($env:GITHUB_STEP_SUMMARY) {
  @"
## AUTO LIVE read-only monitor

- Account / mode: **$accountMode / $botMode**
- ARM: **$armStatus**
- Lifecycle: **running=$lifecycleRunning, ready=$lifecycleReady**
- Telegram: **ready=$telegramReady, status=$telegramStatus**
- MT5: **$mt5Status**
- Runtime source: **$runtimeOverall** (expected **$ExpectedSourceCommit**)
- Regime: **$currentRegime -> $recommendedMode**
- Effective strategy: **$effectiveStrategy**
- Positions / pending: **$($positions.Count) / $($orders.Count)**
- Events emitted: **$($events.Count)**
- Production mutation: **NONE**
"@ | Out-File -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
}

Write-Host "MONITOR_NOTIFY=TRUE"
Write-Host "MONITOR_EVENT_COUNT=$($events.Count)"
foreach ($event in $events) { Write-Host "MONITOR_EVENT=$event" }
Write-Host "MONITOR_ISSUE_STATE_UPDATED=$changed"
Write-Host "MONITOR_PRODUCTION_MUTATION=NONE"
