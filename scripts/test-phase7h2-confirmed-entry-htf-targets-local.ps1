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

function Invoke-Phase7H2Window {
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
  if (-not $r.phase7h2ConfirmedEntryTargets) {
    throw "Phase 7H.2 payload missing. Apply Phase 7H.2 patch and restart API."
  }

  $p = $r.phase7h2ConfirmedEntryTargets
  if ($p.source -ne "PHASE7H2_DUAL_PATTERN_CONFIRMED_ENTRY_HTF_TARGET_RESEARCH") { throw "Unexpected Phase 7H.2 source." }
  if ($p.sourceVariant -ne "M5_FLIP_2") { throw "Unexpected Phase 7H.2 source variant." }
  if ($p.confirmations.m15SupertrendRequired -ne $true) { throw "M15 Supertrend confirmation must be required." }
  if ($p.confirmations.m5AlignedTrendRequired -ne $true -or [int]$p.confirmations.m5FreshFlipMaxClosedBars -ne 2) { throw "M5 aligned fresh-flip confirmation changed." }
  if ($p.confirmations.m15DirectionalFvgRequired -ne $true) { throw "M15 FVG context must be required." }
  if ($p.confirmations.fvgSignalRetestRequired -ne $false -or $p.confirmations.fvgSignalRetestRole -ne "QUALITY_BONUS_ONLY") { throw "FVG retest must remain bonus-only." }
  if ($p.confirmations.maEntryFilter -ne $false -or $p.confirmations.emaEntryFilter -ne $false) { throw "MA/EMA entry filter is forbidden in Phase 7H.2." }
  if ($p.confirmations.h1EntryFilter -ne $false -or $p.confirmations.h4EntryFilter -ne $false) { throw "H1/H4 must not block entry." }
  if ($p.management.h1Role -ne "TP_REFERENCE_ONLY" -or $p.management.h4Role -ne "RUNNER_TARGET_REFERENCE_ONLY") { throw "Unexpected H1/H4 role." }
  if ($p.management.htfTargetsMutateCanonicalExit -ne $false) { throw "H1/H4 target diagnostics must not mutate canonical exit." }
  if ($p.safety.researchOnly -ne $true -or $p.safety.productionEntryMutation -ne $false -or $p.safety.productionManagementMutation -ne $false -or $p.safety.executionMutation -ne $false -or $p.safety.executionEligible -ne $false) {
    throw "Phase 7H.2 safety invariant failed."
  }

  $patterns = @($p.triggerPatterns)
  if ($patterns.Count -ne 2 -or $patterns -notcontains "ENGULFING" -or $patterns -notcontains "TWO_CANDLE_BODY_DOMINANCE") {
    throw "Both primary trigger patterns must remain active."
  }

  foreach ($side in @("buy", "sell")) {
    $s = $p.$side
    if (-not $s) { throw "Missing Phase 7H.2 $side payload." }
    if ([int]$s.fvgConfirmedSignals -gt [int]$s.preFvgConfirmedSignals) { throw "$side FVG-confirmed signals cannot exceed pre-FVG signals." }
    if ([int]$s.combined.acceptedSignals -ne [int]$s.fvgConfirmedSignals) { throw "$side combined accepted signals must equal FVG-confirmed signals." }
    $patternSignals = [int]$s.patterns.engulfing.acceptedSignals + [int]$s.patterns.twoCandle.acceptedSignals
    if ($patternSignals -ne [int]$s.fvgConfirmedSignals) { throw "$side pattern signal accounting mismatch." }

    foreach ($cell in @($s.combined, $s.patterns.engulfing, $s.patterns.twoCandle, $s.fvgQuality.retest, $s.fvgQuality.contextWithoutSignalRetest)) {
      if ([int]$cell.targets.h1HitBeforeCanonicalExit -gt [int]$cell.targets.h1Available) { throw "$side H1 hit count exceeds target availability." }
      if ([int]$cell.targets.h4HitBeforeCanonicalExit -gt [int]$cell.targets.h4Available) { throw "$side H4 hit count exceeds target availability." }
      foreach ($plan in @($cell.targetPlans)) {
        if ($plan.h1Target -and [double]$plan.h1Target.distance -le 0) { throw "$side invalid H1 target distance." }
        if ($plan.h4Target -and [double]$plan.h4Target.distance -le 0) { throw "$side invalid H4 target distance." }
      }
    }
  }

  [pscustomobject]@{ From = $fromText; To = $toText; Response = $r; Payload = $p }
}

$full = Invoke-Phase7H2Window -FromDate $fromDate -ToDate $toDate

