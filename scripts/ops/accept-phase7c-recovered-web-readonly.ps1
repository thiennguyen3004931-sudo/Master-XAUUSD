# Post-recovery LIVE Web/API acceptance evidence, strictly GET/read-only.
# Does NOT authorize ARM, AUTO, restart or order placement.
param(
  [string]$ProductionRoot = 'F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master',
  [string]$ExpectedSource = '196a8420ff008548773f5d385cf5785a9f84e297',
  [string]$ReceiptPath = '',
  [int]$Samples = 3
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Samples -lt 2 -or $Samples -gt 5) { throw 'READONLY_ACCEPTANCE_SAMPLES_OUT_OF_RANGE' }
$blockers = New-Object 'System.Collections.Generic.List[string]'
$evidence = [ordered]@{
  schemaVersion = 1
  observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  expectedProductionCommit = $ExpectedSource
  productionCommitExact = $false
  productionBranchMain = $false
  trackedWorktreeClean = $false
  webTaskRunning = $false
  executorTaskRunning = $false
  webTaskTrustedAction = $false
  webLauncherBlobExact = $false
  apiReachable = $false
  webReachable = $false
  runtimeReadyStable = $false
  botModePaused = $false
  accountLiveValid = $false
  lifecycleReady = $false
  armDisarmed = $false
  sourceAttestation8of8 = $false
  brokerLiveConnected = $false
  brokerDisarmed = $false
  xauPositionsAndOrdersFlat = $false
  pass = $false
  restartAuthorized = $false
  liveTradingAuthorized = $false
  blockerCodes = @()
}
function Block([string]$Code) {
  if (-not $blockers.Contains($Code)) { $blockers.Add($Code) }
}
function Read-Api([string]$Path) {
  return Invoke-RestMethod -Uri ('http://127.0.0.1:3711' + $Path) -Method Get -TimeoutSec 6
}
function Read-BrokerCount([string]$Uri, [hashtable]$Headers) {
  $resp = Invoke-WebRequest -Uri $Uri -Method Get -Headers $Headers -UseBasicParsing -TimeoutSec 7
  $raw = ([string]$resp.Content).Trim()
  if ($raw -eq '[]') { return 0 }
  if (-not $raw) { throw 'BROKER_EMPTY_LIST_UNVERIFIABLE' }
  $items = $raw | ConvertFrom-Json -ErrorAction Stop
  if ($items -isnot [array]) { throw 'BROKER_LIST_NOT_ARRAY' }
  return @($items).Count
}
try {
  if ($ExpectedSource -notmatch '^[a-f0-9]{40}$') { Block 'EXPECTED_SOURCE_INVALID'; throw 'BLOCKED' }
  if (-not (Test-Path -LiteralPath $ProductionRoot -PathType Container)) { Block 'PRODUCTION_ROOT_MISSING'; throw 'BLOCKED' }
  $head = (& git -C $ProductionRoot rev-parse HEAD).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0) { Block 'PRODUCTION_HEAD_UNVERIFIABLE'; throw 'BLOCKED' }
  $branch = (& git -C $ProductionRoot branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0) { Block 'PRODUCTION_BRANCH_UNVERIFIABLE'; throw 'BLOCKED' }
  $dirty = @(& git -C $ProductionRoot status --porcelain --untracked-files=no)
  if ($LASTEXITCODE -ne 0) { Block 'PRODUCTION_TRACKED_STATUS_UNVERIFIABLE'; throw 'BLOCKED' }
  $evidence.productionCommitExact = $head -eq $ExpectedSource
  $evidence.productionBranchMain = $branch -eq 'main'
  $evidence.trackedWorktreeClean = $dirty.Count -eq 0
  if (-not $evidence.productionCommitExact) { Block 'PRODUCTION_COMMIT_MISMATCH' }
  if (-not $evidence.productionBranchMain) { Block 'PRODUCTION_BRANCH_NOT_MAIN' }
  if (-not $evidence.trackedWorktreeClean) { Block 'PRODUCTION_TRACKED_WORKTREE_DIRTY' }

  try {
    $webTask = Get-ScheduledTask -TaskName 'XAUUSD-Phase7B-Web' -ErrorAction Stop
    $execTask = Get-ScheduledTask -TaskName 'XAUUSD-Phase7C-Executors' -ErrorAction Stop
    $evidence.webTaskRunning = [string]$webTask.State -eq 'Running'
    $evidence.executorTaskRunning = [string]$execTask.State -eq 'Running'
    if (-not $evidence.webTaskRunning) { Block 'WEB_TASK_NOT_RUNNING' }
    if (-not $evidence.executorTaskRunning) { Block 'EXECUTOR_TASK_NOT_RUNNING' }
    $actions = @($webTask.Actions)
    if ($actions.Count -ne 1) { Block 'WEB_TASK_ACTION_COUNT_INVALID' }
    else {
      $args = [string]$actions[0].Arguments
      $exe = ([string]$actions[0].Execute).Trim('"')
      if ($exe -ieq 'powershell.exe') { $exe = [string](Get-Command powershell.exe -ErrorAction Stop).Source }
      $trustedExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $launcher = Join-Path $ProductionRoot 'scripts\run-phase7b-web-autostart.ps1'
      $filePattern = '(?i)(?:^|\s)-File\s+["'']?' + [regex]::Escape($launcher) + '["'']?(?=\s|$)'
      $evidence.webTaskTrustedAction = (
        $exe -ieq $trustedExe -and
        $args -match $filePattern -and
        $args -notmatch '(?i)(?:-EncodedCommand|-Command\s|invoke-expression|iex\s)' -and
        $args.IndexOf('-WorkDir', [StringComparison]::OrdinalIgnoreCase) -ge 0
      )
      if (-not $evidence.webTaskTrustedAction) { Block 'WEB_TASK_ACTION_NOT_CANONICAL' }
      if (Test-Path -LiteralPath $launcher -PathType Leaf) {
        $expectedBlob = (& git -C $ProductionRoot rev-parse "$($ExpectedSource):scripts/run-phase7b-web-autostart.ps1").Trim().ToLowerInvariant()
        $expectedExit = $LASTEXITCODE
        $actualBlob = (& git hash-object -- $launcher).Trim().ToLowerInvariant()
        $evidence.webLauncherBlobExact = ($expectedExit -eq 0 -and $LASTEXITCODE -eq 0 -and $expectedBlob -match '^[a-f0-9]{40}$' -and $actualBlob -eq $expectedBlob)
      }
      if (-not $evidence.webLauncherBlobExact) { Block 'WEB_TASK_LAUNCHER_BLOB_NOT_EXACT' }
    }
  } catch { Block 'WINDOWS_TASK_OBSERVATION_FAILED' }

  try {
    $cfg = Get-Content -LiteralPath (Join-Path $ProductionRoot '.runtime\phase7c-executor-task-config.json') -Raw | ConvertFrom-Json
    if ([string]$cfg.accountMode -ne 'LIVE' -or ([string]$cfg.controlApiUrl).TrimEnd('/') -ne 'http://127.0.0.1:3711') {
      Block 'CANONICAL_LIVE_TASK_CONFIG_INVALID'
      throw 'BLOCKED'
    }
    $envFile = [string]$cfg.envFile
    if (-not [IO.Path]::IsPathRooted($envFile)) { $envFile = Join-Path $ProductionRoot $envFile }
    . (Join-Path $ProductionRoot 'scripts\lib\phase7c-account-mode.ps1')
    $info = Assert-Phase7CAccountEnv -EnvFile $envFile -AccountMode 'LIVE' -RequireTrading
    if ([string]$info.bridgeHost -notin @('127.0.0.1','localhost','::1')) { Block 'BRIDGE_HOST_NOT_LOOPBACK'; throw 'BLOCKED' }
    $bridgeBase = 'http://' + [string]$info.bridgeHost + ':' + [string]$info.bridgePort
    $headers = @{ 'x-mt5-api-key' = [string]$info.apiKey }

    $allSamplesPass = $true
    for ($i = 1; $i -le $Samples; $i++) {
      $mode = Read-Api '/api/v1/phase7c/bot-mode'
      $life = Read-Api '/api/v1/phase7c/lifecycle'
      $arm = Read-Api '/api/v1/phase7c-live-arm-control/capability'
      $att = Read-Api '/api/v1/phase7c/runtime-source-attestation'
      $web = Invoke-WebRequest -Uri 'http://127.0.0.1:5717/phase7b-demo' -Method Get -UseBasicParsing -TimeoutSec 6
      $health = Invoke-RestMethod -Uri "$bridgeBase/health" -Method Get -Headers $headers -TimeoutSec 7
      $posCount = Read-BrokerCount -Uri "$bridgeBase/v1/positions?symbol=XAUUSD" -Headers $headers
      $pendingCount = Read-BrokerCount -Uri "$bridgeBase/v1/orders?symbol=XAUUSD" -Headers $headers
      $evidence.apiReachable = $true
      $evidence.webReachable = [int]$web.StatusCode -eq 200
      $evidence.botModePaused = ([string]$mode.state.mode -eq 'PAUSE' -and [string]$life.mode.mode -eq 'PAUSE')
      $evidence.accountLiveValid = ([string]$life.accountMode.accountMode -eq 'LIVE' -and [bool]$life.accountMode.valid)
      $evidence.lifecycleReady = ([bool]$life.running -and [bool]$life.ready)
      $evidence.armDisarmed = ([string]$arm.accountMode -eq 'LIVE' -and [string]$arm.liveArmStatus -eq 'DISARMED' -and -not [bool]$arm.liveExecutionArmed)
      $components = @($att.components)
      $evidence.sourceAttestation8of8 = (
        [string]$att.overall -eq 'EXACT_MATCH' -and [string]$att.deployment.sourceCommit -eq $ExpectedSource -and
        $components.Count -eq 8 -and @($components | Where-Object { [string]$_.verdict -ne 'EXACT_MATCH' }).Count -eq 0
      )
      $evidence.brokerLiveConnected = ([bool]$health.connected -and [string]$health.status -eq 'ok' -and [string]$health.configuredAccountMode -eq 'LIVE' -and [string]$health.accountMode -eq 'real')
      $evidence.brokerDisarmed = ([string]$health.liveArmStatus -eq 'DISARMED' -and -not [bool]$health.liveExecutionArmed)
      $evidence.xauPositionsAndOrdersFlat = ($posCount -eq 0 -and $pendingCount -eq 0)
      $samplePass = (
        $evidence.webReachable -and $evidence.botModePaused -and $evidence.accountLiveValid -and
        $evidence.lifecycleReady -and $evidence.armDisarmed -and $evidence.sourceAttestation8of8 -and
        $evidence.brokerLiveConnected -and $evidence.brokerDisarmed -and $evidence.xauPositionsAndOrdersFlat
      )
      if (-not $samplePass) { $allSamplesPass = $false }
      if ($i -lt $Samples) { Start-Sleep -Seconds 3 }
    }
    $evidence.runtimeReadyStable = $allSamplesPass
    if (-not $allSamplesPass) { Block 'POST_RECOVERY_RUNTIME_SAMPLE_FAILED' }
  } catch { Block 'POST_RECOVERY_READONLY_API_OR_BRIDGE_FAILED' }

} catch {
  if ($_.Exception.Message -ne 'BLOCKED') { Block 'POST_RECOVERY_INDEPENDENT_ASSESSMENT_INCOMPLETE' }
}
$evidence.pass = (
  $evidence.productionCommitExact -and $evidence.productionBranchMain -and $evidence.trackedWorktreeClean -and
  $evidence.webTaskRunning -and $evidence.executorTaskRunning -and $evidence.webTaskTrustedAction -and
  $evidence.webLauncherBlobExact -and $evidence.apiReachable -and $evidence.webReachable -and
  $evidence.runtimeReadyStable -and $evidence.botModePaused -and $evidence.accountLiveValid -and
  $evidence.lifecycleReady -and $evidence.armDisarmed -and $evidence.sourceAttestation8of8 -and
  $evidence.brokerLiveConnected -and $evidence.brokerDisarmed -and
  $evidence.xauPositionsAndOrdersFlat -and $blockers.Count -eq 0
)
$evidence.blockerCodes = @($blockers.ToArray())
foreach ($key in @('productionCommitExact','webTaskRunning','executorTaskRunning','webTaskTrustedAction','webLauncherBlobExact','apiReachable','webReachable','runtimeReadyStable','botModePaused','accountLiveValid','lifecycleReady','armDisarmed','sourceAttestation8of8','brokerLiveConnected','brokerDisarmed','xauPositionsAndOrdersFlat','pass')) {
  Write-Host "PHASE7C_POST_RECOVERY_$($key.ToUpperInvariant())=$($evidence[$key])"
}
Write-Host "PHASE7C_POST_RECOVERY_BLOCKERS=$(@($blockers.ToArray()) -join ',')"
Write-Host 'PHASE7C_POST_RECOVERY_RESTART_AUTHORIZED=FALSE'
Write-Host 'PHASE7C_POST_RECOVERY_LIVE_TRADING_AUTHORIZED=FALSE'
Write-Host 'PHASE7C_POST_RECOVERY_BROKER_HTTP_METHODS=GET_ONLY'
Write-Host 'PHASE7C_POST_RECOVERY_PROCESS_TASK_MUTATION=NONE'
Write-Host 'PHASE7C_POST_RECOVERY_ARM_BOT_MODE_MUTATION=NONE'
Write-Host 'PHASE7C_POST_RECOVERY_MT5_ORDER_MUTATION=NONE'
if (-not [string]::IsNullOrWhiteSpace($ReceiptPath)) {
  [IO.File]::WriteAllText($ReceiptPath, ($evidence | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
}
Write-Host 'PHASE7C_POST_RECOVERY_READONLY_ASSESSMENT=COMPLETE'
