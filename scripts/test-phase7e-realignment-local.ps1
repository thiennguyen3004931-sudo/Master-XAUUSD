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
  -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7e/realignment-backtest" `
  -Method Post -ContentType "application/json" -Body $body -TimeoutSec 300

if ($r.source -ne "PHASE7E_M15_SUPERTREND_M5_REALIGNMENT_RESEARCH") { throw "Unexpected Phase 7E.1 source." }
if ($r.safety.executionMutation -ne $false -or $r.safety.phase7bStrategyMutation -ne $false) { throw "Phase 7E.1 unexpectedly allows execution mutation." }
if ($r.configuration.maEntryFilter -ne "REMOVED_IN_RESEARCH_LANES") { throw "MA entry filter is not removed in Phase 7E.1 lanes." }
if ($r.configuration.management -ne "UNCHANGED_CANONICAL_PLUS6_BE_PLUS10_ONE_THIRD_STRUCTURE_FVG_MA20_EXIT") { throw "Phase 7E.1 management is not the unchanged canonical management." }
if ($r.decision.executionEligible -ne $false) { throw "Phase 7E.1 execution must remain disabled." }
if ($r.variants.Count -ne 4) { throw "Expected DUAL_STATE + three fresh-flip variants." }

$state = $r.variants | Where-Object { $_.name -eq "DUAL_STATE" } | Select-Object -First 1
$flip1 = $r.variants | Where-Object { $_.name -eq "M5_FLIP_1" } | Select-Object -First 1
$flip2 = $r.variants | Where-Object { $_.name -eq "M5_FLIP_2" } | Select-Object -First 1
$flip3 = $r.variants | Where-Object { $_.name -eq "M5_FLIP_3" } | Select-Object -First 1
if (-not $state -or -not $flip1 -or -not $flip2 -or -not $flip3) { throw "Phase 7E.1 variants are incomplete." }
if ($flip1.acceptedSignals -gt $flip2.acceptedSignals -or $flip2.acceptedSignals -gt $flip3.acceptedSignals -or $flip3.acceptedSignals -gt $state.acceptedSignals) { throw "Fresh flip signal windows are not monotonic." }

Write-Host "PHASE7E_REALIGNMENT_TEST=PASS"
Write-Host "PHASE7E_REALIGNMENT_WINDOW=$fromDate..$toDate"
Write-Host "PHASE7E_REALIGNMENT_ATR_PERIOD=$($r.configuration.atrPeriod)"
Write-Host "PHASE7E_REALIGNMENT_MULTIPLIER=$($r.configuration.multiplier)"
Write-Host "PHASE7E_REALIGNMENT_MA_ENTRY_FILTER=$($r.configuration.maEntryFilter)"
Write-Host "PHASE7E_REALIGNMENT_PATTERN_SIGNALS=$($r.signalDiagnostics.patternSignals)"
Write-Host "PHASE7E_REALIGNMENT_DUAL_STATE_SIGNALS=$($r.signalDiagnostics.dualSignals)"
Write-Host "PHASE7E_REALIGNMENT_FLIP1_SIGNALS=$($r.signalDiagnostics.flip1Signals)"
Write-Host "PHASE7E_REALIGNMENT_FLIP2_SIGNALS=$($r.signalDiagnostics.flip2Signals)"
Write-Host "PHASE7E_REALIGNMENT_FLIP3_SIGNALS=$($r.signalDiagnostics.flip3Signals)"
Write-Host "PHASE7E_REALIGNMENT_MA_TRADES=$($r.maBaseline.metrics.trades)"
Write-Host "PHASE7E_REALIGNMENT_MA_NET=$($r.maBaseline.metrics.netPnl)"
Write-Host "PHASE7E_REALIGNMENT_MA_PF=$($r.maBaseline.metrics.profitFactor)"
Write-Host "PHASE7E_REALIGNMENT_MA_DD=$($r.maBaseline.metrics.maxDrawdownUsd)"
Write-Host "PHASE7E_REALIGNMENT_STATE_TRADES=$($state.metrics.trades)"
Write-Host "PHASE7E_REALIGNMENT_STATE_NET=$($state.metrics.netPnl)"
Write-Host "PHASE7E_REALIGNMENT_STATE_PF=$($state.metrics.profitFactor)"
Write-Host "PHASE7E_REALIGNMENT_STATE_DD=$($state.metrics.maxDrawdownUsd)"
foreach ($v in @($flip1, $flip2, $flip3)) {
  Write-Host "PHASE7E_REALIGNMENT_$($v.name)_TRADES=$($v.metrics.trades)"
  Write-Host "PHASE7E_REALIGNMENT_$($v.name)_NET=$($v.metrics.netPnl)"
  Write-Host "PHASE7E_REALIGNMENT_$($v.name)_PF=$($v.metrics.profitFactor)"
  Write-Host "PHASE7E_REALIGNMENT_$($v.name)_DD=$($v.metrics.maxDrawdownUsd)"
  Write-Host "PHASE7E_REALIGNMENT_$($v.name)_BUY_NET=$($v.buy.netPnl)"
  Write-Host "PHASE7E_REALIGNMENT_$($v.name)_SELL_NET=$($v.sell.netPnl)"
  Write-Host "PHASE7E_REALIGNMENT_$($v.name)_ENGULF_NET=$($v.engulfing.netPnl)"
  Write-Host "PHASE7E_REALIGNMENT_$($v.name)_TWO_CANDLE_NET=$($v.twoCandle.netPnl)"
}
Write-Host "PHASE7E_REALIGNMENT_VERDICT=$($r.decision.verdict)"
Write-Host "PHASE7E_REALIGNMENT_PREFERRED=$($r.decision.preferredResearchLane)"
Write-Host "PHASE7E_REALIGNMENT_EXECUTION_ELIGIBLE=$($r.decision.executionEligible)"
