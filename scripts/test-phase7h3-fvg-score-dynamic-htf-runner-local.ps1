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

function Invoke-Phase7H3Window {
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
    throw "Phase 7H.2 payload missing. Apply Phase 7H.2 first."
  }
  if (-not $r.phase7h3FvgScoreDynamicTargets) {
    throw "Phase 7H.3 payload missing. Apply Phase 7H.3 patch and restart API."
  }

  $h2 = $r.phase7h2ConfirmedEntryTargets
  $p = $r.phase7h3FvgScoreDynamicTargets

  if ($p.source -ne "PHASE7H3_FVG_QUALITY_SCORE_DYNAMIC_HTF_RUNNER_RESEARCH") { throw "Unexpected Phase 7H.3 source." }
  if ($p.sourceVariant -ne "M5_FLIP_2") { throw "Unexpected Phase 7H.3 source variant." }
  if ($p.confirmations.m15SupertrendRequired -ne $true) { throw "M15 Supertrend confirmation must remain required." }
  if ($p.confirmations.m5AlignedTrendRequired -ne $true -or [int]$p.confirmations.m5FreshFlipMaxClosedBars -ne 2) { throw "M5 fresh aligned flip confirmation changed." }
  if ($p.confirmations.fvgRequiredForEntry -ne $false -or $p.confirmations.fvgQualityScoreEnabled -ne $true) { throw "FVG must be quality-score-only in Phase 7H.3." }
  if ($p.confirmations.maEntryFilter -ne $false -or $p.confirmations.emaEntryFilter -ne $false) { throw "MA/EMA entry filter is forbidden in Phase 7H.3." }
  if ($p.confirmations.h1EntryFilter -ne $false -or $p.confirmations.h4EntryFilter -ne $false) { throw "H1/H4 must not block entry." }
  if ($p.managementResearch.canonicalManagementFrozen -ne $true) { throw "Canonical management must remain frozen." }
  if ($p.managementResearch.dynamicTargetActivation -ne "AFTER_CANONICAL_PLUS10_EVENT_ONLY") { throw "Dynamic target activation changed." }
  if ($p.managementResearch.dynamicTargetsMutateCanonicalExit -ne $false) { throw "Dynamic HTF targets must not mutate canonical exits yet." }
  if ($p.safety.researchOnly -ne $true -or $p.safety.productionEntryMutation -ne $false -or $p.safety.productionManagementMutation -ne $false -or $p.safety.executionMutation -ne $false -or $p.safety.executionEligible -ne $false) {
    throw "Phase 7H.3 safety invariant failed."
  }

  $patterns = @($p.triggerPatterns)
  if ($patterns.Count -ne 2 -or $patterns -notcontains "ENGULFING" -or $patterns -notcontains "TWO_CANDLE_BODY_DOMINANCE") {
    throw "Both requested primary trigger patterns must remain active."
  }

  foreach ($side in @("buy", "sell")) {
    $s = $p.$side
    $h2s = $h2.$side
    if (-not $s) { throw "Missing Phase 7H.3 $side payload." }

    # Removing the H2 FVG hard filter must restore the exact pre-FVG signal set.
    if ([int]$s.entryAcceptedSignals -ne [int]$h2s.preFvgConfirmedSignals) {
      throw "$side entry signal count does not match Phase 7H.2 pre-FVG baseline."
    }
    if ([int]$s.combined.acceptedSignals -ne [int]$s.entryAcceptedSignals) {
      throw "$side combined accepted-signal accounting mismatch."
    }
    $patternSignals = [int]$s.patterns.engulfing.acceptedSignals + [int]$s.patterns.twoCandle.acceptedSignals
    if ($patternSignals -ne [int]$s.entryAcceptedSignals) { throw "$side trigger-pattern accounting mismatch." }

    $q = $s.fvgQualityScore
    $scoreSignals = [int]$q.score0.acceptedSignals + [int]$q.score1.acceptedSignals + [int]$q.score2.acceptedSignals
    if ($scoreSignals -ne [int]$s.entryAcceptedSignals) { throw "$side FVG score distribution does not partition all entry signals." }
    if ([int]$q.score1.acceptedSignals + [int]$q.score2.acceptedSignals -ne [int]$h2s.fvgConfirmedSignals) {
      throw "$side score1+score2 must equal the old H2 hard-FVG set."
    }
    if ([int]$q.score2.acceptedSignals -ne [int]$h2s.fvgQuality.retest.acceptedSignals) {
      throw "$side score2 must equal H2 FVG-retest set."
    }
    if ([int]$q.score1.acceptedSignals -ne [int]$h2s.fvgQuality.contextWithoutSignalRetest.acceptedSignals) {
      throw "$side score1 must equal H2 FVG-context-without-retest set."
    }

    foreach ($cell in @($s.combined, $s.patterns.engulfing, $s.patterns.twoCandle, $q.score0, $q.score1, $q.score2)) {
      $d = $cell.dynamicTargetsAfterPlus10
      if ([int]$d.canonicalPlus10 -ne [int]$cell.metrics.hitPlus10) { throw "$side canonical +10 count mismatch." }
      if ([int]$d.missingPlus10Events -ne 0) { throw "$side reconstructed +10 event missing from canonical +10 trades." }
      if ([int]$d.reconstructedPlus10 -ne [int]$d.canonicalPlus10) { throw "$side reconstructed +10 count mismatch." }
      if ([int]$d.h1AvailableAfterPlus10 -gt [int]$d.reconstructedPlus10) { throw "$side H1 target count exceeds +10 events." }
      if ([int]$d.h4RunnerQualified -gt [int]$d.reconstructedPlus10) { throw "$side H4 runner target count exceeds +10 events." }
      if ([int]$d.h1HitBeforeCanonicalExit -gt [int]$d.h1AvailableAfterPlus10) { throw "$side H1 hit count exceeds target availability." }
      if ([int]$d.h4HitBeforeCanonicalExit -gt [int]$d.h4RunnerQualified) { throw "$side H4 hit count exceeds qualified runner targets." }

      foreach ($plan in @($cell.targetPlans)) {
        if (-not $plan.plus10) { continue }
        if ($plan.h1Target) {
          if ([double]$plan.h1Target.distanceFromEntry -le 10.0 -or [double]$plan.h1Target.distanceFromPlus10 -le 0) {
            throw "$side H1 dynamic target is not beyond +10."
          }
        }
        if ($plan.h4Target) {
          if ([double]$plan.h4Target.distanceFromEntry -le 10.0 -or [double]$plan.h4Target.distanceFromPlus10 -le 0) {
            throw "$side H4 dynamic target is not beyond +10."
          }
        }
        if ($plan.h4RunnerQualified -and $plan.h1Target -and $plan.h4Target) {
          if ([double]$plan.h4Target.distanceFromPlus10 -le [double]$plan.h1Target.distanceFromPlus10) {
            throw "$side qualified H4 runner target is not farther than H1."
          }
        }
      }
    }
  }

  [pscustomobject]@{ From = $fromText; To = $toText; Response = $r; Payload = $p }
}

