param(
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717,
  [string]$WebTaskName = "XAUUSD-Phase7B-Web"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host "PHASE7C_WEB_REFRESH=START"
Write-Host "PHASE7C_WEB_REFRESH_SCOPE=WEB_API_ONLY"
Write-Host "PHASE7C_WEB_REFRESH_BOT_MUTATION=false"
Write-Host "PHASE7C_WEB_REFRESH_BRIDGE_MUTATION=false"
Write-Host "PHASE7C_WEB_REFRESH_TELEGRAM_MUTATION=false"

Write-Host "PHASE7C_WEB_REFRESH_API_BUILD=START"
pnpm --filter @xauusd/api build
if ($LASTEXITCODE -ne 0) { throw "Phase 7C/7D API build failed." }
Write-Host "PHASE7C_WEB_REFRESH_API_BUILD=PASS"

Write-Host "PHASE7C_WEB_REFRESH_WEB_BUILD=START"
pnpm --filter @xauusd/web build
if ($LASTEXITCODE -ne 0) { throw "Phase 7C/7D Web build failed." }
Write-Host "PHASE7C_WEB_REFRESH_WEB_BUILD=PASS"

$task = Get-ScheduledTask -TaskName $WebTaskName -ErrorAction SilentlyContinue
if (-not $task) { throw "Scheduled Task '$WebTaskName' was not found." }

Stop-ScheduledTask -TaskName $WebTaskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$listenerPids = Get-NetTCPConnection -LocalPort @($ApiPort, $WebPort) -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $listenerPids) {
  if ($processId -gt 0) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
}

Start-ScheduledTask -TaskName $WebTaskName

$apiReady = $false
$webReady = $false
for ($attempt = 1; $attempt -le 40; $attempt++) {
  Start-Sleep -Milliseconds 500
  if (-not $apiReady) {
    try {
      $demo = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -Method Get -TimeoutSec 2
      if ($demo) { $apiReady = $true }
    } catch {}
  }
  if (-not $webReady) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { $webReady = $true }
    } catch {}
  }
  if ($apiReady -and $webReady) { break }
}

if (-not $apiReady -or -not $webReady) {
  throw "Phase 7C/7D web refresh self-test failed. API=$apiReady WEB=$webReady"
}

$risk = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7c/account-risk?riskPercent=0.05&maxLot=0.09" -Method Get -TimeoutSec 5
$preview = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7c/auto-lot-preview?stopDistance=8&riskPercent=0.05&maxLot=0.09" -Method Get -TimeoutSec 5
$demo = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -Method Get -TimeoutSec 5

$toDate = (Get-Date).ToString("yyyy-MM-dd")
$fromDate = (Get-Date).AddDays(-6).ToString("yyyy-MM-dd")
$compareBody = @{
  from = $fromDate
  to = $toDate
  fixedVolume = 0.03
  riskPercent = 0.05
  maxAutoLot = 0.09
} | ConvertTo-Json
$autoCompare = Invoke-RestMethod `
  -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7c/auto-lot-backtest" `
  -Method Post -ContentType "application/json" -Body $compareBody -TimeoutSec 90

if ($autoCompare.source -ne "PHASE7C_AUTO_LOT_SHADOW_COMPARISON") { throw "Phase 7C Auto Lot comparison self-test returned an unexpected source." }
if ($autoCompare.safety.executionMutation -ne $false) { throw "Phase 7C Auto Lot comparison unexpectedly allows execution mutation." }
if (-not $autoCompare.decision -or $autoCompare.decision.executionEligible -ne $false) { throw "Phase 7C Auto Lot research decision safety contract is invalid." }

$dailyBody = @{
  from = $fromDate
  to = $toDate
  fixedVolume = 0.03
  recoveryMinPrice = 6
  recoveryMaxPrice = 10
  profitBufferUsd = 3
  positiveLockFloorUsd = 0
  dayUtcOffsetHours = 7
} | ConvertTo-Json
$dailyResearch = Invoke-RestMethod `
  -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7d/daily-pnl-backtest" `
  -Method Post -ContentType "application/json" -Body $dailyBody -TimeoutSec 180

