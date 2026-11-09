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

function Invoke-Phase7H1Window {
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
  if (-not $r.flip2Ablation) { throw "Phase 7E.2 payload missing." }
  if (-not $r.phase7f2ManagementAblation) { throw "Phase 7F.2 payload missing." }
  if (-not $r.phase7h1FvgAblation) { throw "Phase 7H.1 payload missing. Apply patch and restart API." }

  $a = $r.phase7h1FvgAblation
  if ($a.source -ne "PHASE7H1_BIDIRECTIONAL_FVG_ENTRY_ABLATION") { throw "Unexpected Phase 7H.1 source." }
  if ($a.sourceVariant -ne "M5_FLIP_2" -or $a.pattern -ne "ENGULFING") { throw "Unexpected Phase 7H.1 source lane." }
  if ($a.management -ne "M0_CANONICAL_FROZEN") { throw "Phase 7H.1 management changed unexpectedly." }
  if ($a.filters.maEntryFilter -ne $false -or $a.filters.emaEntryFilter -ne $false -or $a.filters.fvgEntryResearchLayer -ne $true) {
    throw "Phase 7H.1 entry-filter contract changed unexpectedly."
  }
  if ($a.safety.researchOnly -ne $true -or $a.safety.productionEntryMutation -ne $false -or $a.safety.productionManagementMutation -ne $false -or $a.safety.executionMutation -ne $false -or $a.safety.executionEligible -ne $false) {
    throw "Phase 7H.1 safety invariant failed."
  }

  [pscustomobject]@{ From = $fromText; To = $toText; Response = $r; Ablation = $a }
}

function Get-SidePayload {
  param($Ablation, [string]$Side)
  if ($Side -eq "BUY") { return $Ablation.buy }
  return $Ablation.sell
}

$expectedNames = @(
  "F0_BASELINE",
  "F1_FRESH_DIRECTIONAL_FVG_CONTEXT",
  "F2_FRESH_DIRECTIONAL_FVG_TOUCH"
)

$full = Invoke-Phase7H1Window -FromDate $fromDate -ToDate $toDate

foreach ($side in @("BUY", "SELL")) {
  $payload = Get-SidePayload $full.Ablation $side
  if (-not $payload) { throw "Missing Phase 7H.1 $side payload." }
  foreach ($name in $expectedNames) {
    if (-not ($payload.variants | Where-Object { $_.name -eq $name } | Select-Object -First 1)) {
      throw "Missing Phase 7H.1 $side variant: $name"
    }
  }
}

$buyF0 = $full.Ablation.buy.variants | Where-Object { $_.name -eq "F0_BASELINE" } | Select-Object -First 1
$buyM0 = $full.Response.phase7f2ManagementAblation.variants | Where-Object { $_.name -eq "M0_CANONICAL" } | Select-Object -First 1
if (-not $buyM0) { throw "Phase 7F.2 BUY M0 canonical missing." }
if ([int]$buyF0.metrics.trades -ne [int]$buyM0.metrics.trades) { throw "BUY F0 trade count differs from frozen M0 canonical." }
if ([math]::Abs([double]$buyF0.metrics.netPnl - [double]$buyM0.metrics.netPnl) -gt 0.01) { throw "BUY F0 net differs from frozen M0 canonical." }

$sellF0 = $full.Ablation.sell.variants | Where-Object { $_.name -eq "F0_BASELINE" } | Select-Object -First 1
$sellCell = $full.Response.flip2Ablation.cells | Where-Object { $_.name -eq "SELL_ENGULFING" } | Select-Object -First 1
if (-not $sellCell) { throw "SELL_ENGULFING canonical cell missing." }
if ([int]$sellF0.metrics.trades -ne [int]$sellCell.metrics.trades) { throw "SELL F0 trade count differs from SELL_ENGULFING canonical." }
if ([math]::Abs([double]$sellF0.metrics.netPnl - [double]$sellCell.metrics.netPnl) -gt 0.01) { throw "SELL F0 net differs from SELL_ENGULFING canonical." }

$preferred = @{
  BUY = [string]$full.Ablation.buy.decision.preferredResearchFilter
  SELL = [string]$full.Ablation.sell.decision.preferredResearchFilter
}

$segments = @()
for ($i = 0; $i -lt 4; $i += 1) {
  $segmentFrom = $fromDate.AddDays($i * 90)
  $segmentTo = $segmentFrom.AddDays(89)
  $segment = Invoke-Phase7H1Window -FromDate $segmentFrom -ToDate $segmentTo
  $row = [ordered]@{ From = $segment.From; To = $segment.To }
  foreach ($side in @("BUY", "SELL")) {
    $payload = Get-SidePayload $segment.Ablation $side
    $variant = $payload.variants | Where-Object { $_.name -eq $preferred[$side] } | Select-Object -First 1
    if (-not $variant) { throw "$side preferred FVG filter missing in segment $($i + 1)." }
    $row[$side] = $variant
  }
  $segments += [pscustomobject]$row
}