$full = Invoke-Phase7H3Window -FromDate $fromDate -ToDate $toDate

$segments = @()
for ($i = 0; $i -lt 4; $i += 1) {
  $segmentFrom = $fromDate.AddDays($i * 90)
  $segmentTo = $segmentFrom.AddDays(89)
  $segments += Invoke-Phase7H3Window -FromDate $segmentFrom -ToDate $segmentTo
}

Write-Host "PHASE7H3_FVG_SCORE_DYNAMIC_TARGET_TEST=PASS"
Write-Host "PHASE7H3_WINDOW=$($fromDate.ToString('yyyy-MM-dd'))..$($toDate.ToString('yyyy-MM-dd'))"
Write-Host "PHASE7H3_SOURCE_VARIANT=M5_FLIP_2"
Write-Host "PHASE7H3_TRIGGER_PATTERNS=ENGULFING,TWO_CANDLE_BODY_DOMINANCE"
Write-Host "PHASE7H3_ENTRY_RULE=$($full.Payload.entryRule)"
Write-Host "PHASE7H3_M15_SUPERTREND_REQUIRED=True"
Write-Host "PHASE7H3_M5_ALIGNED_TREND_REQUIRED=True"
Write-Host "PHASE7H3_M5_FRESH_FLIP_MAX_CLOSED_BARS=2"
Write-Host "PHASE7H3_FVG_REQUIRED_FOR_ENTRY=False"
Write-Host "PHASE7H3_FVG_MODE=QUALITY_SCORE_ONLY"
Write-Host "PHASE7H3_FVG_SCORE0=NO_FRESH_DIRECTIONAL_M15_FVG_CONTEXT"
Write-Host "PHASE7H3_FVG_SCORE1=FRESH_DIRECTIONAL_M15_FVG_CONTEXT_WITHOUT_SIGNAL_RETEST"
Write-Host "PHASE7H3_FVG_SCORE2=FRESH_DIRECTIONAL_M15_FVG_CONTEXT_WITH_SIGNAL_RETEST"
Write-Host "PHASE7H3_MA_ENTRY_FILTER=False"
Write-Host "PHASE7H3_EMA_ENTRY_FILTER=False"
Write-Host "PHASE7H3_H1_ENTRY_FILTER=False"
Write-Host "PHASE7H3_H4_ENTRY_FILTER=False"
Write-Host "PHASE7H3_DYNAMIC_TARGET_ACTIVATION=AFTER_CANONICAL_PLUS10_EVENT_ONLY"
Write-Host "PHASE7H3_H1_ROLE=DYNAMIC_POST_PLUS10_TP_REFERENCE"
Write-Host "PHASE7H3_H4_ROLE=DYNAMIC_POST_PLUS10_EXTENDED_RUNNER_REFERENCE"
Write-Host "PHASE7H3_DYNAMIC_TARGETS_MUTATE_CANONICAL_EXIT=False"

