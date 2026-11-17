param(
  [int]$ApiPort = 3711,
  [string]$From = "",
  [string]$To = ""
)

$ErrorActionPreference = "Stop"
$toDate = if ($To) { $To } else { (Get-Date).AddDays(-1).ToString("yyyy-MM-dd") }
$fromDate = if ($From) { $From } else { (Get-Date).AddDays(-7).ToString("yyyy-MM-dd") }

$body = @{
  from = $fromDate
  to = $toDate
  fixedVolume = 0.03
  recoveryMinPrice = 6
  recoveryMaxPrice = 10
  profitBufferUsd = 3
  positiveLockFloorUsd = 0
  dayUtcOffsetHours = 7
} | ConvertTo-Json

$r = Invoke-RestMethod `
  -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7d/daily-scale-backtest" `
  -Method Post -ContentType "application/json" -Body $body -TimeoutSec 300

if ($r.source -ne "PHASE7D_DAILY_RECOVERY_TREND_SCALE_RESEARCH") { throw "Unexpected Phase 7D daily scale source." }
if ($r.replayMode -ne "EXACT_PER_LANE_SIGNAL_CONTENTION_WITH_M5_APPROXIMATION") { throw "Exact per-lane replay is not active." }
if ($r.safety.executionMutation -ne $false -or $r.safety.phase7bStrategyMutation -ne $false) { throw "Daily scale research unexpectedly allows strategy/execution mutation." }
if ($r.decision.executionEligible -ne $false) { throw "Daily scale research execution must remain disabled." }
if (-not $r.current -or -not $r.recoveryLockCurrent -or -not $r.scaleBe6 -or -not $r.scaleBe10) { throw "Daily scale lanes are incomplete." }
if (-not $r.reconciliation) { throw "Phase 7D reconciliation gate is missing." }
if (-not $r.reconciliation.tradeDiffs) { throw "Phase 7D trade-level reconciliation diagnostics are missing." }
if ([math]::Abs($r.configuration.firstPartialVolume - 0.01) -gt 0.000001) { throw "Expected +10 partial 0.01 lot for fixed 0.03." }
if ([math]::Abs($r.configuration.secondPartialVolume - 0.01) -gt 0.000001) { throw "Expected +20 partial 0.01 lot for fixed 0.03." }
if ([math]::Abs($r.configuration.finalRunnerVolume - 0.01) -gt 0.000001) { throw "Expected final runner 0.01 lot for fixed 0.03." }

if ($r.reconciliation.passed -eq $false -and $r.decision.verdict -ne "RECONCILIATION_FAILED") {
  throw "Reconciliation failed but scale verdict was not locked."
}
if ($r.reconciliation.passed -eq $true -and $r.decision.verdict -eq "RECONCILIATION_FAILED") {
  throw "Reconciliation passed but scale verdict remained locked."
}

Write-Host "PHASE7D_DAILY_SCALE_TEST=PASS"
Write-Host "PHASE7D_DAILY_SCALE_WINDOW=$fromDate..$toDate"
Write-Host "PHASE7D_DAILY_SCALE_REPLAY=$($r.replayMode)"
Write-Host "PHASE7D_DAILY_SCALE_RECONCILIATION=$($r.reconciliation.status)"
Write-Host "PHASE7D_DAILY_SCALE_RECONCILIATION_FAILED_COUNT=$($r.reconciliation.failedKeys.Count)"
if ($r.reconciliation.failedKeys.Count -gt 0) {
  Write-Host "PHASE7D_DAILY_SCALE_RECONCILIATION_FAILED_KEYS=$($r.reconciliation.failedKeys -join '|')"
}
foreach ($check in $r.reconciliation.checks) {
  if (-not $check.pass) {
    Write-Host "PHASE7D_RECON_FAIL_$($check.key)=EXPECTED:$($check.expected)|ACTUAL:$($check.actual)|DELTA:$($check.delta)"
  }
}

