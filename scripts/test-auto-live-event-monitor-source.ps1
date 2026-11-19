$ErrorActionPreference = 'Stop'
$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkflowPath = Join-Path $ProjectRoot '.github\workflows\auto-live-event-monitor.yml'
$MonitorPath = Join-Path $ProjectRoot 'scripts\ops\auto-live-event-monitor.ps1'

if (-not (Test-Path -LiteralPath $WorkflowPath)) {
  throw "AUTO LIVE monitor workflow missing: $WorkflowPath"
}
if (-not (Test-Path -LiteralPath $MonitorPath)) {
  throw "AUTO LIVE monitor script missing: $MonitorPath"
}

$Workflow = Get-Content -LiteralPath $WorkflowPath -Raw
$Monitor = Get-Content -LiteralPath $MonitorPath -Raw

[void][scriptblock]::Create($Monitor)

function Assert-Literal {
  param([string]$Source, [string]$Text, [string]$Label)
  if ($Source.IndexOf($Text, [System.StringComparison]::Ordinal) -lt 0) {
    throw "Missing AUTO LIVE monitor contract literal: $Label"
  }
}

function Assert-Match {
  param([string]$Source, [string]$Pattern, [string]$Label)
  if ($Source -notmatch $Pattern) {
    throw "Missing AUTO LIVE monitor contract pattern: $Label"
  }
}

function Assert-NotMatch {
  param([string]$Source, [string]$Pattern, [string]$Label)
  if ($Source -match $Pattern) {
    throw "Forbidden AUTO LIVE monitor pattern: $Label"
  }
}

Assert-Literal $Workflow 'name: Legacy AUTO LIVE Monitor (private-core manual only)' 'legacy workflow identity'
Assert-Match $Workflow '(?m)^on:\r?\n  workflow_dispatch:' 'explicit manual trigger only'
Assert-NotMatch $Workflow '(?m)^\s{2}(?:schedule|push|pull_request):' 'no production scheduling or PR code execution in independent V6'
Assert-Literal $Workflow "if: github.repository == 'thiennguyen3004931-sudo/xauusd-ai-master-core'" 'legacy private-core repository scope only'
Assert-Literal $Workflow 'issues: write' 'issue-only persistence permission'
Assert-Literal $Workflow 'contents: read' 'read-only repository content permission'
Assert-Literal $Workflow 'runs-on: [self-hosted, Windows, X64, xauusd-core-ci]' 'canonical self-hosted runner labels'
Assert-Literal $Workflow 'scripts/test-auto-live-event-monitor-source.ps1' 'static safety contract executes before monitor'
Assert-Literal $Workflow "if: github.event_name != 'pull_request'" 'do not probe production from unmerged pull request code'
Assert-Literal $Workflow '$notify = $false' 'validation defaults to no persistence'
Assert-NotMatch $Workflow "github.event_name }}' -eq 'schedule'" 'no scheduled production issue persistence on V6'
Assert-Literal $Workflow '$notify = $true' 'explicit manual persistence only'
Assert-Literal $Workflow "inputs.notify }}' -eq 'true'" 'manual notify opt-in'
Assert-NotMatch $Workflow 'EXPECTED_SOURCE_COMMIT:' 'workflow must not hard-code production source SHA'
Assert-Literal $Workflow "MONITOR_ISSUE_NUMBER: '28'" 'legacy issue number (guarded out on public V6)'
Assert-Literal $Workflow 'MONITOR_PRODUCTION_READ_ONLY=TRUE' 'read-only safety summary'
Assert-Literal $Workflow 'cancel-in-progress: true' 'latest-wins concurrency'
if ($Workflow.Contains('feat/auto-live-event-monitor-77f13bbd')) { throw 'Stale AUTO LIVE monitor branch trigger must be removed.' }
Assert-Literal $Workflow 'MONITOR_PRODUCTION_HTTP_METHODS=GET_ONLY' 'GET-only safety summary'
Assert-Literal $Workflow 'MONITOR_MODE_MUTATION=NONE' 'mode mutation forbidden'
Assert-Literal $Workflow 'MONITOR_ARM_MUTATION=NONE' 'ARM mutation forbidden'
Assert-Literal $Workflow 'MONITOR_ORDER_MUTATION=NONE' 'order mutation forbidden'
Assert-Literal $Workflow 'MONITOR_POSITION_MUTATION=NONE' 'position mutation forbidden'