$segments = @()
for ($i = 0; $i -lt 4; $i += 1) {
  $segmentFrom = $fromDate.AddDays($i * 90)
  $segmentTo = $segmentFrom.AddDays(89)
  $segments += Invoke-Phase7H2Window -FromDate $segmentFrom -ToDate $segmentTo
}

$decisions = @{}
foreach ($sideName in @("BUY", "SELL")) {
  $key = $sideName.ToLowerInvariant()
  $side = $full.Payload.$key
  $candidate = $side.combined

  $positiveSegments = @($segments | Where-Object { [double]($_.Payload.$key.combined.metrics.netPnl) -gt 0 }).Count
  $profitablePfSegments = @($segments | Where-Object { (Get-EffectivePf $_.Payload.$key.combined.metrics) -gt 1.0 }).Count
  $segmentsWithAtLeast5Trades = @($segments | Where-Object { [int]($_.Payload.$key.combined.metrics.trades) -ge 5 }).Count

  $gateTrades = [int]$candidate.metrics.trades -ge 30
  $gateNet = [double]$candidate.metrics.netPnl -gt 0
  $gatePf = (Get-EffectivePf $candidate.metrics) -ge 1.20
  $gateExpectancy = [double]$candidate.metrics.expectancy -gt 0
  $gateExLargest = [double]$candidate.metrics.exactNetExLargestWinner -gt 0
  $gateTop3 = [double]$candidate.metrics.top3WinnerShareOfGrossProfitPercent -le 50.0
  $gateTimeStability = $positiveSegments -ge 3 -and $profitablePfSegments -ge 3
  $gateSegmentSample = $segmentsWithAtLeast5Trades -ge 3
  $researchCandidate = $gateTrades -and $gateNet -and $gatePf -and $gateExpectancy -and $gateExLargest -and $gateTop3 -and $gateTimeStability -and $gateSegmentSample

  $decisions[$sideName] = [pscustomobject]@{
    PositiveSegments = $positiveSegments
    ProfitablePfSegments = $profitablePfSegments
    SegmentsWithAtLeast5Trades = $segmentsWithAtLeast5Trades
    GateTrades = $gateTrades
    GateNet = $gateNet
    GatePf = $gatePf
    GateExpectancy = $gateExpectancy
    GateExLargest = $gateExLargest
    GateTop3 = $gateTop3
    GateTimeStability = $gateTimeStability
    GateSegmentSample = $gateSegmentSample
    ResearchCandidate = $researchCandidate
  }
}

Write-Host "PHASE7H2_CONFIRMED_ENTRY_TARGET_TEST=PASS"
Write-Host "PHASE7H2_WINDOW=$($fromDate.ToString('yyyy-MM-dd'))..$($toDate.ToString('yyyy-MM-dd'))"
Write-Host "PHASE7H2_SOURCE_VARIANT=M5_FLIP_2"
Write-Host "PHASE7H2_TRIGGER_PATTERNS=ENGULFING,TWO_CANDLE_BODY_DOMINANCE"
Write-Host "PHASE7H2_ENTRY_RULE=$($full.Payload.entryRule)"
Write-Host "PHASE7H2_M15_SUPERTREND_REQUIRED=True"
Write-Host "PHASE7H2_M5_ALIGNED_TREND_REQUIRED=True"
Write-Host "PHASE7H2_M5_FRESH_FLIP_MAX_CLOSED_BARS=2"
Write-Host "PHASE7H2_M15_FVG_REQUIRED=True"
Write-Host "PHASE7H2_FVG_LOOKBACK=$($full.Payload.confirmations.fvgLookbackBars)"
Write-Host "PHASE7H2_FVG_RETEST_REQUIRED=False"
Write-Host "PHASE7H2_FVG_RETEST_ROLE=QUALITY_BONUS_ONLY"
Write-Host "PHASE7H2_MA_ENTRY_FILTER=False"
Write-Host "PHASE7H2_EMA_ENTRY_FILTER=False"
Write-Host "PHASE7H2_H1_ENTRY_FILTER=False"
Write-Host "PHASE7H2_H4_ENTRY_FILTER=False"
Write-Host "PHASE7H2_H1_ROLE=TP_REFERENCE_ONLY"
Write-Host "PHASE7H2_H4_ROLE=RUNNER_TARGET_REFERENCE_ONLY"
Write-Host "PHASE7H2_HTF_TARGET_SOURCES=CONFIRMED_SWING,OPPOSING_FVG"
Write-Host "PHASE7H2_HTF_TARGETS_MUTATE_CANONICAL_EXIT=False"