foreach ($sideName in @("BUY", "SELL")) {
  $key = $sideName.ToLowerInvariant()
  $s = $full.Payload.$key
  $m = $s.combined.metrics
  $d = $s.combined.dynamicTargetsAfterPlus10

  Write-Host "PHASE7H3_${sideName}_ENTRY_SIGNALS=$($s.entryAcceptedSignals)"
  Write-Host "PHASE7H3_${sideName}_TRADES=$($m.trades)"
  Write-Host "PHASE7H3_${sideName}_NET=$($m.netPnl)"
  Write-Host "PHASE7H3_${sideName}_PF=$($m.profitFactor)"
  Write-Host "PHASE7H3_${sideName}_EXPECTANCY=$($m.expectancy)"
  Write-Host "PHASE7H3_${sideName}_DD=$($m.maxDrawdownUsd)"
  Write-Host "PHASE7H3_${sideName}_EXACT_NET_EX_LARGEST=$($m.exactNetExLargestWinner)"
  Write-Host "PHASE7H3_${sideName}_TOP3_SHARE=$($m.top3WinnerShareOfGrossProfitPercent)"
  Write-Host "PHASE7H3_${sideName}_EXACT_NET_EX_TOP3=$($m.exactNetExTop3Winners)"
  Write-Host "PHASE7H3_${sideName}_HIT_PLUS6=$($m.hitPlus6)"
  Write-Host "PHASE7H3_${sideName}_HIT_PLUS10=$($m.hitPlus10)"
  Write-Host "PHASE7H3_${sideName}_WINNER_CAPTURE=$($m.averageWinnerCaptureRatioPercent)"
  Write-Host "PHASE7H3_${sideName}_AVG_GIVEBACK=$($m.averageGivebackFromMfePrice)"

  Write-Host "PHASE7H3_${sideName}_ENGULFING_SIGNALS=$($s.patterns.engulfing.acceptedSignals)"
  Write-Host "PHASE7H3_${sideName}_ENGULFING_NET=$($s.patterns.engulfing.metrics.netPnl)"
  Write-Host "PHASE7H3_${sideName}_ENGULFING_PF=$($s.patterns.engulfing.metrics.profitFactor)"
  Write-Host "PHASE7H3_${sideName}_ENGULFING_EXACT_NET_EX_LARGEST=$($s.patterns.engulfing.metrics.exactNetExLargestWinner)"
  Write-Host "PHASE7H3_${sideName}_TWO_CANDLE_SIGNALS=$($s.patterns.twoCandle.acceptedSignals)"
  Write-Host "PHASE7H3_${sideName}_TWO_CANDLE_NET=$($s.patterns.twoCandle.metrics.netPnl)"
  Write-Host "PHASE7H3_${sideName}_TWO_CANDLE_PF=$($s.patterns.twoCandle.metrics.profitFactor)"
  Write-Host "PHASE7H3_${sideName}_TWO_CANDLE_EXACT_NET_EX_LARGEST=$($s.patterns.twoCandle.metrics.exactNetExLargestWinner)"

  foreach ($score in @(0, 1, 2)) {
    $cell = $s.fvgQualityScore.("score$score")
    $positiveSegments = @($segments | Where-Object { [double]($_.Payload.$key.fvgQualityScore.("score$score").metrics.netPnl) -gt 0 }).Count
    $pfSegments = @($segments | Where-Object { (Get-EffectivePf $_.Payload.$key.fvgQualityScore.("score$score").metrics) -gt 1.0 }).Count
    $sampleSegments = @($segments | Where-Object { [int]($_.Payload.$key.fvgQualityScore.("score$score").metrics.trades) -ge 3 }).Count

    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_SIGNALS=$($cell.acceptedSignals)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_TRADES=$($cell.metrics.trades)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_NET=$($cell.metrics.netPnl)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_PF=$($cell.metrics.profitFactor)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_EXPECTANCY=$($cell.metrics.expectancy)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_EXACT_NET_EX_LARGEST=$($cell.metrics.exactNetExLargestWinner)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_TOP3_SHARE=$($cell.metrics.top3WinnerShareOfGrossProfitPercent)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_POSITIVE_SEGMENTS=$positiveSegments"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_PF_GT1_SEGMENTS=$pfSegments"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_SEGMENTS_WITH_3PLUS_TRADES=$sampleSegments"
  }

  Write-Host "PHASE7H3_${sideName}_PLUS10_CANONICAL=$($d.canonicalPlus10)"
  Write-Host "PHASE7H3_${sideName}_PLUS10_RECONSTRUCTED=$($d.reconstructedPlus10)"
  Write-Host "PHASE7H3_${sideName}_PLUS10_MISSING=$($d.missingPlus10Events)"
  Write-Host "PHASE7H3_${sideName}_H1_AVAILABLE_AFTER_PLUS10=$($d.h1AvailableAfterPlus10)"
  Write-Host "PHASE7H3_${sideName}_H1_COVERAGE_PLUS10=$($d.h1CoverageOfPlus10Percent)"
  Write-Host "PHASE7H3_${sideName}_H1_AVG_DISTANCE_FROM_ENTRY=$($d.h1AverageDistanceFromEntry)"
  Write-Host "PHASE7H3_${sideName}_H1_MEDIAN_DISTANCE_FROM_ENTRY=$($d.h1MedianDistanceFromEntry)"
  Write-Host "PHASE7H3_${sideName}_H1_AVG_DISTANCE_AFTER_PLUS10=$($d.h1AverageDistanceAfterPlus10)"
  Write-Host "PHASE7H3_${sideName}_H1_MEDIAN_DISTANCE_AFTER_PLUS10=$($d.h1MedianDistanceAfterPlus10)"
  Write-Host "PHASE7H3_${sideName}_H1_HIT_RATE_AFTER_PLUS10=$($d.h1HitRatePercent)"
  Write-Host "PHASE7H3_${sideName}_H1_SWING_TARGETS=$($d.h1SwingTargets)"
  Write-Host "PHASE7H3_${sideName}_H1_FVG_TARGETS=$($d.h1FvgTargets)"
  Write-Host "PHASE7H3_${sideName}_H4_AVAILABLE_AFTER_PLUS10=$($d.h4AvailableAfterPlus10)"
  Write-Host "PHASE7H3_${sideName}_H4_RUNNER_QUALIFIED=$($d.h4RunnerQualified)"
  Write-Host "PHASE7H3_${sideName}_H4_RUNNER_COVERAGE_PLUS10=$($d.h4RunnerCoverageOfPlus10Percent)"
  Write-Host "PHASE7H3_${sideName}_H4_AVG_DISTANCE_FROM_ENTRY=$($d.h4AverageDistanceFromEntry)"
  Write-Host "PHASE7H3_${sideName}_H4_MEDIAN_DISTANCE_FROM_ENTRY=$($d.h4MedianDistanceFromEntry)"
  Write-Host "PHASE7H3_${sideName}_H4_AVG_DISTANCE_AFTER_PLUS10=$($d.h4AverageDistanceAfterPlus10)"
  Write-Host "PHASE7H3_${sideName}_H4_MEDIAN_DISTANCE_AFTER_PLUS10=$($d.h4MedianDistanceAfterPlus10)"
  Write-Host "PHASE7H3_${sideName}_H4_HIT_RATE_AFTER_PLUS10=$($d.h4HitRatePercent)"
  Write-Host "PHASE7H3_${sideName}_H4_SWING_TARGETS=$($d.h4SwingTargets)"
  Write-Host "PHASE7H3_${sideName}_H4_FVG_TARGETS=$($d.h4FvgTargets)"
}

