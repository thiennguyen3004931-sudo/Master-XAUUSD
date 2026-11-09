param(
  [int]$ApiPort = 3711,
  [string]$To = "",
  [int]$AtrPeriod = 10,
  [double]$Multiplier = 3.0
)

$ErrorActionPreference = "Stop"

$toDate = if ($To) {
  [datetime]::ParseExact($To, "yyyy-MM-dd", [System.Globalization.CultureInfo]::InvariantCulture)
} else {
  (Get-Date).Date.AddDays(-1)
}
$fromDate = $toDate.AddDays(-359)
$fromText = $fromDate.ToString("yyyy-MM-dd")
$toText = $toDate.ToString("yyyy-MM-dd")

$body = @{
  from = $fromText
  to = $toText
  fixedVolume = 0.03
  atrPeriod = $AtrPeriod
  multiplier = $Multiplier
} | ConvertTo-Json

$r = Invoke-RestMethod `
  -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7e/realignment-backtest" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body `
  -TimeoutSec 300

if ($r.source -ne "PHASE7E_M15_SUPERTREND_M5_REALIGNMENT_RESEARCH") {
  throw "Unexpected Phase 7E source."
}
if ($r.safety.researchOnly -ne $true -or $r.safety.executionMutation -ne $false -or $r.safety.phase7bStrategyMutation -ne $false) {
  throw "Phase 7F.1 parent safety invariant failed."
}
if (-not $r.flip2Ablation) {
  throw "Phase 7E.2 payload missing. Apply Phase 7E.2 first."
}
if (-not $r.phase7fPathDiagnostics) {
  throw "Phase 7F.1 payload missing. Apply Phase 7F.1 patch and restart API."
}

$p = $r.phase7fPathDiagnostics
$m = $p.metrics
$cell = $r.flip2Ablation.cells | Where-Object { $_.name -eq "BUY_ENGULFING" } | Select-Object -First 1
if (-not $cell) { throw "BUY_ENGULFING Phase 7E.2 cell missing." }

if ($p.source -ne "PHASE7F1_BUY_ENGULFING_PATH_DIAGNOSTICS") { throw "Unexpected Phase 7F.1 source." }
if ($p.sourceVariant -ne "M5_FLIP_2") { throw "Unexpected Phase 7F.1 source variant." }
if ($p.cell -ne "BUY_ENGULFING") { throw "Unexpected Phase 7F.1 cell." }
if ($p.safety.researchOnly -ne $true -or $p.safety.entryMutation -ne $false -or $p.safety.managementMutation -ne $false -or $p.safety.executionMutation -ne $false -or $p.safety.executionEligible -ne $false) {
  throw "Phase 7F.1 safety invariant failed."
}

if ([int]$m.trades -ne [int]$cell.metrics.trades) {
  throw "Phase 7F.1 trade count changed relative to Phase 7E.2 BUY_ENGULFING."
}
if ([math]::Abs([double]$m.netPnl - [double]$cell.metrics.netPnl) -gt 0.01) {
  throw "Phase 7F.1 net PnL changed relative to Phase 7E.2 BUY_ENGULFING."
}
if ([int]$m.hitPlus6 -ne [int]$cell.metrics.hitPlus6) {
  throw "Phase 7F.1 +6 count does not match canonical break-even application count."
}
if ([int]$m.hitPlus10 -ne [int]$cell.metrics.hitPlus10) {
  throw "Phase 7F.1 +10 count does not match canonical partial application count."
}
if ([int]$m.hitPlus8 -gt [int]$m.hitPlus6) { throw "+8 count cannot exceed canonical +6 count under stop-first semantics." }
if ([int]$m.hitPlus10 -gt [int]$m.hitPlus8) { throw "+10 count cannot exceed +8 count." }
if ([int]$m.hitPlus12 -gt [int]$m.hitPlus10) { throw "+12 count cannot exceed +10 count." }
if ([int]$m.hitPlus15 -gt [int]$m.hitPlus12) { throw "+15 count cannot exceed +12 count." }
if ([int]$m.hitPlus20 -gt [int]$m.hitPlus15) { throw "+20 count cannot exceed +15 count." }
if ([double]$m.averageMfePrice -lt 0 -or [double]$m.averageMaePrice -lt 0) { throw "MFE/MAE must be non-negative." }
if ([int]$m.nonPositiveAfterPlus6 -gt [int]$m.hitPlus6) { throw "Non-positive after +6 cannot exceed +6 count." }

