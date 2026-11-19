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

function Invoke-Phase7F2Window {
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

  if ($r.source -ne "PHASE7E_M15_SUPERTREND_M5_REALIGNMENT_RESEARCH") { throw "Unexpected parent source for $fromText..$toText." }
  if ($r.safety.researchOnly -ne $true -or $r.safety.executionMutation -ne $false -or $r.safety.phase7bStrategyMutation -ne $false) {
    throw "Parent safety invariant failed for $fromText..$toText."
  }
  if (-not $r.flip2Ablation) { throw "Phase 7E.2 payload missing." }
  if (-not $r.phase7f2ManagementAblation) { throw "Phase 7F.2 payload missing. Apply patch and restart API." }

  $a = $r.phase7f2ManagementAblation
  if ($a.source -ne "PHASE7F2_BUY_ENGULFING_MANAGEMENT_ABLATION") { throw "Unexpected Phase 7F.2 source." }
  if ($a.sourceVariant -ne "M5_FLIP_2" -or $a.cell -ne "BUY_ENGULFING") { throw "Unexpected Phase 7F.2 source cell." }
  if ($a.safety.researchOnly -ne $true -or $a.safety.entryMutation -ne $false -or $a.safety.productionManagementMutation -ne $false -or $a.safety.executionMutation -ne $false -or $a.safety.executionEligible -ne $false) {
    throw "Phase 7F.2 safety invariant failed."
  }

  [pscustomobject]@{ From = $fromText; To = $toText; Response = $r; Ablation = $a }
}

$full = Invoke-Phase7F2Window -FromDate $fromDate -ToDate $toDate
$fullCell = $full.Response.flip2Ablation.cells | Where-Object { $_.name -eq "BUY_ENGULFING" } | Select-Object -First 1
if (-not $fullCell) { throw "BUY_ENGULFING Phase 7E.2 cell missing." }

$expectedNames = @(
  "M0_CANONICAL",
  "M1_BE2_CANONICAL",
  "M2_BE2_PARTIAL_FIXED5",
  "M3_BE2_PARTIAL_ST_EXIT",
  "M4_BE2_NO_PARTIAL_ST_EXIT"
)

foreach ($name in $expectedNames) {
  if (-not ($full.Ablation.variants | Where-Object { $_.name -eq $name } | Select-Object -First 1)) {
    throw "Missing Phase 7F.2 variant: $name"
  }
}

$m0 = $full.Ablation.variants | Where-Object { $_.name -eq "M0_CANONICAL" } | Select-Object -First 1
if ([int]$m0.metrics.trades -ne [int]$fullCell.metrics.trades) { throw "M0 trade count differs from Phase 7E.2 canonical cell." }
if ([math]::Abs([double]$m0.metrics.netPnl - [double]$fullCell.metrics.netPnl) -gt 0.01) { throw "M0 net differs from Phase 7E.2 canonical cell." }

foreach ($variant in $full.Ablation.variants) {
  $m = $variant.metrics
  if ([math]::Abs(([double]$m.netPnl - [double]$m.largestWinnerPnl) - [double]$m.exactNetExLargestWinner) -gt 0.01) {
    throw "Exact ex-largest consistency failed for $($variant.name)."
  }
  if ([math]::Abs(([double]$m.netPnl - [double]$m.top3WinnerPnl) - [double]$m.exactNetExTop3Winners) -gt 0.01) {
    throw "Exact ex-top3 consistency failed for $($variant.name)."
  }
}

$segments = @()
for ($i = 0; $i -lt 4; $i += 1) {
  $segmentFrom = $fromDate.AddDays($i * 90)
  $segmentTo = $segmentFrom.AddDays(89)
  $segments += Invoke-Phase7F2Window -FromDate $segmentFrom -ToDate $segmentTo
}

$preferredName = [string]$full.Ablation.decision.preferredResearchManagement
$preferred = $full.Ablation.variants | Where-Object { $_.name -eq $preferredName } | Select-Object -First 1
if (-not $preferred) { throw "Preferred management variant missing: $preferredName" }

$positiveSegments = 0
$profitablePfSegments = 0
$segmentsWith5PlusTrades = 0
$preferredQuarterRows = @()
for ($i = 0; $i -lt $segments.Count; $i += 1) {
  $segment = $segments[$i]
  $variant = $segment.Ablation.variants | Where-Object { $_.name -eq $preferredName } | Select-Object -First 1
  if (-not $variant) { throw "Preferred variant missing in segment $($i + 1)." }
  $m = $variant.metrics
  if ([double]$m.netPnl -gt 0) { $positiveSegments += 1 }
  if ((Get-EffectivePf $m) -gt 1.0) { $profitablePfSegments += 1 }
  if ([int]$m.trades -ge 5) { $segmentsWith5PlusTrades += 1 }
  $preferredQuarterRows += [pscustomobject]@{ N = $i + 1; Segment = $segment; Variant = $variant }
}

$pm = $preferred.metrics
$m0m = $m0.metrics
$gateTrades = [int]$pm.trades -ge 30
$gateNet = [double]$pm.netPnl -gt 0
$gatePf = (Get-EffectivePf $pm) -ge 1.20
$gateExpectancy = [double]$pm.expectancy -gt 0
$gateDrawdown = [double]$pm.maxDrawdownUsd -le ([double]$m0m.maxDrawdownUsd * 1.25 + 0.01)
$gateExLargest = [double]$pm.exactNetExLargestWinner -gt 0
$gateTop3Concentration = [double]$pm.top3WinnerShareOfGrossProfitPercent -le 70.0
$gateTimeStability = $positiveSegments -ge 3 -and $profitablePfSegments -ge 3
$gateSegmentSample = $segmentsWith5PlusTrades -ge 3
$researchCandidate = $gateTrades -and $gateNet -and $gatePf -and $gateExpectancy -and $gateDrawdown -and $gateExLargest -and $gateTop3Concentration -and $gateTimeStability -and $gateSegmentSample

