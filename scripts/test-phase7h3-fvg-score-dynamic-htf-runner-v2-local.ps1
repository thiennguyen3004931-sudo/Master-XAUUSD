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

function Get-ReconstructionCoverage {
  param($Dynamic)
  $canonical = [int]$Dynamic.canonicalPlus10
  $reconstructed = [int]$Dynamic.reconstructedPlus10
  if ($canonical -le 0) { return 100.0 }
  return [math]::Round($reconstructed / $canonical * 100.0, 2)
}

function Test-DynamicCell {
  param($Cell, [string]$Label)

  $d = $Cell.dynamicTargetsAfterPlus10
  if (-not $d) { throw "$Label dynamic target payload missing." }

  $canonical = [int]$d.canonicalPlus10
  $reconstructed = [int]$d.reconstructedPlus10
  $missing = [int]$d.missingPlus10Events

  # Phase 7H.3 deliberately refuses to infer a +10 timestamp from any M5 bar
  # that is not safely observable by the trade's recorded canonical exit time.
  # Missing events are therefore classified, not silently fabricated.
  if ($reconstructed + $missing -ne $canonical) {
    throw "$Label +10 accounting mismatch: reconstructed + temporalMismatch != canonical."
  }
  if ([int]$d.h1AvailableAfterPlus10 -gt $reconstructed) {
    throw "$Label H1 target count exceeds safely reconstructed +10 events."
  }
  if ([int]$d.h4RunnerQualified -gt $reconstructed) {
    throw "$Label H4 runner count exceeds safely reconstructed +10 events."
  }
  if ([int]$d.h1HitBeforeCanonicalExit -gt [int]$d.h1AvailableAfterPlus10) {
    throw "$Label H1 hit count exceeds H1 availability."
  }
  if ([int]$d.h4HitBeforeCanonicalExit -gt [int]$d.h4RunnerQualified) {
    throw "$Label H4 hit count exceeds qualified H4 runners."
  }

  foreach ($plan in @($Cell.targetPlans)) {
    if (-not $plan.plus10) { continue }
    if ($plan.h1Target) {
      if ([double]$plan.h1Target.distanceFromEntry -le 10.0 -or [double]$plan.h1Target.distanceFromPlus10 -le 0) {
        throw "$Label H1 target is not beyond the +10 reference."
      }
    }
    if ($plan.h4Target) {
      if ([double]$plan.h4Target.distanceFromEntry -le 10.0 -or [double]$plan.h4Target.distanceFromPlus10 -le 0) {
        throw "$Label H4 target is not beyond the +10 reference."
      }
    }
    if ($plan.h4RunnerQualified -and $plan.h1Target -and $plan.h4Target) {
      if ([double]$plan.h4Target.distanceFromPlus10 -le [double]$plan.h1Target.distanceFromPlus10) {
        throw "$Label H4 runner target is not farther than H1."
      }
    }
  }
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
  if (-not $r.phase7h2ConfirmedEntryTargets) { throw "Phase 7H.2 payload missing." }
  if (-not $r.phase7h3FvgScoreDynamicTargets) { throw "Phase 7H.3 payload missing. Apply Phase 7H.3 and restart API." }

  $h2 = $r.phase7h2ConfirmedEntryTargets
  $p = $r.phase7h3FvgScoreDynamicTargets

  if ($p.source -ne "PHASE7H3_FVG_QUALITY_SCORE_DYNAMIC_HTF_RUNNER_RESEARCH") { throw "Unexpected Phase 7H.3 source." }
  if ($p.sourceVariant -ne "M5_FLIP_2") { throw "Unexpected Phase 7H.3 source variant." }
  if ($p.confirmations.m15SupertrendRequired -ne $true) { throw "M15 Supertrend confirmation changed." }
  if ($p.confirmations.m5AlignedTrendRequired -ne $true -or [int]$p.confirmations.m5FreshFlipMaxClosedBars -ne 2) { throw "M5 fresh flip confirmation changed." }
  if ($p.confirmations.fvgRequiredForEntry -ne $false -or $p.confirmations.fvgQualityScoreEnabled -ne $true) { throw "FVG must remain quality-score-only." }
  if ($p.confirmations.maEntryFilter -ne $false -or $p.confirmations.emaEntryFilter -ne $false) { throw "MA/EMA entry filtering is forbidden." }
  if ($p.confirmations.h1EntryFilter -ne $false -or $p.confirmations.h4EntryFilter -ne $false) { throw "H1/H4 must not filter entry." }
  if ($p.managementResearch.canonicalManagementFrozen -ne $true) { throw "Canonical management is not frozen." }
  if ($p.managementResearch.dynamicTargetActivation -ne "AFTER_CANONICAL_PLUS10_EVENT_ONLY") { throw "Dynamic target activation changed." }
  if ($p.managementResearch.dynamicTargetsMutateCanonicalExit -ne $false) { throw "Dynamic targets must remain diagnostic-only." }
  if ($p.safety.researchOnly -ne $true -or $p.safety.productionEntryMutation -ne $false -or $p.safety.productionManagementMutation -ne $false -or $p.safety.executionMutation -ne $false -or $p.safety.executionEligible -ne $false) {
    throw "Phase 7H.3 safety invariant failed."
  }

  $patterns = @($p.triggerPatterns)
  if ($patterns.Count -ne 2 -or $patterns -notcontains "ENGULFING" -or $patterns -notcontains "TWO_CANDLE_BODY_DOMINANCE") {
    throw "Both requested trigger patterns must remain active."
  }

  foreach ($side in @("buy", "sell")) {
    $s = $p.$side
    $h2s = $h2.$side
    if (-not $s) { throw "Missing $side payload." }

    if ([int]$s.entryAcceptedSignals -ne [int]$h2s.preFvgConfirmedSignals) {
      throw "$side entry signal count does not restore the Phase 7H.2 pre-FVG set."
    }
    if ([int]$s.combined.acceptedSignals -ne [int]$s.entryAcceptedSignals) {
      throw "$side combined signal accounting mismatch."
    }

    $patternSignals = [int]$s.patterns.engulfing.acceptedSignals + [int]$s.patterns.twoCandle.acceptedSignals
    if ($patternSignals -ne [int]$s.entryAcceptedSignals) { throw "$side trigger-pattern accounting mismatch." }

    $q = $s.fvgQualityScore
    $scoreSignals = [int]$q.score0.acceptedSignals + [int]$q.score1.acceptedSignals + [int]$q.score2.acceptedSignals
    if ($scoreSignals -ne [int]$s.entryAcceptedSignals) { throw "$side FVG scores do not partition all entry signals." }
    if ([int]$q.score1.acceptedSignals + [int]$q.score2.acceptedSignals -ne [int]$h2s.fvgConfirmedSignals) {
      throw "$side score1+score2 does not equal the prior hard-FVG set."
    }
    if ([int]$q.score2.acceptedSignals -ne [int]$h2s.fvgQuality.retest.acceptedSignals) {
      throw "$side score2 does not equal the prior FVG-retest set."
    }

    Test-DynamicCell $s.combined "$side combined"
    Test-DynamicCell $s.patterns.engulfing "$side engulfing"
    Test-DynamicCell $s.patterns.twoCandle "$side twoCandle"
    Test-DynamicCell $q.score0 "$side score0"
    Test-DynamicCell $q.score1 "$side score1"
    Test-DynamicCell $q.score2 "$side score2"
  }

  [pscustomobject]@{ From = $fromText; To = $toText; Payload = $p }
}