$largestCheck = [math]::Round([double]$m.netPnl - [double]$m.largestWinnerPnl, 2)
if ([math]::Abs($largestCheck - [double]$m.exactNetExLargestWinner) -gt 0.01) {
  throw "Exact net ex-largest consistency check failed."
}
$top3Check = [math]::Round([double]$m.netPnl - [double]$m.top3WinnerPnl, 2)
if ([math]::Abs($top3Check - [double]$m.exactNetExTop3Winners) -gt 0.01) {
  throw "Exact net ex-top3 consistency check failed."
}

Write-Host "PHASE7F1_PATH_TEST=PASS"
Write-Host "PHASE7F1_WINDOW=$fromText..$toText"
Write-Host "PHASE7F1_SOURCE_VARIANT=$($p.sourceVariant)"
Write-Host "PHASE7F1_CELL=$($p.cell)"
Write-Host "PHASE7F1_PATH_SEMANTICS=$($p.pathSemantics)"
Write-Host "PHASE7F1_TRADES=$($m.trades)"
Write-Host "PHASE7F1_NET=$($m.netPnl)"
Write-Host "PHASE7F1_PF=$($m.profitFactor)"
Write-Host "PHASE7F1_EXPECTANCY=$($m.expectancy)"
Write-Host "PHASE7F1_AVG_MFE=$($m.averageMfePrice)"
Write-Host "PHASE7F1_MEDIAN_MFE=$($m.medianMfePrice)"
Write-Host "PHASE7F1_P90_MFE=$($m.p90MfePrice)"
Write-Host "PHASE7F1_AVG_MAE=$($m.averageMaePrice)"
Write-Host "PHASE7F1_MEDIAN_MAE=$($m.medianMaePrice)"
Write-Host "PHASE7F1_P90_MAE=$($m.p90MaePrice)"
Write-Host "PHASE7F1_HIT_PLUS6=$($m.hitPlus6)"
Write-Host "PHASE7F1_HIT_PLUS8=$($m.hitPlus8)"
Write-Host "PHASE7F1_HIT_PLUS10=$($m.hitPlus10)"
Write-Host "PHASE7F1_HIT_PLUS12=$($m.hitPlus12)"
Write-Host "PHASE7F1_HIT_PLUS15=$($m.hitPlus15)"
Write-Host "PHASE7F1_HIT_PLUS20=$($m.hitPlus20)"
Write-Host "PHASE7F1_PLUS6_TO_PLUS8=$($m.plus6ToPlus8ConversionPercent)"
Write-Host "PHASE7F1_PLUS8_TO_PLUS10=$($m.plus8ToPlus10ConversionPercent)"
Write-Host "PHASE7F1_PLUS10_TO_PLUS15=$($m.plus10ToPlus15ConversionPercent)"
Write-Host "PHASE7F1_NONPOSITIVE_AFTER_PLUS6=$($m.nonPositiveAfterPlus6)"
Write-Host "PHASE7F1_AVG_CAPTURE_RATIO=$($m.averageCaptureRatioPercent)"
Write-Host "PHASE7F1_AVG_WINNER_CAPTURE_RATIO=$($m.averageWinnerCaptureRatioPercent)"
Write-Host "PHASE7F1_AVG_GIVEBACK=$($m.averageGivebackFromMfePrice)"
Write-Host "PHASE7F1_MEDIAN_GIVEBACK=$($m.medianGivebackFromMfePrice)"
Write-Host "PHASE7F1_LARGEST_WINNER_PNL=$($m.largestWinnerPnl)"
Write-Host "PHASE7F1_LARGEST_WINNER_SHARE=$($m.largestWinnerShareOfGrossProfitPercent)"
Write-Host "PHASE7F1_EXACT_NET_EX_LARGEST=$($m.exactNetExLargestWinner)"
Write-Host "PHASE7F1_TOP3_WINNER_PNL=$($m.top3WinnerPnl)"
Write-Host "PHASE7F1_TOP3_WINNER_SHARE=$($m.top3WinnerShareOfGrossProfitPercent)"
Write-Host "PHASE7F1_EXACT_NET_EX_TOP3=$($m.exactNetExTop3Winners)"
Write-Host "PHASE7F1_ENTRY_MUTATION=False"
Write-Host "PHASE7F1_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7F1_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7F1_NEXT=PHASE7F2_MANAGEMENT_ABLATION_AFTER_PATH_REVIEW"