$verdict = if ($researchCandidate) {
  "MANAGEMENT_ROBUSTNESS_IMPROVED_RESEARCH_ONLY"
} elseif ($gateNet -and $gatePf -and $gateExpectancy) {
  "MANAGEMENT_ECONOMICS_POSITIVE_BUT_ROBUSTNESS_NOT_PROVEN"
} else {
  "MANAGEMENT_EDGE_NOT_PROVEN"
}

Write-Host "PHASE7F2_MANAGEMENT_TEST=PASS"
Write-Host "PHASE7F2_WINDOW=$($fromDate.ToString('yyyy-MM-dd'))..$($toDate.ToString('yyyy-MM-dd'))"
Write-Host "PHASE7F2_SOURCE_VARIANT=M5_FLIP_2"
Write-Host "PHASE7F2_CELL=BUY_ENGULFING"
Write-Host "PHASE7F2_CONTENTION=$($full.Ablation.contentionMode)"
Write-Host "PHASE7F2_PREFERRED=$preferredName"
Write-Host "PHASE7F2_RANKING_RULE=$($full.Ablation.decision.rankingRule)"

foreach ($name in $expectedNames) {
  $v = $full.Ablation.variants | Where-Object { $_.name -eq $name } | Select-Object -First 1
  $m = $v.metrics
  Write-Host "PHASE7F2_${name}_TRADES=$($m.trades)"
  Write-Host "PHASE7F2_${name}_NET=$($m.netPnl)"
  Write-Host "PHASE7F2_${name}_PF=$($m.profitFactor)"
  Write-Host "PHASE7F2_${name}_EXPECTANCY=$($m.expectancy)"
  Write-Host "PHASE7F2_${name}_DD=$($m.maxDrawdownUsd)"
  Write-Host "PHASE7F2_${name}_EXACT_NET_EX_LARGEST=$($m.exactNetExLargestWinner)"
  Write-Host "PHASE7F2_${name}_TOP3_SHARE=$($m.top3WinnerShareOfGrossProfitPercent)"
  Write-Host "PHASE7F2_${name}_EXACT_NET_EX_TOP3=$($m.exactNetExTop3Winners)"
  Write-Host "PHASE7F2_${name}_BE_TRADES=$($m.breakEvenAppliedTrades)"
  Write-Host "PHASE7F2_${name}_PARTIAL_TRADES=$($m.partialAppliedTrades)"
  Write-Host "PHASE7F2_${name}_ST_FLIP_EXITS=$($m.supertrendFlipExits)"
}

foreach ($row in $preferredQuarterRows) {
  $m = $row.Variant.metrics
  $n = $row.N
  Write-Host "PHASE7F2_Q${n}_WINDOW=$($row.Segment.From)..$($row.Segment.To)"
  Write-Host "PHASE7F2_Q${n}_PREFERRED=$preferredName"
  Write-Host "PHASE7F2_Q${n}_TRADES=$($m.trades)"
  Write-Host "PHASE7F2_Q${n}_NET=$($m.netPnl)"
  Write-Host "PHASE7F2_Q${n}_PF=$($m.profitFactor)"
  Write-Host "PHASE7F2_Q${n}_EXPECTANCY=$($m.expectancy)"
  Write-Host "PHASE7F2_Q${n}_DD=$($m.maxDrawdownUsd)"
  Write-Host "PHASE7F2_Q${n}_EXACT_NET_EX_LARGEST=$($m.exactNetExLargestWinner)"
}

Write-Host "PHASE7F2_POSITIVE_SEGMENTS=$positiveSegments"
Write-Host "PHASE7F2_PROFITABLE_PF_SEGMENTS=$profitablePfSegments"
Write-Host "PHASE7F2_SEGMENTS_WITH_5PLUS_TRADES=$segmentsWith5PlusTrades"
Write-Host "PHASE7F2_GATE_TRADES=$gateTrades"
Write-Host "PHASE7F2_GATE_NET=$gateNet"
Write-Host "PHASE7F2_GATE_PF=$gatePf"
Write-Host "PHASE7F2_GATE_EXPECTANCY=$gateExpectancy"
Write-Host "PHASE7F2_GATE_DRAWDOWN=$gateDrawdown"
Write-Host "PHASE7F2_GATE_EX_LARGEST=$gateExLargest"
Write-Host "PHASE7F2_GATE_TOP3_CONCENTRATION=$gateTop3Concentration"
Write-Host "PHASE7F2_GATE_TIME_STABILITY=$gateTimeStability"
Write-Host "PHASE7F2_GATE_SEGMENT_SAMPLE=$gateSegmentSample"
Write-Host "PHASE7F2_RESEARCH_CANDIDATE=$researchCandidate"
Write-Host "PHASE7F2_ENTRY_MUTATION=False"
Write-Host "PHASE7F2_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7F2_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7F2_VERDICT=$verdict"
Write-Host "PHASE7F2_NEXT=REVIEW_BE2_PARTIAL_FIXED5_ST_EXIT_THEN_DECIDE_FILTER_OR_MANAGEMENT_REFINEMENT"
