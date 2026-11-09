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
$Driver = Join-Path $PSScriptRoot "run-phase6c-forward.ts"
$Merger = Join-Path $PSScriptRoot "merge-phase6c-forward-dataset.mjs"
$RealCutoffUtc = "2026-08-12T16:10:00.000Z"
$PreRegisteredDatasetOffsetMs = 10800000
$AllowedObservedOffsetDeviationMs = 300000
$ProgressCsv = Join-Path $WorkDir "phase6c-progress.csv"

function Get-Phase6CValue {
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
    throw "Required Phase 6C bridge env not found. Searched: $($candidates -join '; ')"
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
  if (-not (Test-Path $required)) { throw "Required Phase 6C input not found: $required" }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $WorkDir "phase6c-forward-runs\$stamp"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$rawM15 = Join-Path $runDir "phase6c-raw-m15.json"
$rawM5 = Join-Path $runDir "phase6c-raw-m5.json"
$rawMeta = Join-Path $runDir "phase6c-raw-meta.json"
$rawResult = Join-Path $runDir "phase6c-raw-result.json"
$mergedM15 = Join-Path $runDir "phase6c-forward-m15.json"
$mergedM5 = Join-Path $runDir "phase6c-forward-m5.json"
$mergedMeta = Join-Path $runDir "phase6c-forward-meta.json"
$exportLog = Join-Path $runDir "phase6c-forward-export.log"
$consoleLog = Join-Path $runDir "phase6c-forward-console.log"

$env:ZIQ_BRIDGE_ENV = $BridgeEnv
$env:ZIQ_M15_JSON = $rawM15
$env:ZIQ_M5_JSON = $rawM5
$env:ZIQ_META_JSON = $rawMeta
$env:ZIQ_RESULT_JSON = $rawResult
$env:ZIQ_DAYS = [string]$Days
$env:ZIQ_MAX_RISK_USD = [string]$MaxRiskUsd
$realCutoffMs = [DateTimeOffset]::Parse($RealCutoffUtc).ToUnixTimeMilliseconds()
$datasetCutoffMs = $realCutoffMs + $PreRegisteredDatasetOffsetMs
$datasetCutoffIso = [DateTimeOffset]::FromUnixTimeMilliseconds($datasetCutoffMs).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$env:ZIQ_PHASE6C_DATASET_CUTOFF_MS = [string]$datasetCutoffMs

Write-Host "PHASE6C_FORWARD_RUN_DIR=$runDir"
Write-Host "PHASE6C_FORWARD_FROZEN_DIR=$FrozenDir"
Write-Host "PHASE6C_FORWARD_REAL_CUTOFF_UTC=$RealCutoffUtc"
Write-Host "PHASE6C_FORWARD_DATASET_CUTOFF=$datasetCutoffIso"
Write-Host "PHASE6C_FORWARD_DATASET_OFFSET_MS=$PreRegisteredDatasetOffsetMs"
Write-Host "PHASE6C_FORWARD_CANDIDATE=BASELINE_BUY"
Write-Host "PHASE6C_FORWARD_MAX_RISK_USD=$MaxRiskUsd"
Write-Host "PHASE6C_FORWARD_EXPORT_START"

& $PythonExe $Exporter 2>&1 | Tee-Object $exportLog
if ($LASTEXITCODE -ne 0) { throw "Phase 6C MT5 history export failed with exit code $LASTEXITCODE" }
foreach ($output in @($rawM15, $rawM5, $rawMeta)) {
  if (-not (Test-Path $output)) { throw "Expected Phase 6C raw export missing: $output" }
}
Write-Host "PHASE6C_FORWARD_EXPORT_STATUS=PASS"

$offsetLine = Select-String -Path $exportLog -Pattern "^BROKER_HOST_OFFSET_MS=" | Select-Object -Last 1
if ($null -eq $offsetLine) { throw "Exporter did not report BROKER_HOST_OFFSET_MS." }
$observedOffsetMs = [long](($offsetLine.Line -split "=", 2)[1])
$normalizedObservedOffsetMs = [long]([math]::Round($observedOffsetMs / 60000.0) * 60000)
$offsetDeviationMs = [math]::Abs($normalizedObservedOffsetMs - $PreRegisteredDatasetOffsetMs)
Write-Host "PHASE6C_FORWARD_BROKER_HOST_OFFSET_MS=$observedOffsetMs"
Write-Host "PHASE6C_FORWARD_NORMALIZED_OFFSET_MS=$normalizedObservedOffsetMs"
Write-Host "PHASE6C_FORWARD_OFFSET_DEVIATION_MS=$offsetDeviationMs"
if ($offsetDeviationMs -gt $AllowedObservedOffsetDeviationMs) {
  Write-Host "PHASE6C_FORWARD_TIMEBASE_STATUS=FAIL"
  throw "Observed broker timestamp offset does not match the pre-registered +03:00 dataset timebase."
}
Write-Host "PHASE6C_FORWARD_TIMEBASE_STATUS=PASS"

Write-Host "PHASE6C_FORWARD_MERGE_START"
& node $Merger --frozenM15 $FrozenM15 --frozenM5 $FrozenM5 --freshM15 $rawM15 --freshM5 $rawM5 --freshMeta $rawMeta --outM15 $mergedM15 --outM5 $mergedM5 --outMeta $mergedMeta --realCutoff $RealCutoffUtc --datasetCutoffMs $datasetCutoffMs
if ($LASTEXITCODE -ne 0) { throw "Phase 6C frozen-plus-forward merge failed with exit code $LASTEXITCODE" }

$env:ZIQ_M15_JSON = $mergedM15
$env:ZIQ_M5_JSON = $mergedM5
$env:ZIQ_META_JSON = $mergedMeta
Get-FileHash $mergedM15, $mergedM5, $mergedMeta -Algorithm SHA256 | ForEach-Object {
  Write-Host ("PHASE6C_FORWARD_SHA256={0}|{1}" -f (Split-Path $_.Path -Leaf), $_.Hash)
}

Push-Location $ProjectRoot
try {
  Write-Host "PHASE6C_FORWARD_BUILD_START"
  & pnpm --filter @xauusd/risk-engine build
  if ($LASTEXITCODE -ne 0) { throw "Phase 6C risk-engine build failed with exit code $LASTEXITCODE" }
  Write-Host "PHASE6C_FORWARD_BUILD_STATUS=PASS"
  Write-Host "PHASE6C_FORWARD_REPLAY_START"
  & pnpm exec tsx $Driver 2>&1 | Tee-Object -FilePath $consoleLog | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "PHASE6C_FORWARD_REPLAY_STATUS=FAIL"
    Get-Content $consoleLog -Tail 100
    throw "Phase 6C forward replay failed with exit code $LASTEXITCODE"
  }
}
finally { Pop-Location }

