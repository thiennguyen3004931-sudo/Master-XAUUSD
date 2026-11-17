param(
  [int]$ApiPort = 3711,
  [string]$From = "",
  [string]$To = "",
  [int]$AtrPeriod = 10,
  [double]$Multiplier = 3.0
)

$ErrorActionPreference = "Stop"
$toDate = if ($To) { $To } else { (Get-Date).AddDays(-1).ToString("yyyy-MM-dd") }
$fromDate = if ($From) { $From } else { (Get-Date).AddDays(-90).ToString("yyyy-MM-dd") }

$body = @{
  from = $fromDate
  to = $toDate
  fixedVolume = 0.03
  atrPeriod = $AtrPeriod
  multiplier = $Multiplier
} | ConvertTo-Json

$r = Invoke-RestMethod `
  -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7e/supertrend-backtest" `
  -Method Post -ContentType "application/json" -Body $body -TimeoutSec 300

if ($r.source -ne "PHASE7E_PATTERN_DUAL_SUPERTREND_RESEARCH") { throw "Unexpected Phase 7E source." }
if ($r.safety.executionMutation -ne $false -or $r.safety.phase7bStrategyMutation -ne $false) { throw "Phase 7E unexpectedly allows execution mutation." }
if ($r.configuration.maEntryFilter -ne "REMOVED_IN_RESEARCH_LANE") { throw "MA entry filter is not removed in Phase 7E lane." }
if ($r.configuration.m15SupertrendSource -ne "CLOSED_M15_BAR") { throw "M15 Supertrend must use closed bars." }
if ($r.configuration.m5SupertrendSource -ne "LAST_CLOSED_M5_AT_OR_BEFORE_M15_SIGNAL_CLOSE") { throw "M5 Supertrend must use the last closed M5 bar." }
if (-not $r.baseline -or -not $r.supertrend -or -not $r.signalDiagnostics) { throw "Phase 7E comparison payload is incomplete." }
if ($r.decision.executionEligible -ne $false) { throw "Phase 7E execution must remain disabled." }

Write-Host "PHASE7E_SUPERTREND_TEST=PASS"
Write-Host "PHASE7E_SUPERTREND_WINDOW=$fromDate..$toDate"
Write-Host "PHASE7E_SUPERTREND_ATR_PERIOD=$($r.configuration.atrPeriod)"
Write-Host "PHASE7E_SUPERTREND_MULTIPLIER=$($r.configuration.multiplier)"
Write-Host "PHASE7E_SUPERTREND_MA_ENTRY_FILTER=$($r.configuration.maEntryFilter)"
Write-Host "PHASE7E_SUPERTREND_PATTERN_SIGNALS=$($r.signalDiagnostics.patternSignals)"
Write-Host "PHASE7E_SUPERTREND_DUAL_ALIGNED=$($r.signalDiagnostics.dualAligned)"
Write-Host "PHASE7E_SUPERTREND_TIMEFRAME_DISAGREEMENT=$($r.signalDiagnostics.timeframeDisagreement)"
Write-Host "PHASE7E_SUPERTREND_BUY_SIGNALS=$($r.signalDiagnostics.buySignals)"
Write-Host "PHASE7E_SUPERTREND_SELL_SIGNALS=$($r.signalDiagnostics.sellSignals)"
Write-Host "PHASE7E_MA_BASELINE_TRADES=$($r.baseline.metrics.trades)"
Write-Host "PHASE7E_MA_BASELINE_NET=$($r.baseline.metrics.netPnl)"
Write-Host "PHASE7E_MA_BASELINE_PF=$($r.baseline.metrics.profitFactor)"
Write-Host "PHASE7E_MA_BASELINE_DD=$($r.baseline.metrics.maxDrawdownUsd)"
Write-Host "PHASE7E_SUPERTREND_TRADES=$($r.supertrend.metrics.trades)"
Write-Host "PHASE7E_SUPERTREND_NET=$($r.supertrend.metrics.netPnl)"
Write-Host "PHASE7E_SUPERTREND_PF=$($r.supertrend.metrics.profitFactor)"
Write-Host "PHASE7E_SUPERTREND_DD=$($r.supertrend.metrics.maxDrawdownUsd)"
Write-Host "PHASE7E_SUPERTREND_NET_DELTA=$($r.comparison.netPnlDelta)"
Write-Host "PHASE7E_SUPERTREND_PF_DELTA=$($r.comparison.profitFactorDelta)"
Write-Host "PHASE7E_SUPERTREND_DD_DELTA=$($r.comparison.maxDrawdownDelta)"
Write-Host "PHASE7E_SUPERTREND_VERDICT=$($r.decision.verdict)"
Write-Host "PHASE7E_SUPERTREND_EXECUTION_ELIGIBLE=$($r.decision.executionEligible)"