if ($dailyResearch.source -ne "PHASE7D_DAILY_PNL_RESEARCH") { throw "Phase 7D Daily P/L self-test returned an unexpected source." }
if ($dailyResearch.replayMode -ne "EXACT_PER_LANE_SIGNAL_CONTENTION_WITH_M5_APPROXIMATION") { throw "Phase 7D exact replay mode is not active." }
if ($dailyResearch.safety.executionMutation -ne $false -or $dailyResearch.safety.phase7bStrategyMutation -ne $false) { throw "Phase 7D unexpectedly allows execution/strategy mutation." }
if (-not $dailyResearch.decision -or $dailyResearch.decision.executionEligible -ne $false) { throw "Phase 7D safety contract is invalid." }
if (-not $dailyResearch.trendPlusLock) { throw "Phase 7D Trend+Lock isolation lane is missing." }
if (-not $dailyResearch.decision.lockIsolation) { throw "Phase 7D Lock isolation diagnostics are missing." }
if ($dailyResearch.configuration.recoveryStopPolicy -ne "STRUCTURAL_SL_UNTIL_DYNAMIC_FULL_TP") { throw "Phase 7D Recovery structural-SL policy is not active." }
if ($dailyResearch.recovery.metrics.recoveryBeExits -ne 0 -or $dailyResearch.recoveryPlusLock.metrics.recoveryBeExits -ne 0) { throw "Phase 7D Recovery unexpectedly contains BE exits; Recovery must keep structural SL until dynamic full TP." }

$managementBody = @{
  from = $fromDate
  to = $toDate
  fixedVolume = 0.03
} | ConvertTo-Json
$managementResearch = Invoke-RestMethod `
  -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7d/management-backtest" `
  -Method Post -ContentType "application/json" -Body $managementBody -TimeoutSec 180

if ($managementResearch.source -ne "PHASE7D_BE_PARTIAL_MANAGEMENT_RESEARCH") { throw "Phase 7D management self-test returned an unexpected source." }
if ($managementResearch.replayMode -ne "EXACT_PER_VARIANT_SIGNAL_CONTENTION_WITH_M5_APPROXIMATION") { throw "Phase 7D management exact replay mode is not active." }
if ($managementResearch.safety.executionMutation -ne $false -or $managementResearch.safety.phase7bStrategyMutation -ne $false) { throw "Phase 7D management research unexpectedly allows execution/strategy mutation." }
if (-not $managementResearch.decision -or $managementResearch.decision.executionEligible -ne $false) { throw "Phase 7D management safety contract is invalid." }

$currentManagement = $managementResearch.variants | Where-Object { $_.name -eq "CURRENT_BE6_PARTIAL_THIRD" } | Select-Object -First 1
$be10Third = $managementResearch.variants | Where-Object { $_.name -eq "BE10_PARTIAL_THIRD" } | Select-Object -First 1
$be10Half = $managementResearch.variants | Where-Object { $_.name -eq "BE10_PARTIAL_HALF_THEORETICAL" } | Select-Object -First 1
if (-not $currentManagement -or -not $be10Third -or -not $be10Half) { throw "Phase 7D management variants are incomplete." }