if ($r.reconciliation.diagnostic) {
  Write-Host "PHASE7D_DAILY_SCALE_MANAGEMENT_DIAGNOSTIC=$($r.reconciliation.diagnostic.status)"
  Write-Host "PHASE7D_DAILY_SCALE_MANAGEMENT_DIAGNOSTIC_FAILED_COUNT=$($r.reconciliation.diagnostic.failedKeys.Count)"
  if ($r.reconciliation.diagnostic.failedKeys.Count -gt 0) {
    Write-Host "PHASE7D_DAILY_SCALE_MANAGEMENT_DIAGNOSTIC_FAILED_KEYS=$($r.reconciliation.diagnostic.failedKeys -join '|')"
  }
}

$diffSets = @{
  DAILY_VS_SCALE_CURRENT = $r.reconciliation.tradeDiffs.dailyVsScaleCurrent
  DAILY_VS_SCALE_RECOVERY_LOCK = $r.reconciliation.tradeDiffs.dailyVsScaleRecoveryLock
  MANAGEMENT_VS_DAILY_CURRENT = $r.reconciliation.tradeDiffs.managementVsDailyCurrent
}
foreach ($name in $diffSets.Keys) {
  $d = $diffSets[$name]
  if (-not $d) { continue }
  Write-Host "PHASE7D_RECON_${name}_MISMATCHES=$($d.mismatchCount)"
  Write-Host "PHASE7D_RECON_${name}_PNL_DELTA=$($d.totalPnlDelta)"
  Write-Host "PHASE7D_RECON_${name}_PNL_MISMATCHES=$($d.pnlMismatchCount)"
  Write-Host "PHASE7D_RECON_${name}_EXITTIME_MISMATCHES=$($d.exitTimeMismatchCount)"
  Write-Host "PHASE7D_RECON_${name}_REASON_MISMATCHES=$($d.reasonMismatchCount)"
  Write-Host "PHASE7D_RECON_${name}_MISSING_EXPECTED=$($d.missingExpectedCount)"
  Write-Host "PHASE7D_RECON_${name}_MISSING_ACTUAL=$($d.missingActualCount)"
  $i = 0
  foreach ($row in ($d.topMismatches | Select-Object -First 10)) {
    $i += 1
    Write-Host "PHASE7D_RECON_${name}_TOP${i}=ENTRY:$($row.entryTime)|EXP_EXIT:$($row.expectedExitTime)|ACT_EXIT:$($row.actualExitTime)|DT_MS:$($row.exitTimeDeltaMs)|EXP_PNL:$($row.expectedPnl)|ACT_PNL:$($row.actualPnl)|DPNL:$($row.pnlDelta)|EXP_REASON:$($row.expectedReason)|ACT_REASON:$($row.actualReason)|MISSING:$($row.missingSide)"
  }
}

Write-Host "PHASE7D_DAILY_SCALE_SIGNALS=$($r.configuration.signals)"
Write-Host "PHASE7D_DAILY_SCALE_CANDIDATES=$($r.configuration.filledCandidates)"
Write-Host "PHASE7D_DAILY_SCALE_CURRENT_NET=$($r.current.metrics.netPnl)"
Write-Host "PHASE7D_DAILY_SCALE_RECOVERY_LOCK_NET=$($r.recoveryLockCurrent.metrics.netPnl)"
Write-Host "PHASE7D_DAILY_SCALE_BE6_NET=$($r.scaleBe6.metrics.netPnl)"
Write-Host "PHASE7D_DAILY_SCALE_BE10_NET=$($r.scaleBe10.metrics.netPnl)"
Write-Host "PHASE7D_DAILY_SCALE_BE6_PLUS20_RATE=$($r.scaleBe6.metrics.plus20RatePercent)"
Write-Host "PHASE7D_DAILY_SCALE_BE10_PLUS20_RATE=$($r.scaleBe10.metrics.plus20RatePercent)"
Write-Host "PHASE7D_DAILY_SCALE_VERDICT=$($r.decision.verdict)"
Write-Host "PHASE7D_DAILY_SCALE_PREFERRED=$($r.decision.preferredResearchLane)"
Write-Host "PHASE7D_DAILY_SCALE_EXECUTION_ELIGIBLE=$($r.decision.executionEligible)"