for ($i = 0; $i -lt $segments.Count; $i += 1) {
  $segment = $segments[$i]
  $q = $i + 1
  Write-Host "PHASE7H3_Q${q}_WINDOW=$($segment.From)..$($segment.To)"
  foreach ($sideName in @("BUY", "SELL")) {
    $key = $sideName.ToLowerInvariant()
    $s = $segment.Payload.$key
    Write-Host "PHASE7H3_${sideName}_Q${q}_TRADES=$($s.combined.metrics.trades)"
    Write-Host "PHASE7H3_${sideName}_Q${q}_NET=$($s.combined.metrics.netPnl)"
    Write-Host "PHASE7H3_${sideName}_Q${q}_PF=$($s.combined.metrics.profitFactor)"
    Write-Host "PHASE7H3_${sideName}_Q${q}_SCORE0_TRADES=$($s.fvgQualityScore.score0.metrics.trades)"
    Write-Host "PHASE7H3_${sideName}_Q${q}_SCORE1_TRADES=$($s.fvgQualityScore.score1.metrics.trades)"
    Write-Host "PHASE7H3_${sideName}_Q${q}_SCORE2_TRADES=$($s.fvgQualityScore.score2.metrics.trades)"
  }
}

Write-Host "PHASE7H3_FVG_HARD_FILTER_PROMOTED=False"
Write-Host "PHASE7H3_DYNAMIC_TARGET_MANAGEMENT_PROMOTED=False"
Write-Host "PHASE7H3_PRODUCTION_ENTRY_MUTATION=False"
Write-Host "PHASE7H3_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7H3_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7H3_NEXT=REVIEW_FVG_SCORE_ASSOCIATION_AND_POST_PLUS10_HTF_TARGET_DIAGNOSTICS_BEFORE_COUNTERFACTUAL_MANAGEMENT"