foreach ($sideName in @("BUY", "SELL")) {
  $key = $sideName.ToLowerInvariant()
  $s = $full.Payload.$key
  $m = $s.combined.metrics
  $t = $s.combined.targets

  Write-Host "PHASE7H2_${sideName}_PRE_FVG_SIGNALS=$($s.preFvgConfirmedSignals)"
  Write-Host "PHASE7H2_${sideName}_FVG_CONFIRMED_SIGNALS=$($s.fvgConfirmedSignals)"
  Write-Host "PHASE7H2_${sideName}_FVG_RETENTION=$($s.fvgRetentionPercent)"
  Write-Host "PHASE7H2_${sideName}_TRADES=$($m.trades)"
  Write-Host "PHASE7H2_${sideName}_NET=$($m.netPnl)"
  Write-Host "PHASE7H2_${sideName}_PF=$($m.profitFactor)"
  Write-Host "PHASE7H2_${sideName}_EXPECTANCY=$($m.expectancy)"
  Write-Host "PHASE7H2_${sideName}_DD=$($m.maxDrawdownUsd)"
  Write-Host "PHASE7H2_${sideName}_EXACT_NET_EX_LARGEST=$($m.exactNetExLargestWinner)"
  Write-Host "PHASE7H2_${sideName}_TOP3_SHARE=$($m.top3WinnerShareOfGrossProfitPercent)"
  Write-Host "PHASE7H2_${sideName}_EXACT_NET_EX_TOP3=$($m.exactNetExTop3Winners)"
  Write-Host "PHASE7H2_${sideName}_HIT_PLUS6=$($m.hitPlus6)"
  Write-Host "PHASE7H2_${sideName}_HIT_PLUS10=$($m.hitPlus10)"
  Write-Host "PHASE7H2_${sideName}_WINNER_CAPTURE=$($m.averageWinnerCaptureRatioPercent)"
  Write-Host "PHASE7H2_${sideName}_AVG_GIVEBACK=$($m.averageGivebackFromMfePrice)"

  Write-Host "PHASE7H2_${sideName}_ENGULFING_SIGNALS=$($s.patterns.engulfing.acceptedSignals)"
  Write-Host "PHASE7H2_${sideName}_ENGULFING_TRADES=$($s.patterns.engulfing.metrics.trades)"
  Write-Host "PHASE7H2_${sideName}_ENGULFING_NET=$($s.patterns.engulfing.metrics.netPnl)"
  Write-Host "PHASE7H2_${sideName}_ENGULFING_PF=$($s.patterns.engulfing.metrics.profitFactor)"
  Write-Host "PHASE7H2_${sideName}_ENGULFING_EXACT_NET_EX_LARGEST=$($s.patterns.engulfing.metrics.exactNetExLargestWinner)"
  Write-Host "PHASE7H2_${sideName}_TWO_CANDLE_SIGNALS=$($s.patterns.twoCandle.acceptedSignals)"
  Write-Host "PHASE7H2_${sideName}_TWO_CANDLE_TRADES=$($s.patterns.twoCandle.metrics.trades)"
  Write-Host "PHASE7H2_${sideName}_TWO_CANDLE_NET=$($s.patterns.twoCandle.metrics.netPnl)"
  Write-Host "PHASE7H2_${sideName}_TWO_CANDLE_PF=$($s.patterns.twoCandle.metrics.profitFactor)"
  Write-Host "PHASE7H2_${sideName}_TWO_CANDLE_EXACT_NET_EX_LARGEST=$($s.patterns.twoCandle.metrics.exactNetExLargestWinner)"

  Write-Host "PHASE7H2_${sideName}_FVG_RETEST_SIGNALS=$($s.fvgQuality.retest.acceptedSignals)"
  Write-Host "PHASE7H2_${sideName}_FVG_RETEST_NET=$($s.fvgQuality.retest.metrics.netPnl)"
  Write-Host "PHASE7H2_${sideName}_FVG_RETEST_PF=$($s.fvgQuality.retest.metrics.profitFactor)"
  Write-Host "PHASE7H2_${sideName}_FVG_CONTEXT_ONLY_SIGNALS=$($s.fvgQuality.contextWithoutSignalRetest.acceptedSignals)"
  Write-Host "PHASE7H2_${sideName}_FVG_CONTEXT_ONLY_NET=$($s.fvgQuality.contextWithoutSignalRetest.metrics.netPnl)"
  Write-Host "PHASE7H2_${sideName}_FVG_CONTEXT_ONLY_PF=$($s.fvgQuality.contextWithoutSignalRetest.metrics.profitFactor)"

  Write-Host "PHASE7H2_${sideName}_H1_TARGET_AVAILABLE=$($t.h1Available)"
  Write-Host "PHASE7H2_${sideName}_H1_TARGET_COVERAGE=$($t.h1CoveragePercent)"
  Write-Host "PHASE7H2_${sideName}_H1_AVG_DISTANCE=$($t.h1AverageDistance)"
  Write-Host "PHASE7H2_${sideName}_H1_MEDIAN_DISTANCE=$($t.h1MedianDistance)"
  Write-Host "PHASE7H2_${sideName}_H1_HIT_RATE=$($t.h1HitRatePercent)"
  Write-Host "PHASE7H2_${sideName}_H1_SWING_TARGETS=$($t.h1SwingTargets)"
  Write-Host "PHASE7H2_${sideName}_H1_FVG_TARGETS=$($t.h1FvgTargets)"
  Write-Host "PHASE7H2_${sideName}_H4_TARGET_AVAILABLE=$($t.h4Available)"
  Write-Host "PHASE7H2_${sideName}_H4_TARGET_COVERAGE=$($t.h4CoveragePercent)"
  Write-Host "PHASE7H2_${sideName}_H4_AVG_DISTANCE=$($t.h4AverageDistance)"
  Write-Host "PHASE7H2_${sideName}_H4_MEDIAN_DISTANCE=$($t.h4MedianDistance)"
  Write-Host "PHASE7H2_${sideName}_H4_HIT_RATE=$($t.h4HitRatePercent)"
  Write-Host "PHASE7H2_${sideName}_H4_SWING_TARGETS=$($t.h4SwingTargets)"
  Write-Host "PHASE7H2_${sideName}_H4_FVG_TARGETS=$($t.h4FvgTargets)"
}

