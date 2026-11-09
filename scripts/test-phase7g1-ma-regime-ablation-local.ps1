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

function Get-EffectivePf {
  param($Metrics)
  if ($Metrics.profitFactor -eq $null) {
    return $(if ([double]$Metrics.netPnl -gt 0) { 999.0 } else { 0.0 })
  }
  return [double]$Metrics.profitFactor
}

function Invoke-Phase7G1Window {
  param([datetime]$FromDate, [datetime]$ToDate)

  $fromText = $FromDate.ToString("yyyy-MM-dd")
  $toText = $ToDate.ToString("yyyy-MM-dd")
  $body = @{
    from = $fromText
    to = $toText
    fixedVolume = 0.03
    atrPeriod = $AtrPeriod
    multiplier = $Multiplier
  } | ConvertTo-Json

  $r = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7e/realignment-backtest" `
    -Method Post -ContentType "application/json" -Body $body -TimeoutSec 300

  if ($r.source -ne "PHASE7E_M15_SUPERTREND_M5_REALIGNMENT_RESEARCH") {
    throw "Unexpected parent source for $fromText..$toText."
  }
  if ($r.safety.researchOnly -ne $true -or $r.safety.executionMutation -ne $false -or $r.safety.phase7bStrategyMutation -ne $false) {
    throw "Parent safety invariant failed for $fromText..$toText."
  }
  if (-not $r.phase7f2ManagementAblation) { throw "Phase 7F.2 payload missing." }
  if (-not $r.phase7g1MaRegimeAblation) { throw "Phase 7G.1 payload missing. Apply patch and restart API." }

  $a = $r.phase7g1MaRegimeAblation
  if ($a.source -ne "PHASE7G1_BUY_ENGULFING_MA_REGIME_ABLATION") { throw "Unexpected Phase 7G.1 source." }
  if ($a.sourceVariant -ne "M5_FLIP_2" -or $a.cell -ne "BUY_ENGULFING") { throw "Unexpected Phase 7G.1 source cell." }
  if ($a.management -ne "M0_CANONICAL_FROZEN") { throw "Phase 7G.1 management must remain canonical." }
  if ($a.safety.researchOnly -ne $true -or $a.safety.productionEntryMutation -ne $false -or $a.safety.productionManagementMutation -ne $false -or $a.safety.executionMutation -ne $false -or $a.safety.executionEligible -ne $false) {
    throw "Phase 7G.1 safety invariant failed."
  }

  [pscustomobject]@{ From = $fromText; To = $toText; Response = $r; Ablation = $a }
}

$full = Invoke-Phase7G1Window -FromDate $fromDate -ToDate $toDate
$expectedNames = @(
  "G0_BASELINE",
  "G1_PRICE_GT_MA20",
  "G2_PRICE_GT_MA20_GT_MA50",
  "G3_PRICE_GT_MA20_GT_MA50_GT_MA200"
)

foreach ($name in $expectedNames) {
  if (-not ($full.Ablation.variants | Where-Object { $_.name -eq $name } | Select-Object -First 1)) {
    throw "Missing Phase 7G.1 variant: $name"
  }
}

$g0 = $full.Ablation.variants | Where-Object { $_.name -eq "G0_BASELINE" } | Select-Object -First 1
$m0 = $full.Response.phase7f2ManagementAblation.variants | Where-Object { $_.name -eq "M0_CANONICAL" } | Select-Object -First 1
if (-not $m0) { throw "Phase 7F.2 M0 canonical variant missing." }
if ([int]$g0.metrics.trades -ne [int]$m0.metrics.trades) { throw "G0 trade count differs from frozen M0 canonical." }
if ([math]::Abs([double]$g0.metrics.netPnl - [double]$m0.metrics.netPnl) -gt 0.01) { throw "G0 net differs from frozen M0 canonical." }