Write-Host "PHASE7C_WEB_REFRESH_API=PASS"
Write-Host "PHASE7C_WEB_REFRESH_WEB=PASS"
Write-Host "PHASE7C_WEB_REFRESH_BOT_STATUS=$($demo.botStatus)"
Write-Host "PHASE7C_WEB_REFRESH_ACCOUNT_LOGIN=$($risk.account.accountLogin)"
Write-Host "PHASE7C_WEB_REFRESH_SERVER=$($risk.account.server)"
Write-Host "PHASE7C_WEB_REFRESH_AUTO_LOT_MODE=$($preview.safety.mode)"
Write-Host "PHASE7C_WEB_REFRESH_AUTO_LOT_EXECUTION_MUTATION=$($preview.safety.executionMutation)"
Write-Host "PHASE7C_WEB_REFRESH_FIXED_VOLUME_UNCHANGED=$($preview.safety.phase7bFixedVolumeUnchanged)"
Write-Host "PHASE7C_WEB_REFRESH_AUTO_LOT_BACKTEST=PASS"
Write-Host "PHASE7C_WEB_REFRESH_AUTO_LOT_ATTEMPTED=$($autoCompare.autoLot.attemptedTrades)"
Write-Host "PHASE7C_WEB_REFRESH_AUTO_LOT_EXECUTED=$($autoCompare.autoLot.executedTrades)"
Write-Host "PHASE7C_WEB_REFRESH_AUTO_LOT_BLOCKED=$($autoCompare.autoLot.blockedTrades)"
Write-Host "PHASE7C_WEB_REFRESH_AUTO_LOT_SCORE=$($autoCompare.decision.score)"
Write-Host "PHASE7C_WEB_REFRESH_AUTO_LOT_VERDICT=$($autoCompare.decision.verdict)"
Write-Host "PHASE7C_WEB_REFRESH_AUTO_LOT_EXECUTION_ELIGIBLE=$($autoCompare.decision.executionEligible)"

Write-Host "PHASE7D_WEB_REFRESH_DAILY_PNL_BACKTEST=PASS"
Write-Host "PHASE7D_WEB_REFRESH_REPLAY_MODE=$($dailyResearch.replayMode)"
Write-Host "PHASE7D_WEB_REFRESH_RECOVERY_STOP_POLICY=$($dailyResearch.configuration.recoveryStopPolicy)"
Write-Host "PHASE7D_WEB_REFRESH_RECOVERY_BE_EXITS=$($dailyResearch.recovery.metrics.recoveryBeExits)"
Write-Host "PHASE7D_WEB_REFRESH_RECOVERY_LOCK_BE_EXITS=$($dailyResearch.recoveryPlusLock.metrics.recoveryBeExits)"
Write-Host "PHASE7D_WEB_REFRESH_SIGNALS=$($dailyResearch.configuration.signals)"
Write-Host "PHASE7D_WEB_REFRESH_FILLED_CANDIDATES=$($dailyResearch.configuration.filledCandidateTrades)"
Write-Host "PHASE7D_WEB_REFRESH_BASELINE_TRADES=$($dailyResearch.baseline.metrics.trades)"
Write-Host "PHASE7D_WEB_REFRESH_RECOVERY_TRADES=$($dailyResearch.recovery.metrics.trades)"
Write-Host "PHASE7D_WEB_REFRESH_TREND_LOCK_TRADES=$($dailyResearch.trendPlusLock.metrics.trades)"
Write-Host "PHASE7D_WEB_REFRESH_RECOVERY_LOCK_TRADES=$($dailyResearch.recoveryPlusLock.metrics.trades)"
Write-Host "PHASE7D_WEB_REFRESH_BASELINE_BUSY_SKIPS=$($dailyResearch.baseline.metrics.skippedPositionBusy)"
Write-Host "PHASE7D_WEB_REFRESH_RECOVERY_BUSY_SKIPS=$($dailyResearch.recovery.metrics.skippedPositionBusy)"
Write-Host "PHASE7D_WEB_REFRESH_TREND_LOCK_BUSY_SKIPS=$($dailyResearch.trendPlusLock.metrics.skippedPositionBusy)"
Write-Host "PHASE7D_WEB_REFRESH_RECOVERY_LOCK_BUSY_SKIPS=$($dailyResearch.recoveryPlusLock.metrics.skippedPositionBusy)"
Write-Host "PHASE7D_WEB_REFRESH_TREND_LOCK_BLOCKED=$($dailyResearch.trendPlusLock.metrics.positiveLockBlockedTrades)"
Write-Host "PHASE7D_WEB_REFRESH_TREND_LOCK_BLOCKED_PNL=$($dailyResearch.trendPlusLock.metrics.blockedCounterfactualNetPnl)"
Write-Host "PHASE7D_WEB_REFRESH_RECOVERY_LOCK_BLOCKED=$($dailyResearch.recoveryPlusLock.metrics.positiveLockBlockedTrades)"
Write-Host "PHASE7D_WEB_REFRESH_RECOVERY_LOCK_BLOCKED_PNL=$($dailyResearch.recoveryPlusLock.metrics.blockedCounterfactualNetPnl)"
Write-Host "PHASE7D_WEB_REFRESH_LOCK_INTERPRETATION=$($dailyResearch.decision.lockIsolation.interpretation)"
Write-Host "PHASE7D_WEB_REFRESH_DAILY_PNL_SCORE=$($dailyResearch.decision.bestResearchScore)"
Write-Host "PHASE7D_WEB_REFRESH_DAILY_PNL_VERDICT=$($dailyResearch.decision.verdict)"
Write-Host "PHASE7D_WEB_REFRESH_DAILY_PNL_RECOMMENDED=$($dailyResearch.decision.recommendedLane)"
Write-Host "PHASE7D_WEB_REFRESH_DAILY_PNL_EXECUTION_ELIGIBLE=$($dailyResearch.decision.executionEligible)"

