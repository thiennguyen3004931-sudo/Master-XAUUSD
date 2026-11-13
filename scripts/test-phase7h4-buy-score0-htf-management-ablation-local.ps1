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

function Invoke-Phase7H4Window {
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
  if (-not $r.phase7h3FvgScoreDynamicTargets) { throw "Phase 7H.3 payload missing." }
  if (-not $r.phase7h4BuyScore0HtfManagement) {
    throw "Phase 7H.4 payload missing. Apply Phase 7H.4 patch and restart API."
  }

  $h3 = $r.phase7h3FvgScoreDynamicTargets
  $p = $r.phase7h4BuyScore0HtfManagement

  if ($p.source -ne "PHASE7H4_BUY_SCORE0_DYNAMIC_HTF_MANAGEMENT_ABLATION") { throw "Unexpected Phase 7H.4 source." }
  if ($p.sourceVariant -ne "M5_FLIP_2") { throw "Unexpected Phase 7H.4 source variant." }
  if ($p.side -ne "BUY") { throw "Phase 7H.4 management lane must remain BUY-only." }
  if ($p.entryLane -ne "BUY_FVG_SCORE0_ONLY") { throw "Phase 7H.4 entry lane changed." }
  if ($p.managementSemantics.prePlus10 -ne "CANONICAL_FROZEN") { throw "Pre +10 management must remain canonical." }
  if ($p.managementSemantics.plus6 -ne "CANONICAL_BREAK_EVEN") { throw "+6 BE semantics changed." }
  if ($p.managementSemantics.plus10 -ne "CANONICAL_ONE_THIRD_PARTIAL") { throw "+10 partial semantics changed." }
  if ($p.managementSemantics.maEntryFilter -ne $false -or $p.managementSemantics.emaEntryFilter -ne $false) { throw "MA/EMA entry filter is forbidden." }
  if ($p.managementSemantics.h1EntryFilter -ne $false -or $p.managementSemantics.h4EntryFilter -ne $false) { throw "H1/H4 must not block entry." }
  if ($p.managementSemantics.sameBarH1H4Ordering -ne "NO_ASSUMPTION;H4_FINAL_REQUIRES_LATER_M5_BAR_THAN_H1") { throw "No-lookahead H1/H4 sequencing changed." }
  if ($p.sellLane.status -ne "SEPARATE_RESEARCH_ONLY_NOT_MANAGEMENT_CANDIDATE" -or $p.sellLane.executionEligible -ne $false) {
    throw "SELL lane safety status changed."
  }
  if ($p.safety.researchOnly -ne $true -or $p.safety.productionEntryMutation -ne $false -or $p.safety.productionManagementMutation -ne $false -or $p.safety.executionMutation -ne $false -or $p.safety.executionEligible -ne $false) {
    throw "Phase 7H.4 safety invariant failed."
  }

  $variants = @($p.variants)
  $expectedNames = @(
    "H0_CANONICAL_SCORE0",
    "H1_FULL_REMAINDER_AT_H1",
    "H2_HALF_REMAINDER_AT_H1_CANONICAL_FINAL",
    "H3_HALF_REMAINDER_AT_H1_H4_FINAL",
    "H4_FULL_REMAINDER_AT_H4"
  )
  if ($variants.Count -ne $expectedNames.Count) { throw "Unexpected Phase 7H.4 variant count." }
  foreach ($name in $expectedNames) {
    if (-not ($variants | Where-Object { $_.name -eq $name })) { throw "Missing Phase 7H.4 variant $name." }
  }

  $baseline = $variants | Where-Object { $_.name -eq "H0_CANONICAL_SCORE0" } | Select-Object -First 1
  $h3Score0 = $h3.buy.fvgQualityScore.score0
  if ([int]$baseline.acceptedSignals -ne [int]$h3Score0.acceptedSignals) { throw "H0 accepted-signal count does not match H3 BUY score0." }
  if ([int]$baseline.metrics.trades -ne [int]$h3Score0.metrics.trades) { throw "H0 trades do not match H3 BUY score0." }
  if ([math]::Abs([double]$baseline.metrics.netPnl - [double]$h3Score0.metrics.netPnl) -gt 0.01) { throw "H0 Net does not match H3 BUY score0." }
  if ([math]::Abs((Get-EffectivePf $baseline.metrics) - (Get-EffectivePf $h3Score0.metrics)) -gt 0.0001) { throw "H0 PF does not match H3 BUY score0." }
  if ([math]::Abs([double]$baseline.metrics.exactNetExLargestWinner - [double]$h3Score0.metrics.exactNetExLargestWinner) -gt 0.01) { throw "H0 ex-largest does not match H3 BUY score0." }

  foreach ($v in $variants) {
    if ([int]$v.acceptedSignals -ne [int]$baseline.acceptedSignals) { throw "$($v.name) changed the entry signal set." }
    if ([int]$v.metrics.trades -le 0) { throw "$($v.name) produced no trades." }
    if ([int]$v.metrics.h1FullRemainderExits -lt 0 -or [int]$v.metrics.h1HalfPartialTrades -lt 0 -or [int]$v.metrics.h4FullRemainderExits -lt 0 -or [int]$v.metrics.h4FinalExits -lt 0) {
      throw "$($v.name) has invalid overlay counters."
    }
  }

  [pscustomobject]@{ From = $fromText; To = $toText; Response = $r; H3 = $h3; Payload = $p }
}