$decisions = @{}
foreach ($side in @("BUY", "SELL")) {
  $payload = Get-SidePayload $full.Ablation $side
  $baseline = $payload.variants | Where-Object { $_.name -eq "F0_BASELINE" } | Select-Object -First 1
  $candidate = $payload.variants | Where-Object { $_.name -eq $preferred[$side] } | Select-Object -First 1
  if (-not $candidate) { throw "$side preferred full-period FVG filter missing." }

  $positiveSegments = @($segments | Where-Object { [double]($_.$side.metrics.netPnl) -gt 0 }).Count
  $profitablePfSegments = @($segments | Where-Object { (Get-EffectivePf $_.$side.metrics) -gt 1.0 }).Count
  $segmentsWithAtLeast5Trades = @($segments | Where-Object { [int]($_.$side.metrics.trades) -ge 5 }).Count

  $gateTrades = [int]$candidate.metrics.trades -ge 30
  $gateRetention = [double]$candidate.signalRetentionPercent -ge 40.0
  $gateNet = [double]$candidate.metrics.netPnl -gt 0
  $gatePf = (Get-EffectivePf $candidate.metrics) -ge 1.20
  $gateExpectancy = [double]$candidate.metrics.expectancy -gt 0
  $gateDrawdown = [double]$candidate.metrics.maxDrawdownUsd -le ([double]$baseline.metrics.maxDrawdownUsd * 1.10 + 0.01)
  $gateExLargest = [double]$candidate.metrics.exactNetExLargestWinner -gt 0
  $gateTop3Concentration = [double]$candidate.metrics.top3WinnerShareOfGrossProfitPercent -le 50.0
  $gateTimeStability = $positiveSegments -ge 3 -and $profitablePfSegments -ge 3
  $gateSegmentSample = $segmentsWithAtLeast5Trades -ge 3
  $researchCandidate = $gateTrades -and $gateRetention -and $gateNet -and $gatePf -and $gateExpectancy -and $gateDrawdown -and $gateExLargest -and $gateTop3Concentration -and $gateTimeStability -and $gateSegmentSample

  $decisions[$side] = [pscustomobject]@{
    Baseline = $baseline
    Candidate = $candidate
    PositiveSegments = $positiveSegments
    ProfitablePfSegments = $profitablePfSegments
    SegmentsWithAtLeast5Trades = $segmentsWithAtLeast5Trades
    GateTrades = $gateTrades
    GateRetention = $gateRetention
    GateNet = $gateNet
    GatePf = $gatePf
    GateExpectancy = $gateExpectancy
    GateDrawdown = $gateDrawdown
    GateExLargest = $gateExLargest
    GateTop3Concentration = $gateTop3Concentration
    GateTimeStability = $gateTimeStability
    GateSegmentSample = $gateSegmentSample
    ResearchCandidate = $researchCandidate
  }
}

Write-Host "PHASE7H1_FVG_TEST=PASS"
Write-Host "PHASE7H1_WINDOW=$($fromDate.ToString('yyyy-MM-dd'))..$($toDate.ToString('yyyy-MM-dd'))"
Write-Host "PHASE7H1_SOURCE_VARIANT=M5_FLIP_2"
Write-Host "PHASE7H1_PATTERN=ENGULFING"
Write-Host "PHASE7H1_MANAGEMENT=M0_CANONICAL_FROZEN"
Write-Host "PHASE7H1_FVG_TIMEFRAME=$($full.Ablation.fvgTimeframe)"
Write-Host "PHASE7H1_FVG_LOOKBACK=$($full.Ablation.fvgLookbackBars)"
Write-Host "PHASE7H1_MA_ENTRY_FILTER=False"
Write-Host "PHASE7H1_EMA_ENTRY_FILTER=False"
Write-Host "PHASE7H1_CONTENTION=$($full.Ablation.contentionMode)"

