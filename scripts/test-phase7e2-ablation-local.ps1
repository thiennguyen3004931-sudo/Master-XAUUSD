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

if ($r.source -ne "PHASE7E_M15_SUPERTREND_M5_REALIGNMENT_RESEARCH") { throw "Unexpected Phase 7E source." }
if ($r.safety.researchOnly -ne $true) { throw "Phase 7E.2 must remain research-only." }
if ($r.safety.executionMutation -ne $false -or $r.safety.phase7bStrategyMutation -ne $false) { throw "Phase 7E.2 unexpectedly allows execution mutation." }
if ($r.decision.executionEligible -ne $false) { throw "Parent Phase 7E execution must remain disabled." }
if (-not $r.flip2Ablation) { throw "Phase 7E.2 ablation payload is missing. Run apply-phase7e2-ablation-local.ps1 and restart API." }
if ($r.flip2Ablation.sourceVariant -ne "M5_FLIP_2") { throw "Phase 7E.2 must use M5_FLIP_2 as source lane." }
if ($r.flip2Ablation.contentionMode -ne "FILTER_SIGNALS_BEFORE_SIMULATION_AND_RESCHEDULE_PER_CELL") { throw "Phase 7E.2 contention mode is not canonical." }
if ($r.flip2Ablation.decision.executionEligible -ne $false) { throw "Phase 7E.2 execution must remain disabled." }
if ($r.flip2Ablation.cells.Count -ne 4) { throw "Expected four Direction x Pattern ablation cells." }

$expected = @("BUY_ENGULFING", "BUY_TWO_CANDLE", "SELL_ENGULFING", "SELL_TWO_CANDLE")
foreach ($name in $expected) {
  if (-not ($r.flip2Ablation.cells | Where-Object { $_.name -eq $name } | Select-Object -First 1)) {
    throw "Missing Phase 7E.2 cell: $name"
  }
}

$flip2 = $r.variants | Where-Object { $_.name -eq "M5_FLIP_2" } | Select-Object -First 1
if (-not $flip2) { throw "M5_FLIP_2 parent lane missing." }
if ($r.flip2Ablation.baseline.acceptedSignals -ne $flip2.acceptedSignals) { throw "Ablation baseline signal count differs from M5_FLIP_2." }
if ($r.flip2Ablation.baseline.metrics.trades -ne $flip2.metrics.trades) { throw "Ablation baseline trade count differs from M5_FLIP_2." }
if ([math]::Abs([double]$r.flip2Ablation.baseline.metrics.netPnl - [double]$flip2.metrics.netPnl) -gt 0.01) { throw "Ablation baseline net differs from M5_FLIP_2." }

Write-Host "PHASE7E2_ABLATION_TEST=PASS"
Write-Host "PHASE7E2_WINDOW=$fromDate..$toDate"
Write-Host "PHASE7E2_SOURCE_VARIANT=$($r.flip2Ablation.sourceVariant)"
Write-Host "PHASE7E2_CONTENTION_MODE=$($r.flip2Ablation.contentionMode)"
Write-Host "PHASE7E2_BASELINE_SIGNALS=$($r.flip2Ablation.baseline.acceptedSignals)"
Write-Host "PHASE7E2_BASELINE_TRADES=$($r.flip2Ablation.baseline.metrics.trades)"
Write-Host "PHASE7E2_BASELINE_NET=$($r.flip2Ablation.baseline.metrics.netPnl)"
Write-Host "PHASE7E2_BASELINE_PF=$($r.flip2Ablation.baseline.metrics.profitFactor)"
Write-Host "PHASE7E2_BASELINE_EXPECTANCY=$($r.flip2Ablation.baseline.metrics.expectancy)"
Write-Host "PHASE7E2_BASELINE_DD=$($r.flip2Ablation.baseline.metrics.maxDrawdownUsd)"

foreach ($cell in $r.flip2Ablation.cells) {
  $prefix = "PHASE7E2_$($cell.name)"
  Write-Host "${prefix}_SIGNALS=$($cell.acceptedSignals)"
  Write-Host "${prefix}_TRADES=$($cell.metrics.trades)"
  Write-Host "${prefix}_NET=$($cell.metrics.netPnl)"
  Write-Host "${prefix}_PF=$($cell.metrics.profitFactor)"
  Write-Host "${prefix}_WIN_RATE=$($cell.metrics.winRatePercent)"
  Write-Host "${prefix}_EXPECTANCY=$($cell.metrics.expectancy)"
  Write-Host "${prefix}_AVG_R=$($cell.metrics.averageR)"
  Write-Host "${prefix}_DD=$($cell.metrics.maxDrawdownUsd)"
  Write-Host "${prefix}_AVG_HOLD_HOURS=$($cell.metrics.averageHoldHours)"
  Write-Host "${prefix}_HIT_PLUS6=$($cell.metrics.hitPlus6)"
  Write-Host "${prefix}_HIT_PLUS8=$($cell.metrics.hitPlus8)"
  Write-Host "${prefix}_HIT_PLUS10=$($cell.metrics.hitPlus10)"
  Write-Host "${prefix}_STOP_BEFORE_PLUS6=$($cell.metrics.stopBeforePlus6)"
  Write-Host "${prefix}_LARGEST_WINNER_SHARE=$($cell.metrics.largestWinnerShareOfGrossProfitPercent)"
}

Write-Host "PHASE7E2_PREFERRED=$($r.flip2Ablation.decision.preferredResearchCell)"
Write-Host "PHASE7E2_ECONOMICS_GATE=$($r.flip2Ablation.decision.economicsGate)"
Write-Host "PHASE7E2_SAMPLE_SUFFICIENT=$($r.flip2Ablation.decision.sampleSufficientForPromotion)"
Write-Host "PHASE7E2_PROMOTION_ELIGIBLE=$($r.flip2Ablation.decision.promotionEligible)"
Write-Host "PHASE7E2_EXECUTION_ELIGIBLE=$($r.flip2Ablation.decision.executionEligible)"
Write-Host "PHASE7E2_MFE_MAE_STATUS=$($r.flip2Ablation.diagnostics.mfeMaeStatus)"