$full = Invoke-Phase7H3Window -FromDate $fromDate -ToDate $toDate

$segments = @()
for ($i = 0; $i -lt 4; $i += 1) {
  $segmentFrom = $fromDate.AddDays($i * 90)
  $segmentTo = $segmentFrom.AddDays(89)
  $segments += Invoke-Phase7H3Window -FromDate $segmentFrom -ToDate $segmentTo
}

Write-Host "PHASE7H3_V2_TEMPORAL_SAFE_TEST=PASS"
Write-Host "PHASE7H3_WINDOW=$($fromDate.ToString('yyyy-MM-dd'))..$($toDate.ToString('yyyy-MM-dd'))"
Write-Host "PHASE7H3_SOURCE_VARIANT=M5_FLIP_2"
Write-Host "PHASE7H3_TRIGGER_PATTERNS=ENGULFING,TWO_CANDLE_BODY_DOMINANCE"
Write-Host "PHASE7H3_FVG_REQUIRED_FOR_ENTRY=False"
Write-Host "PHASE7H3_FVG_MODE=QUALITY_SCORE_ONLY"
Write-Host "PHASE7H3_PLUS10_RECONSTRUCTION=CLOSED_M5_ONLY_NO_LOOKAHEAD"
Write-Host "PHASE7H3_TEMPORAL_MISMATCH_POLICY=EXCLUDE_FROM_HTF_TARGET_DENOMINATOR_AND_REPORT"
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
  Write-Host "PHASE7H3_${sideName}_TWO_CANDLE_SIGNALS=$($s.patterns.twoCandle.acceptedSignals)"
  Write-Host "PHASE7H3_${sideName}_TWO_CANDLE_NET=$($s.patterns.twoCandle.metrics.netPnl)"
  Write-Host "PHASE7H3_${sideName}_TWO_CANDLE_PF=$($s.patterns.twoCandle.metrics.profitFactor)"

  foreach ($score in @(0, 1, 2)) {
    $cell = $s.fvgQualityScore.("score$score")
    $cm = $cell.metrics
    $positiveSegments = @($segments | Where-Object { [double]($_.Payload.$key.fvgQualityScore.("score$score").metrics.netPnl) -gt 0 }).Count
    $pfSegments = @($segments | Where-Object { (Get-EffectivePf $_.Payload.$key.fvgQualityScore.("score$score").metrics) -gt 1.0 }).Count
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_SIGNALS=$($cell.acceptedSignals)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_TRADES=$($cm.trades)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_NET=$($cm.netPnl)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_PF=$($cm.profitFactor)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_EXPECTANCY=$($cm.expectancy)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_EXACT_NET_EX_LARGEST=$($cm.exactNetExLargestWinner)"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_POSITIVE_SEGMENTS=$positiveSegments"
    Write-Host "PHASE7H3_${sideName}_FVG_SCORE${score}_PF_GT1_SEGMENTS=$pfSegments"
  }

  Write-Host "PHASE7H3_${sideName}_PLUS10_CANONICAL=$($d.canonicalPlus10)"
  Write-Host "PHASE7H3_${sideName}_PLUS10_RECONSTRUCTED=$($d.reconstructedPlus10)"
  Write-Host "PHASE7H3_${sideName}_PLUS10_TEMPORAL_MISMATCH=$($d.missingPlus10Events)"
  Write-Host "PHASE7H3_${sideName}_PLUS10_SAFE_COVERAGE=$(Get-ReconstructionCoverage $d)"
  Write-Host "PHASE7H3_${sideName}_H1_AVAILABLE_AFTER_PLUS10=$($d.h1AvailableAfterPlus10)"
  Write-Host "PHASE7H3_${sideName}_H1_COVERAGE_SAFE_PLUS10=$($d.h1CoverageOfPlus10Percent)"
  Write-Host "PHASE7H3_${sideName}_H1_MEDIAN_DISTANCE_FROM_ENTRY=$($d.h1MedianDistanceFromEntry)"
  Write-Host "PHASE7H3_${sideName}_H1_MEDIAN_DISTANCE_AFTER_PLUS10=$($d.h1MedianDistanceAfterPlus10)"
  Write-Host "PHASE7H3_${sideName}_H1_HIT_RATE_AFTER_PLUS10=$($d.h1HitRatePercent)"
  Write-Host "PHASE7H3_${sideName}_H4_RUNNER_QUALIFIED=$($d.h4RunnerQualified)"
  Write-Host "PHASE7H3_${sideName}_H4_RUNNER_COVERAGE_SAFE_PLUS10=$($d.h4RunnerCoverageOfPlus10Percent)"
  Write-Host "PHASE7H3_${sideName}_H4_MEDIAN_DISTANCE_FROM_ENTRY=$($d.h4MedianDistanceFromEntry)"
  Write-Host "PHASE7H3_${sideName}_H4_MEDIAN_DISTANCE_AFTER_PLUS10=$($d.h4MedianDistanceAfterPlus10)"
  Write-Host "PHASE7H3_${sideName}_H4_HIT_RATE_AFTER_PLUS10=$($d.h4HitRatePercent)"

  for ($i = 0; $i -lt 4; $i += 1) {
    $seg = $segments[$i]
    $sm = $seg.Payload.$key.combined.metrics
    $sd = $seg.Payload.$key.combined.dynamicTargetsAfterPlus10
    $q = $i + 1
    Write-Host "PHASE7H3_${sideName}_Q${q}_WINDOW=$($seg.From)..$($seg.To)"
    Write-Host "PHASE7H3_${sideName}_Q${q}_TRADES=$($sm.trades)"
    Write-Host "PHASE7H3_${sideName}_Q${q}_NET=$($sm.netPnl)"
    Write-Host "PHASE7H3_${sideName}_Q${q}_PF=$($sm.profitFactor)"
    Write-Host "PHASE7H3_${sideName}_Q${q}_PLUS10_TEMPORAL_MISMATCH=$($sd.missingPlus10Events)"
  }
}

$fullMismatch = [int]$full.Payload.buy.combined.dynamicTargetsAfterPlus10.missingPlus10Events + [int]$full.Payload.sell.combined.dynamicTargetsAfterPlus10.missingPlus10Events
Write-Host "PHASE7H3_FULL_TEMPORAL_MISMATCH_EVENTS=$fullMismatch"
Write-Host "PHASE7H3_HTF_TARGET_DIAGNOSTICS_STATUS=$(if ($fullMismatch -eq 0) { 'EXACT_SAFE_RECONSTRUCTION' } else { 'PARTIAL_SAFE_RECONSTRUCTION_WITH_REPORTED_CANONICAL_TIMESTAMP_MISMATCH' })"
Write-Host "PHASE7H3_PRODUCTION_ENTRY_MUTATION=False"
Write-Host "PHASE7H3_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7H3_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7H3_NEXT=REVIEW_FVG_SCORE_EDGE_AND_DYNAMIC_H1_H4_ONLY_ON_SAFE_RECONSTRUCTED_PLUS10_EVENTS"
