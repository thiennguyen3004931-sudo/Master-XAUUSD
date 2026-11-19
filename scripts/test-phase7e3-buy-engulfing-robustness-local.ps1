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

function Invoke-Phase7EWindow {
  param(
    [datetime]$FromDate,
    [datetime]$ToDate
  )

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

  if ($r.source -ne "PHASE7E_M15_SUPERTREND_M5_REALIGNMENT_RESEARCH") { throw "Unexpected Phase 7E source for $fromText..$toText." }
  if ($r.safety.researchOnly -ne $true -or $r.safety.executionMutation -ne $false -or $r.safety.phase7bStrategyMutation -ne $false) {
    throw "Phase 7E.3 safety invariant failed for $fromText..$toText."
  }
  if (-not $r.flip2Ablation) { throw "Phase 7E.2 payload missing. Apply Phase 7E.2 patch and restart API first." }
  if ($r.flip2Ablation.decision.executionEligible -ne $false) { throw "Phase 7E.3 must remain execution-disabled." }

  $cell = $r.flip2Ablation.cells | Where-Object { $_.name -eq "BUY_ENGULFING" } | Select-Object -First 1
  if (-not $cell) { throw "BUY_ENGULFING ablation cell missing for $fromText..$toText." }

  [pscustomobject]@{
    From = $fromText
    To = $toText
    Response = $r
    Cell = $cell
  }
}

function Get-EstimatedNetExLargestWinner {
  param($Metrics)

  $net = [double]$Metrics.netPnl
  $share = [double]$Metrics.largestWinnerShareOfGrossProfitPercent
  if ($Metrics.profitFactor -eq $null) {
    if ($net -gt 0 -and $share -ge 0) {
      return [math]::Round($net * (1.0 - $share / 100.0), 2)
    }
    return $null
  }

  $pf = [double]$Metrics.profitFactor
  if ($net -le 0 -or $pf -le 1.0 -or $share -lt 0) { return $null }
  $grossLoss = $net / ($pf - 1.0)
  $grossProfit = $pf * $grossLoss
  $largestWinner = $grossProfit * $share / 100.0
  return [math]::Round($net - $largestWinner, 2)
}

function Get-EffectivePf {
  param($Metrics)
  if ($Metrics.profitFactor -eq $null) {
    return $(if ([double]$Metrics.netPnl -gt 0) { 999.0 } else { 0.0 })
  }
  return [double]$Metrics.profitFactor
}

$full = Invoke-Phase7EWindow -FromDate $fromDate -ToDate $toDate
$fullMetrics = $full.Cell.metrics
$fullBaseline = $full.Response.flip2Ablation.baseline.metrics
$fullNetExLargest = Get-EstimatedNetExLargestWinner $fullMetrics

$segments = @()
for ($i = 0; $i -lt 4; $i += 1) {
  $segmentFrom = $fromDate.AddDays($i * 90)
  $segmentTo = $segmentFrom.AddDays(89)
  $segments += Invoke-Phase7EWindow -FromDate $segmentFrom -ToDate $segmentTo
}

$positiveSegments = @($segments | Where-Object { [double]$_.Cell.metrics.netPnl -gt 0 }).Count
$profitablePfSegments = @($segments | Where-Object { (Get-EffectivePf $_.Cell.metrics) -gt 1.0 }).Count
$segmentsWithAtLeast5Trades = @($segments | Where-Object { [int]$_.Cell.metrics.trades -ge 5 }).Count

$gateTrades = [int]$fullMetrics.trades -ge 30
$gateNet = [double]$fullMetrics.netPnl -gt 0
$gatePf = (Get-EffectivePf $fullMetrics) -ge 1.20
$gateExpectancy = [double]$fullMetrics.expectancy -gt 0
$gateDrawdown = [double]$fullMetrics.maxDrawdownUsd -le [double]$fullBaseline.maxDrawdownUsd + 0.01
$gateConcentration = [double]$fullMetrics.largestWinnerShareOfGrossProfitPercent -le 40.0
$gateExLargest = $fullNetExLargest -ne $null -and [double]$fullNetExLargest -gt 0
$gateTimeStability = $positiveSegments -ge 3 -and $profitablePfSegments -ge 3
$gateSegmentSample = $segmentsWithAtLeast5Trades -ge 3

$shadowCandidate = $gateTrades -and $gateNet -and $gatePf -and $gateExpectancy -and $gateDrawdown -and $gateConcentration -and $gateExLargest -and $gateTimeStability -and $gateSegmentSample
$verdict = if ($shadowCandidate) {
  "BUY_ENGULFING_READY_FOR_SHADOW_TELEMETRY_ONLY"
} elseif ($gateNet -and $gatePf -and $gateExpectancy) {
  "BUY_ENGULFING_ECONOMICS_POSITIVE_BUT_ROBUSTNESS_NOT_PROVEN"
} else {
  "BUY_ENGULFING_EDGE_NOT_ROBUST"
}