foreach ($side in @("BUY", "SELL")) {
  $payload = Get-SidePayload $full.Ablation $side
  Write-Host "PHASE7H1_${side}_PREFERRED=$($preferred[$side])"
  Write-Host "PHASE7H1_${side}_RANKING_RULE=$($payload.decision.rankingRule)"
  foreach ($name in $expectedNames) {
    $v = $payload.variants | Where-Object { $_.name -eq $name } | Select-Object -First 1
    Write-Host "PHASE7H1_${side}_${name}_SIGNALS=$($v.acceptedSignals)"
    Write-Host "PHASE7H1_${side}_${name}_RETENTION=$($v.signalRetentionPercent)"
    Write-Host "PHASE7H1_${side}_${name}_TRADES=$($v.metrics.trades)"
    Write-Host "PHASE7H1_${side}_${name}_NET=$($v.metrics.netPnl)"
    Write-Host "PHASE7H1_${side}_${name}_PF=$($v.metrics.profitFactor)"
    Write-Host "PHASE7H1_${side}_${name}_EXPECTANCY=$($v.metrics.expectancy)"
    Write-Host "PHASE7H1_${side}_${name}_DD=$($v.metrics.maxDrawdownUsd)"
    Write-Host "PHASE7H1_${side}_${name}_EXACT_NET_EX_LARGEST=$($v.metrics.exactNetExLargestWinner)"
    Write-Host "PHASE7H1_${side}_${name}_TOP3_SHARE=$($v.metrics.top3WinnerShareOfGrossProfitPercent)"
    Write-Host "PHASE7H1_${side}_${name}_EXACT_NET_EX_TOP3=$($v.metrics.exactNetExTop3Winners)"
    Write-Host "PHASE7H1_${side}_${name}_HIT_PLUS6=$($v.metrics.hitPlus6)"
    Write-Host "PHASE7H1_${side}_${name}_HIT_PLUS10=$($v.metrics.hitPlus10)"
    Write-Host "PHASE7H1_${side}_${name}_WINNER_CAPTURE=$($v.metrics.averageWinnerCaptureRatioPercent)"
    Write-Host "PHASE7H1_${side}_${name}_AVG_GIVEBACK=$($v.metrics.averageGivebackFromMfePrice)"
  }
}

for ($i = 0; $i -lt $segments.Count; $i += 1) {
  $n = $i + 1
  $segment = $segments[$i]
  Write-Host "PHASE7H1_Q${n}_WINDOW=$($segment.From)..$($segment.To)"
  foreach ($side in @("BUY", "SELL")) {
    $v = $segment.$side
    Write-Host "PHASE7H1_${side}_Q${n}_FILTER=$($preferred[$side])"
    Write-Host "PHASE7H1_${side}_Q${n}_TRADES=$($v.metrics.trades)"
    Write-Host "PHASE7H1_${side}_Q${n}_NET=$($v.metrics.netPnl)"
    Write-Host "PHASE7H1_${side}_Q${n}_PF=$($v.metrics.profitFactor)"
    Write-Host "PHASE7H1_${side}_Q${n}_EXPECTANCY=$($v.metrics.expectancy)"
    Write-Host "PHASE7H1_${side}_Q${n}_DD=$($v.metrics.maxDrawdownUsd)"
    Write-Host "PHASE7H1_${side}_Q${n}_EXACT_NET_EX_LARGEST=$($v.metrics.exactNetExLargestWinner)"
  }
}

foreach ($side in @("BUY", "SELL")) {
  $d = $decisions[$side]
  Write-Host "PHASE7H1_${side}_POSITIVE_SEGMENTS=$($d.PositiveSegments)"
  Write-Host "PHASE7H1_${side}_PROFITABLE_PF_SEGMENTS=$($d.ProfitablePfSegments)"
  Write-Host "PHASE7H1_${side}_SEGMENTS_WITH_5PLUS_TRADES=$($d.SegmentsWithAtLeast5Trades)"
  Write-Host "PHASE7H1_${side}_GATE_TRADES=$($d.GateTrades)"
  Write-Host "PHASE7H1_${side}_GATE_RETENTION=$($d.GateRetention)"
  Write-Host "PHASE7H1_${side}_GATE_NET=$($d.GateNet)"
  Write-Host "PHASE7H1_${side}_GATE_PF=$($d.GatePf)"
  Write-Host "PHASE7H1_${side}_GATE_EXPECTANCY=$($d.GateExpectancy)"
  Write-Host "PHASE7H1_${side}_GATE_DRAWDOWN=$($d.GateDrawdown)"
  Write-Host "PHASE7H1_${side}_GATE_EX_LARGEST=$($d.GateExLargest)"
  Write-Host "PHASE7H1_${side}_GATE_TOP3_CONCENTRATION=$($d.GateTop3Concentration)"
  Write-Host "PHASE7H1_${side}_GATE_TIME_STABILITY=$($d.GateTimeStability)"
  Write-Host "PHASE7H1_${side}_GATE_SEGMENT_SAMPLE=$($d.GateSegmentSample)"
  Write-Host "PHASE7H1_${side}_RESEARCH_CANDIDATE=$($d.ResearchCandidate)"
}

$bidirectionalReady = $decisions.BUY.ResearchCandidate -and $decisions.SELL.ResearchCandidate
Write-Host "PHASE7H1_BIDIRECTIONAL_RESEARCH_READY=$bidirectionalReady"
Write-Host "PHASE7H1_PRODUCTION_ENTRY_MUTATION=False"
Write-Host "PHASE7H1_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7H1_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7H1_NEXT=IF_FVG_NOT_ROBUST_TEST_SUPPLY_DEMAND_AS_SEPARATE_LAYER;DO_NOT_STACK_FVG_WITH_OTHER_FILTERS_YET"