Assert-Literal $Monitor "[string]`$ExpectedSourceCommit = ''" 'monitor defaults to dynamic canonical source'
Assert-Literal $Monitor 'refs/remotes/origin/main' 'canonical origin/main source resolution'
Assert-Literal $Monitor "MONITOR_EXPECTED_SOURCE_COMMIT=`$ExpectedSourceCommit" 'resolved expected source evidence'
Assert-Match $Monitor "\^\[0-9a-f\]\{40\}\$" 'expected source SHA validation'
Assert-NotMatch $Monitor '8514fafffea7e7cde6a3bddfbb3cd23474bc20f7' 'stale production SHA removed'
Assert-Literal $Monitor '[switch]$Notify' 'explicit persistence switch'
Assert-Literal $Monitor "Write-Host 'MONITOR_NOTIFY=FALSE'" 'dry-run evidence'
Assert-Literal $Monitor "Write-Host 'MONITOR_REPOSITORY_MUTATION=NONE'" 'dry-run repository safety'
Assert-Literal $Monitor 'MONITOR_PRODUCTION_HTTP_METHODS=GET_ONLY' 'runtime GET-only evidence'
Assert-Literal $Monitor 'MONITOR_PRODUCTION_MUTATION=NONE' 'runtime production safety evidence'

$NotifyGuardIndex = $Monitor.IndexOf('if (-not $Notify)', [System.StringComparison]::Ordinal)
$IssueReadIndex = $Monitor.IndexOf('$issue = Invoke-GitHubJson -Method Get', [System.StringComparison]::Ordinal)
if ($NotifyGuardIndex -lt 0 -or $IssueReadIndex -lt 0 -or $NotifyGuardIndex -ge $IssueReadIndex) {
  throw 'Notify=false guard must exit before normal state persistence.'
}
# Both bridge persistence call sites must have their OWN notify guard.
# The planned-downtime handler legitimately occurs before the normal $Notify guard.
# Do not compare against the first occurrence of a different branch's guard.
Assert-Match $Monitor '(?s)if \(\$Notify\)\s*\{\s*Write-BridgeFailureState -FailureCategory \$bridgeFailureCategory -ExpectedOffline\s*Write-Host' 'expected downtime issue persistence requires explicit notify'
Assert-Match $Monitor '(?s)if \(-not \$Notify\)\s*\{\s*Write-Host ''MONITOR_NOTIFY=FALSE''\s*Write-Host ''MONITOR_REPOSITORY_MUTATION=NONE''\s*throw "AUTO_LIVE_BRIDGE_READ_FAILED: \$bridgeFailureCategory"\s*\}\s*Write-BridgeFailureState -FailureCategory \$bridgeFailureCategory' 'unexpected bridge failure issue persistence requires explicit notify'