$full = Invoke-Phase7H4Window -FromDate $fromDate -ToDate $toDate

$segments = @()
for ($i = 0; $i -lt 4; $i += 1) {
  $segmentFrom = $fromDate.AddDays($i * 90)
  $segmentTo = $segmentFrom.AddDays(89)
  $segments += Invoke-Phase7H4Window -FromDate $segmentFrom -ToDate $segmentTo
}

$p = $full.Payload
$preferredName = [string]$p.preferred
$baseline = @($p.variants | Where-Object { $_.name -eq "H0_CANONICAL_SCORE0" })[0]
$preferred = @($p.variants | Where-Object { $_.name -eq $preferredName })[0]
if (-not $preferred) { throw "Preferred Phase 7H.4 variant not found." }

$positiveSegments = 0
$pfGt1Segments = 0
$segmentsWith10Trades = 0
foreach ($segment in $segments) {
  $variant = @($segment.Payload.variants | Where-Object { $_.name -eq $preferredName })[0]
  if (-not $variant) { throw "Preferred variant missing from a quarterly segment." }
  if ([double]$variant.metrics.netPnl -gt 0) { $positiveSegments += 1 }
  if ((Get-EffectivePf $variant.metrics) -gt 1.0) { $pfGt1Segments += 1 }
  if ([int]$variant.metrics.trades -ge 10) { $segmentsWith10Trades += 1 }
}

$gateTrades = [int]$preferred.metrics.trades -ge 50
$gateNet = [double]$preferred.metrics.netPnl -gt 0
$gatePf = (Get-EffectivePf $preferred.metrics) -ge 1.30
$gateExpectancy = [double]$preferred.metrics.expectancy -gt 0
$gateExLargest = [double]$preferred.metrics.exactNetExLargestWinner -gt 0
$gateTop3 = [double]$preferred.metrics.top3WinnerShareOfGrossProfitPercent -le 50
$gateDd = [double]$preferred.metrics.maxDrawdownUsd -le ([double]$baseline.metrics.maxDrawdownUsd * 1.25 + 0.01)
$gateTime = $positiveSegments -ge 3 -and $pfGt1Segments -ge 3
$gateSample = $segmentsWith10Trades -ge 3
$managementImprovesRobustness = [double]$preferred.metrics.exactNetExLargestWinner -gt [double]$baseline.metrics.exactNetExLargestWinner + 0.01
$managementImprovesNet = [double]$preferred.metrics.netPnl -gt [double]$baseline.metrics.netPnl + 0.01
$managementCandidate = $preferredName -ne "H0_CANONICAL_SCORE0" -and $gateTrades -and $gateNet -and $gatePf -and $gateExpectancy -and $gateExLargest -and $gateTop3 -and $gateDd -and $gateTime -and $gateSample -and ($managementImprovesRobustness -or $managementImprovesNet)

Write-Host "PHASE7H4_HTF_MANAGEMENT_TEST=PASS"
Write-Host "PHASE7H4_WINDOW=$($fromDate.ToString('yyyy-MM-dd'))..$($toDate.ToString('yyyy-MM-dd'))"
Write-Host "PHASE7H4_SIDE=BUY"
Write-Host "PHASE7H4_ENTRY_LANE=BUY_FVG_SCORE0_ONLY"
Write-Host "PHASE7H4_FVG_INTERPRETATION=QUALITY_SCORE_OBSERVATION_NOT_CAUSAL_CLAIM"
Write-Host "PHASE7H4_TRIGGER_PATTERNS=ENGULFING,TWO_CANDLE_BODY_DOMINANCE"
Write-Host "PHASE7H4_PRE_PLUS10=CANONICAL_FROZEN"
Write-Host "PHASE7H4_PLUS6=CANONICAL_BREAK_EVEN"
Write-Host "PHASE7H4_PLUS10=CANONICAL_ONE_THIRD_PARTIAL"
Write-Host "PHASE7H4_TARGETS=RECALCULATED_AT_SAFE_PLUS10_EVENT"
Write-Host "PHASE7H4_SAME_BAR_H1_H4_ORDERING=NO_ASSUMPTION"
Write-Host "PHASE7H4_SELL_STATUS=SEPARATE_RESEARCH_ONLY_NOT_MANAGEMENT_CANDIDATE"
Write-Host "PHASE7H4_RANKING_RULE=$($p.rankingRule)"
Write-Host "PHASE7H4_BASELINE=$($p.baseline)"
Write-Host "PHASE7H4_PREFERRED=$preferredName"