$preferredName = [string]$full.Ablation.decision.preferredResearchFilter
$preferred = $full.Ablation.variants | Where-Object { $_.name -eq $preferredName } | Select-Object -First 1
if (-not $preferred) { throw "Preferred Phase 7G.1 variant missing." }

$segments = @()
for ($i = 0; $i -lt 4; $i += 1) {
  $segmentFrom = $fromDate.AddDays($i * 90)
  $segmentTo = $segmentFrom.AddDays(89)
  $segment = Invoke-Phase7G1Window -FromDate $segmentFrom -ToDate $segmentTo
  $variant = $segment.Ablation.variants | Where-Object { $_.name -eq $preferredName } | Select-Object -First 1
  if (-not $variant) { throw "Preferred variant $preferredName missing in segment $($i + 1)." }
  $segments += [pscustomobject]@{ From = $segment.From; To = $segment.To; Variant = $variant }
}

$positiveSegments = @($segments | Where-Object { [double]$_.Variant.metrics.netPnl -gt 0 }).Count
$profitablePfSegments = @($segments | Where-Object { (Get-EffectivePf $_.Variant.metrics) -gt 1.0 }).Count
$segmentsWithAtLeast5Trades = @($segments | Where-Object { [int]$_.Variant.metrics.trades -ge 5 }).Count

$gateTrades = [int]$preferred.metrics.trades -ge 30
$gateRetention = [double]$preferred.signalRetentionPercent -ge 50.0
$gateNet = [double]$preferred.metrics.netPnl -gt 0
$gatePf = (Get-EffectivePf $preferred.metrics) -ge 1.20
$gateExpectancy = [double]$preferred.metrics.expectancy -gt 0
$gateDrawdown = [double]$preferred.metrics.maxDrawdownUsd -le [double]$g0.metrics.maxDrawdownUsd + 0.01
$gateExLargest = [double]$preferred.metrics.exactNetExLargestWinner -gt 0
$gateTop3Concentration = [double]$preferred.metrics.top3WinnerShareOfGrossProfitPercent -le 50.0
$gateTimeStability = $positiveSegments -ge 3 -and $profitablePfSegments -ge 3
$gateSegmentSample = $segmentsWithAtLeast5Trades -ge 3

$researchCandidate = $gateTrades -and $gateRetention -and $gateNet -and $gatePf -and $gateExpectancy -and $gateDrawdown -and $gateExLargest -and $gateTop3Concentration -and $gateTimeStability -and $gateSegmentSample
$verdict = if ($researchCandidate) {
  "MA_REGIME_FILTER_ROBUSTNESS_CANDIDATE_RESEARCH_ONLY"
} elseif ($gateNet -and $gatePf -and $gateExpectancy) {
  "MA_REGIME_ECONOMICS_POSITIVE_BUT_ROBUSTNESS_NOT_PROVEN"
} else {
  "MA_REGIME_FILTER_DOES_NOT_IMPROVE_ROBUSTNESS"
}

Write-Host "PHASE7G1_MA_REGIME_TEST=PASS"
Write-Host "PHASE7G1_WINDOW=$($fromDate.ToString('yyyy-MM-dd'))..$($toDate.ToString('yyyy-MM-dd'))"
Write-Host "PHASE7G1_SOURCE_VARIANT=M5_FLIP_2"
Write-Host "PHASE7G1_CELL=BUY_ENGULFING"
Write-Host "PHASE7G1_MANAGEMENT=M0_CANONICAL_FROZEN"
Write-Host "PHASE7G1_CONTENTION=FILTER_SIGNALS_BEFORE_SIMULATION_AND_RESCHEDULE_INDEPENDENTLY_PER_MA_REGIME"
Write-Host "PHASE7G1_PREFERRED=$preferredName"
Write-Host "PHASE7G1_RANKING_RULE=$($full.Ablation.decision.rankingRule)"