Write-Host "PHASE6C_FORWARD_REPLAY_STATUS=PASS"
Write-Host "PHASE6C_FORWARD_LOG=$consoleLog"
Write-Host "PHASE6C_FORWARD_RESULT_BEGIN"
Select-String -Path $consoleLog -Pattern "^PHASE6C_" | ForEach-Object { $_.Line }
Write-Host "PHASE6C_FORWARD_RESULT_END"

$minimumFilled = [int](Get-Phase6CValue "PHASE6C_MINIMUM_FILLED_TRADES" $consoleLog)
$filledTrades = [int](Get-Phase6CValue "PHASE6C_FILLED_TRADES" $consoleLog)
$postCutoffCases = [int](Get-Phase6CValue "PHASE6C_POST_CUTOFF_CASES" $consoleLog)
$eligibleCases = [int](Get-Phase6CValue "PHASE6C_ELIGIBLE_CASES" $consoleLog)
$winRate = Get-Phase6CValue "PHASE6C_WIN_RATE" $consoleLog
$netPnl = Get-Phase6CValue "PHASE6C_NET_PNL" $consoleLog
$profitFactor = Get-Phase6CValue "PHASE6C_PROFIT_FACTOR" $consoleLog
$expectancy = Get-Phase6CValue "PHASE6C_EXPECTANCY" $consoleLog
$avgR = Get-Phase6CValue "PHASE6C_AVG_R" $consoleLog
$status = Get-Phase6CValue "PHASE6C_STATUS" $consoleLog
$firstEligible = Get-Phase6CValue "PHASE6C_FIRST_ELIGIBLE" $consoleLog
$lastEligible = Get-Phase6CValue "PHASE6C_LAST_ELIGIBLE" $consoleLog
if ($minimumFilled -lt 1) { throw "Phase 6C progress tracker could not resolve minimum trade count." }

$progressPercent = [math]::Min(100, [math]::Round(($filledTrades * 100.0) / $minimumFilled, 1))
$remainingTrades = [math]::Max(0, $minimumFilled - $filledTrades)
$barWidth = 30
$filledWidth = [int][math]::Floor(($progressPercent / 100.0) * $barWidth)
$progressBar = ("#" * $filledWidth) + ("-" * ($barWidth - $filledWidth))
$record = [pscustomobject]@{
  RunLocalTime=(Get-Date).ToString("yyyy-MM-dd HH:mm:ss"); RunDir=$runDir; Candidate="BASELINE_BUY";
  PostCutoffCases=$postCutoffCases; EligibleCases=$eligibleCases; FilledTrades=$filledTrades; MinimumFilledTrades=$minimumFilled;
  ProgressPercent=$progressPercent; RemainingTrades=$remainingTrades; WinRate=$winRate; NetPnl=$netPnl; ProfitFactor=$profitFactor;
  Expectancy=$expectancy; AvgR=$avgR; Status=$status; FirstEligible=$firstEligible; LastEligible=$lastEligible
}
if (Test-Path $ProgressCsv) { $record | Export-Csv $ProgressCsv -NoTypeInformation -Append -Encoding UTF8 }
else { $record | Export-Csv $ProgressCsv -NoTypeInformation -Encoding UTF8 }

Write-Host "PHASE6C_PROGRESS_BEGIN"
Write-Host "PHASE6C_PROGRESS=$filledTrades/$minimumFilled"
Write-Host "PHASE6C_PROGRESS_PERCENT=$progressPercent"
Write-Host "PHASE6C_PROGRESS_BAR=[$progressBar]"
Write-Host "PHASE6C_PROGRESS_REMAINING_TRADES=$remainingTrades"
Write-Host "PHASE6C_PROGRESS_POST_CUTOFF_CASES=$postCutoffCases"
Write-Host "PHASE6C_PROGRESS_ELIGIBLE_CASES=$eligibleCases"
Write-Host "PHASE6C_PROGRESS_WIN_RATE=$winRate"
Write-Host "PHASE6C_PROGRESS_NET_PNL=$netPnl"
Write-Host "PHASE6C_PROGRESS_PROFIT_FACTOR=$profitFactor"
Write-Host "PHASE6C_PROGRESS_EXPECTANCY=$expectancy"
Write-Host "PHASE6C_PROGRESS_AVG_R=$avgR"
Write-Host "PHASE6C_PROGRESS_STATUS=$status"
Write-Host "PHASE6C_PROGRESS_TRACKER=$ProgressCsv"
Write-Host "PHASE6C_PROGRESS_END"
Write-Host "PHASE6C_FORWARD_RUN_STATUS=PASS"