foreach ($v in @($p.variants)) {
  $prefix = "PHASE7H4_$($v.name)"
  Write-Host "${prefix}_SIGNALS=$($v.acceptedSignals)"
  Write-Host "${prefix}_TRADES=$($v.metrics.trades)"
  Write-Host "${prefix}_NET=$($v.metrics.netPnl)"
  Write-Host "${prefix}_PF=$($v.metrics.profitFactor)"
  Write-Host "${prefix}_EXPECTANCY=$($v.metrics.expectancy)"
  Write-Host "${prefix}_DD=$($v.metrics.maxDrawdownUsd)"
  Write-Host "${prefix}_EXACT_NET_EX_LARGEST=$($v.metrics.exactNetExLargestWinner)"
  Write-Host "${prefix}_TOP3_SHARE=$($v.metrics.top3WinnerShareOfGrossProfitPercent)"
  Write-Host "${prefix}_EXACT_NET_EX_TOP3=$($v.metrics.exactNetExTop3Winners)"
  Write-Host "${prefix}_H1_FULL_EXITS=$($v.metrics.h1FullRemainderExits)"
  Write-Host "${prefix}_H1_HALF_TRADES=$($v.metrics.h1HalfPartialTrades)"
  Write-Host "${prefix}_H4_FULL_EXITS=$($v.metrics.h4FullRemainderExits)"
  Write-Host "${prefix}_H4_FINAL_EXITS=$($v.metrics.h4FinalExits)"
  Write-Host "${prefix}_TEMPORAL_FALLBACKS=$($v.metrics.temporalFallbacks)"
}

Write-Host "PHASE7H4_PREFERRED_ENGULFING_TRADES=$($preferred.engulfing.trades)"
Write-Host "PHASE7H4_PREFERRED_ENGULFING_NET=$($preferred.engulfing.netPnl)"
Write-Host "PHASE7H4_PREFERRED_ENGULFING_PF=$($preferred.engulfing.profitFactor)"
Write-Host "PHASE7H4_PREFERRED_TWO_CANDLE_TRADES=$($preferred.twoCandle.trades)"
Write-Host "PHASE7H4_PREFERRED_TWO_CANDLE_NET=$($preferred.twoCandle.netPnl)"
Write-Host "PHASE7H4_PREFERRED_TWO_CANDLE_PF=$($preferred.twoCandle.profitFactor)"

for ($i = 0; $i -lt $segments.Count; $i += 1) {
  $segment = $segments[$i]
  $variant = @($segment.Payload.variants | Where-Object { $_.name -eq $preferredName })[0]
  $q = $i + 1
  Write-Host "PHASE7H4_Q${q}_WINDOW=$($segment.From)..$($segment.To)"
  Write-Host "PHASE7H4_Q${q}_PREFERRED=$preferredName"
  Write-Host "PHASE7H4_Q${q}_TRADES=$($variant.metrics.trades)"
  Write-Host "PHASE7H4_Q${q}_NET=$($variant.metrics.netPnl)"
  Write-Host "PHASE7H4_Q${q}_PF=$($variant.metrics.profitFactor)"
  Write-Host "PHASE7H4_Q${q}_EXPECTANCY=$($variant.metrics.expectancy)"
  Write-Host "PHASE7H4_Q${q}_DD=$($variant.metrics.maxDrawdownUsd)"
  Write-Host "PHASE7H4_Q${q}_EXACT_NET_EX_LARGEST=$($variant.metrics.exactNetExLargestWinner)"
}

Write-Host "PHASE7H4_POSITIVE_SEGMENTS=$positiveSegments"
Write-Host "PHASE7H4_PF_GT1_SEGMENTS=$pfGt1Segments"
Write-Host "PHASE7H4_SEGMENTS_WITH_10PLUS_TRADES=$segmentsWith10Trades"
Write-Host "PHASE7H4_GATE_TRADES=$gateTrades"
Write-Host "PHASE7H4_GATE_NET=$gateNet"
Write-Host "PHASE7H4_GATE_PF=$gatePf"
Write-Host "PHASE7H4_GATE_EXPECTANCY=$gateExpectancy"
Write-Host "PHASE7H4_GATE_EX_LARGEST=$gateExLargest"
Write-Host "PHASE7H4_GATE_TOP3=$gateTop3"
Write-Host "PHASE7H4_GATE_DD=$gateDd"
Write-Host "PHASE7H4_GATE_TIME_STABILITY=$gateTime"
Write-Host "PHASE7H4_GATE_SEGMENT_SAMPLE=$gateSample"
Write-Host "PHASE7H4_MANAGEMENT_IMPROVES_ROBUSTNESS=$managementImprovesRobustness"
Write-Host "PHASE7H4_MANAGEMENT_IMPROVES_NET=$managementImprovesNet"
Write-Host "PHASE7H4_MANAGEMENT_RESEARCH_CANDIDATE=$managementCandidate"
Write-Host "PHASE7H4_PRODUCTION_ENTRY_MUTATION=False"
Write-Host "PHASE7H4_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7H4_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7H4_NEXT=REVIEW_PREFERRED_HTF_OVERLAY_BEFORE_ANY_DEMO_STRATEGY_MUTATION"