foreach ($name in $expectedNames) {
  $v = $full.Ablation.variants | Where-Object { $_.name -eq $name } | Select-Object -First 1
  Write-Host "PHASE7G1_${name}_SIGNALS=$($v.acceptedSignals)"
  Write-Host "PHASE7G1_${name}_RETENTION=$($v.signalRetentionPercent)"
  Write-Host "PHASE7G1_${name}_TRADES=$($v.metrics.trades)"
  Write-Host "PHASE7G1_${name}_NET=$($v.metrics.netPnl)"
  Write-Host "PHASE7G1_${name}_PF=$($v.metrics.profitFactor)"
  Write-Host "PHASE7G1_${name}_EXPECTANCY=$($v.metrics.expectancy)"
  Write-Host "PHASE7G1_${name}_DD=$($v.metrics.maxDrawdownUsd)"
  Write-Host "PHASE7G1_${name}_EXACT_NET_EX_LARGEST=$($v.metrics.exactNetExLargestWinner)"
  Write-Host "PHASE7G1_${name}_TOP3_SHARE=$($v.metrics.top3WinnerShareOfGrossProfitPercent)"
  Write-Host "PHASE7G1_${name}_EXACT_NET_EX_TOP3=$($v.metrics.exactNetExTop3Winners)"
}

for ($i = 0; $i -lt $segments.Count; $i += 1) {
  $segment = $segments[$i]
  $v = $segment.Variant
  $n = $i + 1
  Write-Host "PHASE7G1_Q${n}_WINDOW=$($segment.From)..$($segment.To)"
  Write-Host "PHASE7G1_Q${n}_FILTER=$preferredName"
  Write-Host "PHASE7G1_Q${n}_TRADES=$($v.metrics.trades)"
  Write-Host "PHASE7G1_Q${n}_NET=$($v.metrics.netPnl)"
  Write-Host "PHASE7G1_Q${n}_PF=$($v.metrics.profitFactor)"
  Write-Host "PHASE7G1_Q${n}_EXPECTANCY=$($v.metrics.expectancy)"
  Write-Host "PHASE7G1_Q${n}_DD=$($v.metrics.maxDrawdownUsd)"
  Write-Host "PHASE7G1_Q${n}_EXACT_NET_EX_LARGEST=$($v.metrics.exactNetExLargestWinner)"
}

Write-Host "PHASE7G1_POSITIVE_SEGMENTS=$positiveSegments"
Write-Host "PHASE7G1_PROFITABLE_PF_SEGMENTS=$profitablePfSegments"
Write-Host "PHASE7G1_SEGMENTS_WITH_5PLUS_TRADES=$segmentsWithAtLeast5Trades"
Write-Host "PHASE7G1_GATE_TRADES=$gateTrades"
Write-Host "PHASE7G1_GATE_RETENTION=$gateRetention"
Write-Host "PHASE7G1_GATE_NET=$gateNet"
Write-Host "PHASE7G1_GATE_PF=$gatePf"
Write-Host "PHASE7G1_GATE_EXPECTANCY=$gateExpectancy"
Write-Host "PHASE7G1_GATE_DRAWDOWN=$gateDrawdown"
Write-Host "PHASE7G1_GATE_EX_LARGEST=$gateExLargest"
Write-Host "PHASE7G1_GATE_TOP3_CONCENTRATION=$gateTop3Concentration"
Write-Host "PHASE7G1_GATE_TIME_STABILITY=$gateTimeStability"
Write-Host "PHASE7G1_GATE_SEGMENT_SAMPLE=$gateSegmentSample"
Write-Host "PHASE7G1_RESEARCH_CANDIDATE=$researchCandidate"
Write-Host "PHASE7G1_PRODUCTION_ENTRY_MUTATION=False"
Write-Host "PHASE7G1_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7G1_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7G1_VERDICT=$verdict"
Write-Host "PHASE7G1_NEXT=IF_NOT_ROBUST_TEST_FVG_AS_SEPARATE_SINGLE_LAYER;DO_NOT_STACK_FILTERS_BLINDLY"