Assert-Literal $Monitor 'Read-BridgeArray -Uri "$bridgeBase/v1/positions?symbol=XAUUSD"' 'position read endpoint'
Assert-Literal $Monitor 'Read-BridgeArray -Uri "$bridgeBase/v1/orders?symbol=XAUUSD"' 'pending-order read endpoint'
Assert-Literal $Monitor '$envInfo = Assert-Phase7CAccountEnv -EnvFile $envFile -AccountMode LIVE' 'read-only config permits disabled trading'
Assert-NotMatch $Monitor 'Assert-Phase7CAccountEnv[^\r\n]*-RequireTrading' 'read-only monitor must not require trade execution enablement'
Assert-Literal $Monitor 'Invoke-RestMethod -Uri "$bridgeBase/health"' 'MT5 bridge health read'
Assert-Literal $Monitor "/api/v1/phase7c/lifecycle' -Method Get" 'lifecycle GET'
Assert-Literal $Monitor "/api/v1/phase7c-live-arm-control/capability' -Method Get" 'ARM capability GET'
Assert-Literal $Monitor "/api/v1/mt5/status?symbol=XAUUSD' -Method Get" 'MT5 status GET'
Assert-Literal $Monitor "/api/v1/phase7c/runtime-source-attestation/' -Method Get" 'runtime-source GET'
Assert-Literal $Monitor "/api/v1/phase7c/live-regime?symbol=XAUUSD&count=320' -Method Get" 'regime GET'
Assert-Literal $Monitor "/api/v1/phase7c/decision-monitor?symbol=XAUUSD' -Method Get" 'decision monitor GET'

Assert-NotMatch $Monitor '(?im)Invoke-(?:RestMethod|WebRequest)[^\r\n]*(?:127\.0\.0\.1|\$bridgeBase)[^\r\n]*-Method\s+(?:Post|Put|Patch|Delete)' 'production HTTP mutation'
Assert-NotMatch $Monitor '(?im)-Uri\s+[^\r\n]*(?:/v1/orders|phase7c-live-arm-control|bot-mode|auto-activation)[^\r\n]*-Method\s+(?:Post|Put|Patch|Delete)' 'trading/control mutation endpoint'

foreach ($EventMarker in @(
  'REGIME_OR_STRATEGY_CHANGED',
  'POSITION_OPENED',
  'POSITION_CLOSED',
  'POSITION_SET_CHANGED',
  'PENDING_ORDER_SET_CHANGED',
  'FASTMOVE_OR_M5_MANAGEMENT_STATE_CHANGED',
  'POSITION_OWNERSHIP_EVIDENCE_CHANGED',
  'POSITION_OWNERSHIP_ALERT',
  'TELEGRAM_NOT_READY',
  'ARM_LOST',
  'LIFECYCLE_NOT_READY',
  'MT5_NOT_HEALTHY',
  'RUNTIME_SOURCE_DRIFT',
  'AUTO_LIVE_STATE_CHANGED',
  'BRIDGE_READ_FAILED',
  'BRIDGE_READ_RECOVERED'
)) {
  Assert-Literal $Monitor $EventMarker "event marker $EventMarker"
}

foreach ($StateField in @(
  'bridgeReadStatus',
  'bridgeFailureObservedAt',
  'expectedSourceCommit',
  'sourceCommit',
  'productionHead',
  'botMode',
  'accountMode',
  'lifecycleRunning',
  'lifecycleReady',
  'telegramReady',
  'telegramStatus',
  'mt5Status',
  'armStatus',
  'liveExecutionArmed',
  'runtimeSourceOverall',
  'regime',
  'recommendedMode',
  'effectiveStrategy',
  'positionCount',
  'pendingOrderCount',
  'positionSignature',
  'pendingOrderSignature',
  'ownershipFingerprint',
  'ownershipAlertSignature',
  'managementFingerprint'
)) {
  Assert-Match $Monitor ("(?m)^\s*" + [regex]::Escape($StateField) + "\s*=") "state field $StateField"
}

$GitHubCalls = [regex]::Matches(
  $Monitor,
  '(?m)^\s*(?:\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?Invoke-GitHubJson\s+-Method\s+(Get|Post|Patch|Put|Delete)\s+-Uri\s+([^\r\n]+)'
)
if ($GitHubCalls.Count -ne 6) {
  throw "Expected 6 GitHub issue persistence calls across normal and bridge-failure paths, found $($GitHubCalls.Count)."
}

$Methods = @($GitHubCalls | ForEach-Object { $_.Groups[1].Value })
if (($Methods -join ',') -ne 'Get,Post,Patch,Get,Post,Patch') {
  throw "Unexpected GitHub persistence methods: $($Methods -join ',')"
}