Write-Host "PHASE7E3_ROBUSTNESS_TEST=PASS"
Write-Host "PHASE7E3_WINDOW=$($fromDate.ToString('yyyy-MM-dd'))..$($toDate.ToString('yyyy-MM-dd'))"
Write-Host "PHASE7E3_SOURCE_VARIANT=M5_FLIP_2"
Write-Host "PHASE7E3_CELL=BUY_ENGULFING"
Write-Host "PHASE7E3_FULL_SIGNALS=$($full.Cell.acceptedSignals)"
Write-Host "PHASE7E3_FULL_TRADES=$($fullMetrics.trades)"
Write-Host "PHASE7E3_FULL_NET=$($fullMetrics.netPnl)"
Write-Host "PHASE7E3_FULL_PF=$($fullMetrics.profitFactor)"
Write-Host "PHASE7E3_FULL_WIN_RATE=$($fullMetrics.winRatePercent)"
Write-Host "PHASE7E3_FULL_EXPECTANCY=$($fullMetrics.expectancy)"
Write-Host "PHASE7E3_FULL_AVG_R=$($fullMetrics.averageR)"
Write-Host "PHASE7E3_FULL_DD=$($fullMetrics.maxDrawdownUsd)"
Write-Host "PHASE7E3_FULL_HIT_PLUS6=$($fullMetrics.hitPlus6)"
Write-Host "PHASE7E3_FULL_HIT_PLUS10=$($fullMetrics.hitPlus10)"
Write-Host "PHASE7E3_FULL_STOP_BEFORE_PLUS6=$($fullMetrics.stopBeforePlus6)"
Write-Host "PHASE7E3_FULL_LARGEST_WINNER_SHARE=$($fullMetrics.largestWinnerShareOfGrossProfitPercent)"
Write-Host "PHASE7E3_FULL_EST_NET_EX_LARGEST=$fullNetExLargest"
Write-Host "PHASE7E3_FLIP2_BASELINE_TRADES=$($fullBaseline.trades)"
Write-Host "PHASE7E3_FLIP2_BASELINE_NET=$($fullBaseline.netPnl)"
Write-Host "PHASE7E3_FLIP2_BASELINE_PF=$($fullBaseline.profitFactor)"
Write-Host "PHASE7E3_FLIP2_BASELINE_DD=$($fullBaseline.maxDrawdownUsd)"

for ($i = 0; $i -lt $segments.Count; $i += 1) {
  $segment = $segments[$i]
  $m = $segment.Cell.metrics
  $netExLargest = Get-EstimatedNetExLargestWinner $m
  $n = $i + 1
  Write-Host "PHASE7E3_Q${n}_WINDOW=$($segment.From)..$($segment.To)"
  Write-Host "PHASE7E3_Q${n}_TRADES=$($m.trades)"
  Write-Host "PHASE7E3_Q${n}_NET=$($m.netPnl)"
  Write-Host "PHASE7E3_Q${n}_PF=$($m.profitFactor)"
  Write-Host "PHASE7E3_Q${n}_EXPECTANCY=$($m.expectancy)"
  Write-Host "PHASE7E3_Q${n}_DD=$($m.maxDrawdownUsd)"
  Write-Host "PHASE7E3_Q${n}_HIT_PLUS6=$($m.hitPlus6)"
  Write-Host "PHASE7E3_Q${n}_HIT_PLUS10=$($m.hitPlus10)"
  Write-Host "PHASE7E3_Q${n}_LARGEST_WINNER_SHARE=$($m.largestWinnerShareOfGrossProfitPercent)"
  Write-Host "PHASE7E3_Q${n}_EST_NET_EX_LARGEST=$netExLargest"
}

Write-Host "PHASE7E3_POSITIVE_SEGMENTS=$positiveSegments"
Write-Host "PHASE7E3_PROFITABLE_PF_SEGMENTS=$profitablePfSegments"
Write-Host "PHASE7E3_SEGMENTS_WITH_5PLUS_TRADES=$segmentsWithAtLeast5Trades"
Write-Host "PHASE7E3_GATE_TRADES=$gateTrades"
Write-Host "PHASE7E3_GATE_NET=$gateNet"
Write-Host "PHASE7E3_GATE_PF=$gatePf"
Write-Host "PHASE7E3_GATE_EXPECTANCY=$gateExpectancy"
Write-Host "PHASE7E3_GATE_DRAWDOWN=$gateDrawdown"
Write-Host "PHASE7E3_GATE_CONCENTRATION=$gateConcentration"
Write-Host "PHASE7E3_GATE_EX_LARGEST=$gateExLargest"
Write-Host "PHASE7E3_GATE_TIME_STABILITY=$gateTimeStability"
Write-Host "PHASE7E3_GATE_SEGMENT_SAMPLE=$gateSegmentSample"
Write-Host "PHASE7E3_SHADOW_CANDIDATE=$shadowCandidate"
Write-Host "PHASE7E3_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7E3_VERDICT=$verdict"
Write-Host "PHASE7E3_NOTE=Estimated Net ex-largest is reconstructed from rounded Net/PF/largest-winner-share; use as a robustness diagnostic, not accounting truth."
