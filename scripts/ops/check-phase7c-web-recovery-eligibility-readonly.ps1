# LIVE emergency assessment only. No lifecycle/task/process/source/ARM/mode/order mutations.
param(
  [string]$ProductionRoot = 'F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master',
  [string]$ExpectedSource = '196a8420ff008548773f5d385cf5785a9f84e297',
  [string]$ReceiptPath = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$blockers = New-Object 'System.Collections.Generic.List[string]'
$evidence = [ordered]@{
  version = 1
  observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  productionHeadMatches = $false
  gitTrackedClean = $false
  taskWebReady = $false
  taskExecutorsRunning = $false
  persistedModePause = $false
  persistedAccountLive = $false
  liveArmFileAbsent = $false
  relevantPortsUnbound = $false
  brokerHealthConnected = $false
  brokerLiveReal = $false
  brokerArmDisarmed = $false
  brokerXauFlat = $false
  webRestartAuthorized = $false
  operatorFollowupRequired = $true
}
function Block([string]$Reason) { $blockers.Add($Reason) }
function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop) }
  catch { return $null }
}
function Read-BrokerCount([string]$Uri, [hashtable]$Headers) {
  $response = Invoke-WebRequest -Method Get -Uri $Uri -Headers $Headers -UseBasicParsing -TimeoutSec 7
  $raw = ([string]$response.Content).Trim()
  if ($raw -eq '[]') { return 0 }
  if ([string]::IsNullOrWhiteSpace($raw)) { throw 'BROKER_LIST_EMPTY_NOT_VERIFIABLE' }
  $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
  if ($null -eq $parsed -or $parsed -isnot [array]) { throw 'BROKER_LIST_NOT_ARRAY' }
  return @($parsed).Count
}
try {
  if (-not (Test-Path -LiteralPath $ProductionRoot -PathType Container)) { Block 'PRODUCTION_ROOT_MISSING'; throw 'BLOCKED' }
  $head = (& git -C $ProductionRoot rev-parse HEAD).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0) { Block 'GIT_READ_FAILED'; throw 'BLOCKED' }
  $branch = (& git -C $ProductionRoot branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0) { Block 'GIT_BRANCH_READ_FAILED'; throw 'BLOCKED' }
  $evidence.productionHeadMatches = $head -eq $ExpectedSource -and $branch -eq 'main'
  if (-not $evidence.productionHeadMatches) { Block 'PRODUCTION_SOURCE_OR_BRANCH_MISMATCH' }
  $dirty = @(& git -C $ProductionRoot status --porcelain --untracked-files=no)
  if ($LASTEXITCODE -ne 0) { Block 'GIT_WORKTREE_READ_FAILED' }
  else {
    $evidence.gitTrackedClean = $dirty.Count -eq 0
    if (-not $evidence.gitTrackedClean) { Block 'PRODUCTION_TRACKED_WORKTREE_DIRTY' }
  }
  $config = Read-Json (Join-Path $ProductionRoot '.runtime\phase7c-executor-task-config.json')
  $mode = Read-Json (Join-Path $ProductionRoot '.runtime\phase7c-bot-mode.json')
  $account = Read-Json (Join-Path $ProductionRoot '.runtime\phase7c-account-mode.json')
  $evidence.persistedModePause = ($null -ne $mode -and [string]$mode.mode -eq 'PAUSE')
  $evidence.persistedAccountLive = ($null -ne $account -and [string]$account.accountMode -eq 'LIVE')
  $evidence.liveArmFileAbsent = -not (Test-Path -LiteralPath (Join-Path $ProductionRoot '.runtime\phase7c-live-arm.json') -PathType Leaf)
  if (-not $evidence.persistedModePause) { Block 'PERSISTED_BOT_MODE_NOT_PAUSE_OR_UNKNOWN' }
  if (-not $evidence.persistedAccountLive) { Block 'PERSISTED_ACCOUNT_NOT_LIVE_OR_UNKNOWN' }
  if (-not $evidence.liveArmFileAbsent) { Block 'LOCAL_ARM_FILE_PRESENT_OR_UNKNOWN' }

  try {
    $web = Get-ScheduledTask -TaskName 'XAUUSD-Phase7B-Web' -ErrorAction Stop
    $executors = Get-ScheduledTask -TaskName 'XAUUSD-Phase7C-Executors' -ErrorAction Stop
    $evidence.taskWebReady = [string]$web.State -eq 'Ready'
    $evidence.taskExecutorsRunning = [string]$executors.State -eq 'Running'
    if (-not $evidence.taskWebReady) { Block 'WEB_TASK_NOT_READY' }
    if (-not $evidence.taskExecutorsRunning) { Block 'EXECUTOR_TASK_NOT_RUNNING' }
  } catch { Block 'TASK_STATE_UNAVAILABLE' }
  try {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { [int]$_.LocalPort -in @(3711,5717) })
    $evidence.relevantPortsUnbound = $listeners.Count -eq 0
    if (-not $evidence.relevantPortsUnbound) { Block 'API_OR_WEB_PORT_ALREADY_BOUND' }
  } catch { Block 'PORT_STATE_UNVERIFIED' }

  if ($null -eq $config -or [string]$config.accountMode -ne 'LIVE') {
    Block 'CANONICAL_TASK_CONFIG_INVALID'
  } elseif ($evidence.productionHeadMatches) {
    $control = ([string]$config.controlApiUrl).TrimEnd('/')
    if ($control -ne 'http://127.0.0.1:3711') { Block 'CONTROL_API_URL_NOT_CANONICAL' }
    else {
      $envFile = [string]$config.envFile
      if (-not [IO.Path]::IsPathRooted($envFile)) { $envFile = Join-Path $ProductionRoot $envFile }
      $accountLib = Join-Path $ProductionRoot 'scripts\lib\phase7c-account-mode.ps1'
      try {
        if (-not (Test-Path -LiteralPath $accountLib -PathType Leaf)) { throw 'CANONICAL_ACCOUNT_LIBRARY_MISSING' }
        . $accountLib
        $info = Assert-Phase7CAccountEnv -EnvFile $envFile -AccountMode 'LIVE' -RequireTrading
        if ([string]$info.bridgeHost -notin @('127.0.0.1','localhost','::1')) { throw 'BRIDGE_HOST_NOT_LOOPBACK' }
        $headers = @{ 'x-mt5-api-key' = [string]$info.apiKey }
        $bridgeBase = 'http://' + [string]$info.bridgeHost + ':' + [string]$info.bridgePort
        $health = Invoke-RestMethod -Method Get -Uri "$bridgeBase/health" -Headers $headers -TimeoutSec 7
        $evidence.brokerHealthConnected = ([bool]$health.connected -and [string]$health.status -eq 'ok')
        $evidence.brokerLiveReal = ([string]$health.configuredAccountMode -eq 'LIVE' -and [string]$health.accountMode -eq 'real')
        $evidence.brokerArmDisarmed = ([string]$health.liveArmStatus -eq 'DISARMED' -and -not [bool]$health.liveExecutionArmed)
        if (-not $evidence.brokerHealthConnected) { Block 'BROKER_HEALTH_UNVERIFIED' }
        if (-not $evidence.brokerLiveReal) { Block 'BROKER_ACCOUNT_NOT_LIVE_REAL' }
        if (-not $evidence.brokerArmDisarmed) { Block 'BROKER_ARM_NOT_CONFIRMED_DISARMED' }
        if ($evidence.brokerHealthConnected -and $evidence.brokerLiveReal) {
          $pos = Read-BrokerCount -Uri "$bridgeBase/v1/positions?symbol=XAUUSD" -Headers $headers
          $pending = Read-BrokerCount -Uri "$bridgeBase/v1/orders?symbol=XAUUSD" -Headers $headers
          $evidence.brokerXauFlat = ($pos -eq 0 -and $pending -eq 0)
          if (-not $evidence.brokerXauFlat) { Block 'BROKER_HAS_XAU_POSITIONS_OR_PENDING' }
        }
      } catch {
        Block 'BROKER_READ_UNAVAILABLE_OR_INVALID'
      }
    }
  }
} catch {
  if ($_.Exception.Message -ne 'BLOCKED') { Block 'READ_ONLY_ASSESSMENT_INCOMPLETE' }
}
$complete = (
  $evidence.productionHeadMatches -and $evidence.gitTrackedClean -and
  $evidence.taskWebReady -and $evidence.taskExecutorsRunning -and
  $evidence.persistedModePause -and $evidence.persistedAccountLive -and
  $evidence.liveArmFileAbsent -and $evidence.relevantPortsUnbound -and
  $evidence.brokerHealthConnected -and $evidence.brokerLiveReal -and
  $evidence.brokerArmDisarmed -and $evidence.brokerXauFlat -and $blockers.Count -eq 0
)
$evidence['preRecoveryChecksPass'] = [bool]$complete
$evidence['webRestartAuthorized'] = $false
$evidence['blockerCodes'] = @($blockers.ToArray())
Write-Host "PHASE7C_RECOVERY_READONLY_SOURCE_MATCH=$($evidence.productionHeadMatches)"
Write-Host "PHASE7C_RECOVERY_READONLY_WEB_TASK_READY=$($evidence.taskWebReady)"
Write-Host "PHASE7C_RECOVERY_READONLY_EXECUTORS_RUNNING=$($evidence.taskExecutorsRunning)"
Write-Host "PHASE7C_RECOVERY_READONLY_PERSISTED_PAUSE=$($evidence.persistedModePause)"
Write-Host "PHASE7C_RECOVERY_READONLY_LOCAL_ARM_FILE_ABSENT=$($evidence.liveArmFileAbsent)"
Write-Host "PHASE7C_RECOVERY_READONLY_PORTS_UNBOUND=$($evidence.relevantPortsUnbound)"
Write-Host "PHASE7C_RECOVERY_READONLY_BRIDGE_CONNECTED=$($evidence.brokerHealthConnected)"
Write-Host "PHASE7C_RECOVERY_READONLY_BRIDGE_LIVE_REAL=$($evidence.brokerLiveReal)"
Write-Host "PHASE7C_RECOVERY_READONLY_ARM_DISARMED=$($evidence.brokerArmDisarmed)"
Write-Host "PHASE7C_RECOVERY_READONLY_BROKER_FLAT=$($evidence.brokerXauFlat)"
Write-Host "PHASE7C_RECOVERY_READONLY_PRECHECK_PASS=$complete"
Write-Host "PHASE7C_RECOVERY_READONLY_BLOCKERS=$(@($blockers.ToArray()) -join ',')"
Write-Host 'PHASE7C_RECOVERY_READONLY_WEB_RESTART_AUTHORIZED=FALSE'
Write-Host 'PHASE7C_RECOVERY_READONLY_PRODUCTION_MUTATION=NONE'
Write-Host 'PHASE7C_RECOVERY_READONLY_BROKER_HTTP_METHODS=GET_ONLY'
Write-Host 'PHASE7C_RECOVERY_READONLY_ORDER_MUTATION=NONE'
Write-Host 'PHASE7C_RECOVERY_READONLY_ARM_MODE_MUTATION=NONE'
if (-not [string]::IsNullOrWhiteSpace($ReceiptPath)) {
  $out = $evidence | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($ReceiptPath, $out, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Host 'PHASE7C_RECOVERY_READONLY_ASSESSMENT=COMPLETE'