for ($i = 0; $i -lt $segments.Count; $i += 1) {
  $n = $i + 1
  $segment = $segments[$i]
  Write-Host "PHASE7H2_Q${n}_WINDOW=$($segment.From)..$($segment.To)"
  foreach ($sideName in @("BUY", "SELL")) {
    $key = $sideName.ToLowerInvariant()
    $m = $segment.Payload.$key.combined.metrics
    Write-Host "PHASE7H2_${sideName}_Q${n}_TRADES=$($m.trades)"
    Write-Host "PHASE7H2_${sideName}_Q${n}_NET=$($m.netPnl)"
    Write-Host "PHASE7H2_${sideName}_Q${n}_PF=$($m.profitFactor)"
    Write-Host "PHASE7H2_${sideName}_Q${n}_EXPECTANCY=$($m.expectancy)"
    Write-Host "PHASE7H2_${sideName}_Q${n}_EXACT_NET_EX_LARGEST=$($m.exactNetExLargestWinner)"
  }
}

foreach ($sideName in @("BUY", "SELL")) {
  $d = $decisions[$sideName]
  Write-Host "PHASE7H2_${sideName}_POSITIVE_SEGMENTS=$($d.PositiveSegments)"
  Write-Host "PHASE7H2_${sideName}_PROFITABLE_PF_SEGMENTS=$($d.ProfitablePfSegments)"
  Write-Host "PHASE7H2_${sideName}_SEGMENTS_WITH_5PLUS_TRADES=$($d.SegmentsWithAtLeast5Trades)"
  Write-Host "PHASE7H2_${sideName}_GATE_TRADES=$($d.GateTrades)"
  Write-Host "PHASE7H2_${sideName}_GATE_NET=$($d.GateNet)"
  Write-Host "PHASE7H2_${sideName}_GATE_PF=$($d.GatePf)"
  Write-Host "PHASE7H2_${sideName}_GATE_EXPECTANCY=$($d.GateExpectancy)"
  Write-Host "PHASE7H2_${sideName}_GATE_EX_LARGEST=$($d.GateExLargest)"
  Write-Host "PHASE7H2_${sideName}_GATE_TOP3_CONCENTRATION=$($d.GateTop3)"
  Write-Host "PHASE7H2_${sideName}_GATE_TIME_STABILITY=$($d.GateTimeStability)"
  Write-Host "PHASE7H2_${sideName}_GATE_SEGMENT_SAMPLE=$($d.GateSegmentSample)"
  Write-Host "PHASE7H2_${sideName}_RESEARCH_CANDIDATE=$($d.ResearchCandidate)"
}

$bothCandidate = $decisions["BUY"].ResearchCandidate -and $decisions["SELL"].ResearchCandidate
Write-Host "PHASE7H2_BIDIRECTIONAL_RESEARCH_READY=$bothCandidate"
Write-Host "PHASE7H2_PRODUCTION_ENTRY_MUTATION=False"
Write-Host "PHASE7H2_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7H2_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7H2_NEXT=REVIEW_DUAL_PATTERN_FVG_EDGE_AND_H1_H4_TARGET_COVERAGE_BEFORE_ANY_TARGET_BASED_MANAGEMENT_MUTATION"