Assert-Literal $Monitor 'Invoke-GitHubJson -Method Get -Uri $issueUri' 'issue state read'
Assert-Literal $Monitor 'Invoke-GitHubJson -Method Post -Uri "$issueUri/comments"' 'event comment append'
Assert-Literal $Monitor 'Invoke-GitHubJson -Method Patch -Uri $issueUri' 'state marker update'
Assert-Literal $Monitor 'function Write-BridgeFailureState' 'bridge failure persistence handler'
Assert-Literal $Monitor 'MONITOR_BRIDGE_READ_STATUS=FAILED' 'bridge read failure status'
Assert-Literal $Monitor 'MONITOR_BRIDGE_INCIDENT=ALREADY_RECORDED' 'bridge failure deduplication'
Assert-Literal $Monitor "bridgeReadStatus = 'OK'" 'successful bridge observation state'
Assert-Literal $Monitor "BRIDGE_READ_RECOVERED: previous failure observed at" 'bridge recovery event'
$FailureHandlerStart = $Monitor.IndexOf('function Write-BridgeFailureState', [System.StringComparison]::Ordinal)
$FailureHandlerEnd = $Monitor.IndexOf('$accountPath =', $FailureHandlerStart, [System.StringComparison]::Ordinal)
if ($FailureHandlerStart -lt 0 -or $FailureHandlerEnd -le $FailureHandlerStart) {
  throw 'Bridge failure handler boundaries could not be located.'
}
$FailureHandler = $Monitor.Substring($FailureHandlerStart, $FailureHandlerEnd - $FailureHandlerStart)
Assert-NotMatch $FailureHandler '(?m)^\s*(?:observedAt|botMode|armStatus|positionCount|pendingOrderCount)\s*=' 'bridge failure must not overwrite last full bot snapshot'
Assert-Literal $FailureHandler "Add-Member -NotePropertyName bridgeReadStatus -NotePropertyValue 'FAILED'" 'bridge failure state persistence'
Assert-Literal $FailureHandler 'The issue''s existing bot mode, ARM, positions, pending orders, and strategy fields were **not refreshed**' 'historical snapshot warning'
Assert-NotMatch $Monitor 'Invoke-GitHubJson\s+-Method\s+(?:Put|Delete)' 'unexpected GitHub mutation method'

Assert-Literal $Monitor "auto-live-offline-lease.ps1" 'offline lease classifier is sourced'
Assert-Literal $Monitor 'MONITOR_BRIDGE_READ_STATUS=OFFLINE_EXPECTED' 'explicit expected downtime status'
Assert-Literal $Monitor "MONITOR_RUNTIME_HEALTH=NOT_VERIFIED" 'no false health classification'
Assert-Literal $Monitor "MONITOR_DATA_FRESHNESS=UNAVAILABLE" 'no stale observation accepted as current'
Assert-Literal $Monitor "BRIDGE_OFFLINE_EXPECTED" 'operator downtime is distinguishable in issue audit'
Assert-Literal $Monitor 'Get-AutoLiveBridgeFailureCategory -Exception $_.Exception' 'HTTP-aware failure categorization'
Assert-Literal $Monitor 'Test-AutoLiveExpectedOffline -FailureCategory $bridgeFailureCategory -LeaseState $offlineLeaseState' 'only verified connectivity downtime is expected'
Assert-Literal $Workflow 'scripts/test-auto-live-offline-lease.ps1' 'offline lease regression remains available for manual diagnostic'
Assert-Literal $Monitor 'auto-live-offline-lease.ps1' 'legacy lease classification source remains intact'

Write-Host 'AUTO_LIVE_MONITOR_SOURCE_CONTRACT=PASS'
Write-Host 'PRODUCTION_HTTP_METHODS=GET_ONLY'
Write-Host 'PRODUCTION_MUTATION=NONE'