Write-Host "PHASE7D_WEB_REFRESH_MANAGEMENT_BACKTEST=PASS"
Write-Host "PHASE7D_WEB_REFRESH_MANAGEMENT_REPLAY=$($managementResearch.replayMode)"
Write-Host "PHASE7D_WEB_REFRESH_MANAGEMENT_SIGNALS=$($managementResearch.signals)"
Write-Host "PHASE7D_WEB_REFRESH_CURRENT_BE_BEFORE10=$($currentManagement.metrics.beStopBeforePlus10)"
Write-Host "PHASE7D_WEB_REFRESH_BE10_FULLSTOP_AFTER6=$($be10Third.metrics.plus6ThenFullStopBefore10)"
Write-Host "PHASE7D_WEB_REFRESH_BE10_NET_DELTA=$($managementResearch.decision.deltaBe10ThirdVsCurrent.netPnl)"
Write-Host "PHASE7D_WEB_REFRESH_BE10_DD_DELTA=$($managementResearch.decision.deltaBe10ThirdVsCurrent.maxDrawdownUsd)"
Write-Host "PHASE7D_WEB_REFRESH_BE10_VERDICT=$($managementResearch.decision.verdict)"
Write-Host "PHASE7D_WEB_REFRESH_HALF_EXECUTABLE=$($be10Half.config.executableWithBrokerStep)"
Write-Host "PHASE7D_WEB_REFRESH_MANAGEMENT_EXECUTION_ELIGIBLE=$($managementResearch.decision.executionEligible)"

Write-Host "PHASE7C_WEB_REFRESH_CONTROL_CENTER=http://127.0.0.1:$WebPort/"
Write-Host "PHASE7C_WEB_REFRESH_BACKTEST=http://127.0.0.1:$WebPort/phase7c-backtest"
Write-Host "PHASE7D_WEB_REFRESH_DAILY_PNL=http://127.0.0.1:$WebPort/phase7d-daily-pnl"
Write-Host "PHASE7D_WEB_REFRESH_MANAGEMENT=http://127.0.0.1:$WebPort/phase7d-management"
Write-Host "PHASE7C_WEB_REFRESH_AUTO_LOT_COMPARE=http://127.0.0.1:$WebPort/phase7c-auto-lot"
Write-Host "PHASE7C_WEB_REFRESH_RISK=http://127.0.0.1:$WebPort/phase7c-risk"
Write-Host "PHASE7C_WEB_REFRESH_STATUS=PASS"