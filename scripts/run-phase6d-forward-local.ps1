param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [int]$Days = 180,
  [decimal]$MaxRiskUsd = 10,
  [string]$PythonExe = "python",
  [string]$BridgeEnv = "",
  [string]$FrozenDir = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$Exporter = Join-Path $WorkDir "extract_mt5_history.py"
$Driver = Join-Path $PSScriptRoot "run-phase6d-forward.ts"
$Merger = Join-Path $PSScriptRoot "merge-phase6d-forward-dataset.mjs"
$RealCutoffUtc = "2026-08-12T16:25:00.000Z"
$PreRegisteredDatasetOffsetMs = 10800000
$AllowedObservedOffsetDeviationMs = 300000
$ProgressCsv = Join-Path $WorkDir "phase6d-progress.csv"
$LatestTradeAuditCsv = Join-Path $WorkDir "phase6d-trade-audit-latest.csv"

function Get-Phase6DValue {
  param([string]$Name, [string]$LogPath)
  $match = Select-String -Path $LogPath -Pattern ("^" + [regex]::Escape($Name) + "=") | Select-Object -Last 1
  if ($null -eq $match) { return $null }
  return ($match.Line -split "=", 2)[1]
}

if ([string]::IsNullOrWhiteSpace($BridgeEnv)) {
  $candidates = @(
    $env:ZIQ_BRIDGE_ENV,
    (Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env"),
    (Join-Path $ProjectRoot "packages\mt5-broker\bridge.env")
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  $BridgeEnv = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($BridgeEnv)) {
    throw "Required Phase 6D bridge env not found. Searched: $($candidates -join '; ')"
  }
}
$BridgeEnv = (Resolve-Path $BridgeEnv).Path

if ([string]::IsNullOrWhiteSpace($FrozenDir)) {
  $latestFrozen = Get-ChildItem $WorkDir -Directory -Filter "frozen-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -eq $latestFrozen) { throw "No frozen Phase 4 dataset found under $WorkDir." }
  $FrozenDir = $latestFrozen.FullName
}
$FrozenDir = (Resolve-Path $FrozenDir).Path

$FrozenM15 = Join-Path $FrozenDir "phase4-m15.json"
$FrozenM5 = Join-Path $FrozenDir "phase4-m5.json"
$FrozenMeta = Join-Path $FrozenDir "phase4-meta.json"
foreach ($required in @($Exporter, $Driver, $Merger, $BridgeEnv, $FrozenM15, $FrozenM5, $FrozenMeta)) {
  if (-not (Test-Path $required)) { throw "Required Phase 6D input not found: $required" }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $WorkDir "phase6d-forward-runs\$stamp"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$rawM15 = Join-Path $runDir "phase6d-raw-m15.json"
$rawM5 = Join-Path $runDir "phase6d-raw-m5.json"
$rawMeta = Join-Path $runDir "phase6d-raw-meta.json"
$rawResult = Join-Path $runDir "phase6d-raw-result.json"
$mergedM15 = Join-Path $runDir "phase6d-forward-m15.json"
$mergedM5 = Join-Path $runDir "phase6d-forward-m5.json"
$mergedMeta = Join-Path $runDir "phase6d-forward-meta.json"
$exportLog = Join-Path $runDir "phase6d-forward-export.log"
$consoleLog = Join-Path $runDir "phase6d-forward-console.log"
$tradeAuditCsv = Join-Path $runDir "phase6d-trade-audit.csv"

$env:ZIQ_BRIDGE_ENV = $BridgeEnv
$env:ZIQ_M15_JSON = $rawM15
$env:ZIQ_M5_JSON = $rawM5
$env:ZIQ_META_JSON = $rawMeta
$env:ZIQ_RESULT_JSON = $rawResult
$env:ZIQ_DAYS = [string]$Days
$env:ZIQ_MAX_RISK_USD = [string]$MaxRiskUsd
$env:ZIQ_PHASE6D_TRADE_AUDIT_CSV = $tradeAuditCsv
$realCutoffMs = [DateTimeOffset]::Parse($RealCutoffUtc).ToUnixTimeMilliseconds()
$datasetCutoffMs = $realCutoffMs + $PreRegisteredDatasetOffsetMs
$datasetCutoffIso = [DateTimeOffset]::FromUnixTimeMilliseconds($datasetCutoffMs).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$env:ZIQ_PHASE6D_DATASET_CUTOFF_MS = [string]$datasetCutoffMs

Write-Host "PHASE6D_FORWARD_RUN_DIR=$runDir"
Write-Host "PHASE6D_FORWARD_FROZEN_DIR=$FrozenDir"
Write-Host "PHASE6D_FORWARD_REAL_CUTOFF_UTC=$RealCutoffUtc"
Write-Host "PHASE6D_FORWARD_DATASET_CUTOFF=$datasetCutoffIso"
Write-Host "PHASE6D_FORWARD_DATASET_OFFSET_MS=$PreRegisteredDatasetOffsetMs"
Write-Host "PHASE6D_FORWARD_CANDIDATE=BASELINE_BUY_SELL"
Write-Host "PHASE6D_FORWARD_MAX_RISK_USD=$MaxRiskUsd"
Write-Host "PHASE6D_FORWARD_EXPORT_START"

& $PythonExe $Exporter 2>&1 | Tee-Object $exportLog
if ($LASTEXITCODE -ne 0) { throw "Phase 6D MT5 history export failed with exit code $LASTEXITCODE" }
foreach ($output in @($rawM15, $rawM5, $rawMeta)) {
  if (-not (Test-Path $output)) { throw "Expected Phase 6D raw export missing: $output" }
}
Write-Host "PHASE6D_FORWARD_EXPORT_STATUS=PASS"

$offsetLine = Select-String -Path $exportLog -Pattern "^BROKER_HOST_OFFSET_MS=" | Select-Object -Last 1
if ($null -eq $offsetLine) { throw "Exporter did not report BROKER_HOST_OFFSET_MS." }
$observedOffsetMs = [long](($offsetLine.Line -split "=", 2)[1])
$normalizedObservedOffsetMs = [long]([math]::Round($observedOffsetMs / 60000.0) * 60000)
$offsetDeviationMs = [math]::Abs($normalizedObservedOffsetMs - $PreRegisteredDatasetOffsetMs)
Write-Host "PHASE6D_FORWARD_BROKER_HOST_OFFSET_MS=$observedOffsetMs"
Write-Host "PHASE6D_FORWARD_NORMALIZED_OFFSET_MS=$normalizedObservedOffsetMs"
Write-Host "PHASE6D_FORWARD_OFFSET_DEVIATION_MS=$offsetDeviationMs"
if ($offsetDeviationMs -gt $AllowedObservedOffsetDeviationMs) {
  Write-Host "PHASE6D_FORWARD_TIMEBASE_STATUS=FAIL"
  throw "Observed broker timestamp offset does not match the pre-registered +03:00 dataset timebase."
}
Write-Host "PHASE6D_FORWARD_TIMEBASE_STATUS=PASS"

Write-Host "PHASE6D_FORWARD_MERGE_START"
& node $Merger --frozenM15 $FrozenM15 --frozenM5 $FrozenM5 --freshM15 $rawM15 --freshM5 $rawM5 --freshMeta $rawMeta --outM15 $mergedM15 --outM5 $mergedM5 --outMeta $mergedMeta --realCutoff $RealCutoffUtc --datasetCutoffMs $datasetCutoffMs
if ($LASTEXITCODE -ne 0) { throw "Phase 6D frozen-plus-forward merge failed with exit code $LASTEXITCODE" }

$env:ZIQ_M15_JSON = $mergedM15
$env:ZIQ_M5_JSON = $mergedM5
$env:ZIQ_META_JSON = $mergedMeta
Get-FileHash $mergedM15, $mergedM5, $mergedMeta -Algorithm SHA256 | ForEach-Object {
  Write-Host ("PHASE6D_FORWARD_SHA256={0}|{1}" -f (Split-Path $_.Path -Leaf), $_.Hash)
}

Push-Location $ProjectRoot
try {
  Write-Host "PHASE6D_FORWARD_BUILD_START"
  & pnpm --filter @xauusd/risk-engine build
  if ($LASTEXITCODE -ne 0) { throw "Phase 6D risk-engine build failed with exit code $LASTEXITCODE" }
  Write-Host "PHASE6D_FORWARD_BUILD_STATUS=PASS"
  Write-Host "PHASE6D_FORWARD_REPLAY_START"
  & pnpm exec tsx $Driver 2>&1 | Tee-Object -FilePath $consoleLog | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "PHASE6D_FORWARD_REPLAY_STATUS=FAIL"
    Get-Content $consoleLog -Tail 100
    throw "Phase 6D forward replay failed with exit code $LASTEXITCODE"
  }
}
finally { Pop-Location }

if (-not (Test-Path $tradeAuditCsv)) {
  throw "Phase 6D trade audit CSV was not produced: $tradeAuditCsv"
}
Copy-Item -Path $tradeAuditCsv -Destination $LatestTradeAuditCsv -Force

Write-Host "PHASE6D_FORWARD_REPLAY_STATUS=PASS"
Write-Host "PHASE6D_FORWARD_LOG=$consoleLog"
Write-Host "PHASE6D_FORWARD_TRADE_AUDIT=$tradeAuditCsv"
Write-Host "PHASE6D_FORWARD_TRADE_AUDIT_LATEST=$LatestTradeAuditCsv"
Write-Host "PHASE6D_FORWARD_RESULT_BEGIN"
Select-String -Path $consoleLog -Pattern "^PHASE6D_" | ForEach-Object { $_.Line }
Write-Host "PHASE6D_FORWARD_RESULT_END"

$minimumFilled = [int](Get-Phase6DValue "PHASE6D_MINIMUM_FILLED_TRADES" $consoleLog)
$filledTrades = [int](Get-Phase6DValue "PHASE6D_FILLED_TRADES" $consoleLog)
$postCutoffCases = [int](Get-Phase6DValue "PHASE6D_POST_CUTOFF_CASES" $consoleLog)
$eligibleCases = [int](Get-Phase6DValue "PHASE6D_ELIGIBLE_CASES" $consoleLog)
$eligibleBuy = [int](Get-Phase6DValue "PHASE6D_ELIGIBLE_BUY_CASES" $consoleLog)
$eligibleSell = [int](Get-Phase6DValue "PHASE6D_ELIGIBLE_SELL_CASES" $consoleLog)
$winRate = Get-Phase6DValue "PHASE6D_WIN_RATE" $consoleLog
$netPnl = Get-Phase6DValue "PHASE6D_NET_PNL" $consoleLog
$profitFactor = Get-Phase6DValue "PHASE6D_PROFIT_FACTOR" $consoleLog
$expectancy = Get-Phase6DValue "PHASE6D_EXPECTANCY" $consoleLog
$avgR = Get-Phase6DValue "PHASE6D_AVG_R" $consoleLog
$status = Get-Phase6DValue "PHASE6D_STATUS" $consoleLog
$firstEligible = Get-Phase6DValue "PHASE6D_FIRST_ELIGIBLE" $consoleLog
$lastEligible = Get-Phase6DValue "PHASE6D_LAST_ELIGIBLE" $consoleLog
if ($minimumFilled -lt 1) { throw "Phase 6D progress tracker could not resolve minimum trade count." }

$progressPercent = [math]::Min(100, [math]::Round(($filledTrades * 100.0) / $minimumFilled, 1))
$remainingTrades = [math]::Max(0, $minimumFilled - $filledTrades)
$barWidth = 30
if ($filledTrades -gt 0) {
  $filledWidth = [math]::Min($barWidth, [math]::Max(1, [int][math]::Floor(($filledTrades * 1.0 / $minimumFilled) * $barWidth)))
}
else {
  $filledWidth = 0
}
$progressBar = ("#" * $filledWidth) + ("-" * ($barWidth - $filledWidth))
$record = [pscustomobject]@{
  RunLocalTime=(Get-Date).ToString("yyyy-MM-dd HH:mm:ss"); RunDir=$runDir; Candidate="BASELINE_BUY_SELL";
  PostCutoffCases=$postCutoffCases; EligibleCases=$eligibleCases; EligibleBuyCases=$eligibleBuy; EligibleSellCases=$eligibleSell;
  FilledTrades=$filledTrades; MinimumFilledTrades=$minimumFilled; ProgressPercent=$progressPercent; RemainingTrades=$remainingTrades;
  WinRate=$winRate; NetPnl=$netPnl; ProfitFactor=$profitFactor; Expectancy=$expectancy; AvgR=$avgR; Status=$status;
  FirstEligible=$firstEligible; LastEligible=$lastEligible; TradeAuditCsv=$LatestTradeAuditCsv
}
if (Test-Path $ProgressCsv) { $record | Export-Csv $ProgressCsv -NoTypeInformation -Append -Encoding UTF8 }
else { $record | Export-Csv $ProgressCsv -NoTypeInformation -Encoding UTF8 }

Write-Host "PHASE6D_PROGRESS_BEGIN"
Write-Host "PHASE6D_PROGRESS=$filledTrades/$minimumFilled"
Write-Host "PHASE6D_PROGRESS_PERCENT=$progressPercent"
Write-Host "PHASE6D_PROGRESS_BAR=[$progressBar]"
Write-Host "PHASE6D_PROGRESS_REMAINING_TRADES=$remainingTrades"
Write-Host "PHASE6D_PROGRESS_POST_CUTOFF_CASES=$postCutoffCases"
Write-Host "PHASE6D_PROGRESS_ELIGIBLE_CASES=$eligibleCases"
Write-Host "PHASE6D_PROGRESS_ELIGIBLE_BUY_CASES=$eligibleBuy"
Write-Host "PHASE6D_PROGRESS_ELIGIBLE_SELL_CASES=$eligibleSell"
Write-Host "PHASE6D_PROGRESS_WIN_RATE=$winRate"
Write-Host "PHASE6D_PROGRESS_NET_PNL=$netPnl"
Write-Host "PHASE6D_PROGRESS_PROFIT_FACTOR=$profitFactor"
Write-Host "PHASE6D_PROGRESS_EXPECTANCY=$expectancy"
Write-Host "PHASE6D_PROGRESS_AVG_R=$avgR"
Write-Host "PHASE6D_PROGRESS_STATUS=$status"
Write-Host "PHASE6D_PROGRESS_TRACKER=$ProgressCsv"
Write-Host "PHASE6D_PROGRESS_TRADE_AUDIT=$LatestTradeAuditCsv"
Write-Host "PHASE6D_PROGRESS_END"
Write-Host "PHASE6D_FORWARD_RUN_STATUS=PASS"