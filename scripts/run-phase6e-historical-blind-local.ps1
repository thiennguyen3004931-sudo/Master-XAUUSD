param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [int]$ExportDays = 730,
  [decimal]$MaxRiskUsd = 10,
  [string]$PythonExe = "python",
  [string]$BridgeEnv = "",
  [string]$FrozenDir = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$Exporter = Join-Path $PSScriptRoot "export-phase6e-mt5-history.py"
$MaxBarsProbe = Join-Path $PSScriptRoot "probe-phase6e-mt5-maxbars.py"
$Driver = Join-Path $PSScriptRoot "run-phase6e-historical-blind.ts"
$Preparer = Join-Path $PSScriptRoot "prepare-phase6e-historical-blind-dataset.mjs"
$BlindDays = 360
$WarmupDays = 30
$ExpectedDatasetOffsetMs = 10800000
$AllowedObservedOffsetDeviationMs = 300000
$MinimumTerminalMaxBars = 100000

if ([math]::Abs([double]$MaxRiskUsd - 10.0) -gt 0.000001) {
  throw "Phase 6E risk is pre-registered at exactly USD 10. Do not retune MaxRiskUsd."
}
if ($ExportDays -lt ($BlindDays + $WarmupDays + 30)) {
  throw "ExportDays=$ExportDays is too short for the fixed 360-day blind window plus warm-up. Use 730 (recommended)."
}

if ([string]::IsNullOrWhiteSpace($BridgeEnv)) {
  $candidates = @(
    $env:ZIQ_BRIDGE_ENV,
    (Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env"),
    (Join-Path $ProjectRoot "packages\mt5-broker\bridge.env")
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  $BridgeEnv = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($BridgeEnv)) {
    throw "Required Phase 6E bridge env not found. Searched: $($candidates -join '; ')"
  }
}
$BridgeEnv = (Resolve-Path $BridgeEnv).Path

if ([string]::IsNullOrWhiteSpace($FrozenDir)) {
  $latestFrozen = Get-ChildItem $WorkDir -Directory -Filter "frozen-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -eq $latestFrozen) { throw "No frozen dataset found under $WorkDir." }
  $FrozenDir = $latestFrozen.FullName
}
$FrozenDir = (Resolve-Path $FrozenDir).Path
$FrozenM15 = Join-Path $FrozenDir "phase4-m15.json"

foreach ($required in @($Exporter, $MaxBarsProbe, $Driver, $Preparer, $BridgeEnv, $FrozenM15)) {
  if (-not (Test-Path $required)) { throw "Required Phase 6E input not found: $required" }
}

$env:ZIQ_BRIDGE_ENV = $BridgeEnv
$maxBarsProbeOutput = & $PythonExe $MaxBarsProbe 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Phase 6E could not query MT5 terminal max bars: $($maxBarsProbeOutput -join ' | ')"
}
$maxBarsLine = $maxBarsProbeOutput |
  Where-Object { $_.ToString() -match '^PHASE6E_MAXBARS_PROBE_VALUE=' } |
  Select-Object -Last 1
if ($null -eq $maxBarsLine) {
  throw "Phase 6E max-bars probe did not report PHASE6E_MAXBARS_PROBE_VALUE. Output: $($maxBarsProbeOutput -join ' | ')"
}
$terminalMaxBars = [int](($maxBarsLine.ToString() -split "=", 2)[1])
Write-Host "PHASE6E_TERMINAL_MAX_BARS=$terminalMaxBars"
Write-Host "PHASE6E_MINIMUM_TERMINAL_MAX_BARS=$MinimumTerminalMaxBars"
if ($terminalMaxBars -lt $MinimumTerminalMaxBars) {
  Write-Host "PHASE6E_TERMINAL_MAX_BARS_STATUS=FAIL"
  throw "Phase 6E requires MT5 Max. bars in chart >= $MinimumTerminalMaxBars for the fixed 360-day M5 blind window. Current=$terminalMaxBars. Set 200000 in MT5 Tools > Options > Charts, restart MT5, then rerun."
}
Write-Host "PHASE6E_TERMINAL_MAX_BARS_STATUS=PASS"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $WorkDir "phase6e-historical-runs\$stamp"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$rawM15 = Join-Path $runDir "phase6e-raw-m15.json"
$rawM5 = Join-Path $runDir "phase6e-raw-m5.json"
$rawMeta = Join-Path $runDir "phase6e-raw-meta.json"
$rawResult = Join-Path $runDir "phase6e-raw-result.json"
$preparedM15 = Join-Path $runDir "phase6e-blind-m15.json"
$preparedM5 = Join-Path $runDir "phase6e-blind-m5.json"
$preparedMeta = Join-Path $runDir "phase6e-blind-meta.json"
$exportLog = Join-Path $runDir "phase6e-export.log"
$prepareLog = Join-Path $runDir "phase6e-prepare.log"
$consoleLog = Join-Path $runDir "phase6e-console.log"
$auditCsv = Join-Path $runDir "phase6e-trade-audit.csv"
$latestAuditCsv = Join-Path $WorkDir "phase6e-historical-trade-audit-latest.csv"

$env:ZIQ_M15_JSON = $rawM15
$env:ZIQ_M5_JSON = $rawM5
$env:ZIQ_META_JSON = $rawMeta
$env:ZIQ_RESULT_JSON = $rawResult
$env:ZIQ_DAYS = [string]$ExportDays
$env:ZIQ_MAX_RISK_USD = [string]$MaxRiskUsd

Write-Host "PHASE6E_RUN_DIR=$runDir"
Write-Host "PHASE6E_FROZEN_DIR=$FrozenDir"
Write-Host "PHASE6E_EXPORTER=CHUNKED_COPY_RATES_RANGE"
Write-Host "PHASE6E_EXPORT_DAYS=$ExportDays"
Write-Host "PHASE6E_BLIND_DAYS=$BlindDays"
Write-Host "PHASE6E_WARMUP_DAYS=$WarmupDays"
Write-Host "PHASE6E_MAX_RISK_USD=$MaxRiskUsd"
Write-Host "PHASE6E_EXPORT_START"

& $PythonExe $Exporter 2>&1 | Tee-Object -FilePath $exportLog
if ($LASTEXITCODE -ne 0) { throw "Phase 6E chunked MT5 history export failed with exit code $LASTEXITCODE" }
foreach ($output in @($rawM15, $rawM5, $rawMeta)) {
  if (-not (Test-Path $output)) { throw "Expected Phase 6E raw export missing: $output" }
}
Write-Host "PHASE6E_EXPORT_STATUS=PASS"

$offsetLine = Select-String -Path $exportLog -Pattern "^BROKER_HOST_OFFSET_MS=" | Select-Object -Last 1
if ($null -eq $offsetLine) { throw "Exporter did not report BROKER_HOST_OFFSET_MS." }
$observedOffsetMs = [long](($offsetLine.Line -split "=", 2)[1])
$normalizedObservedOffsetMs = [long]([math]::Round($observedOffsetMs / 60000.0) * 60000)
$offsetDeviationMs = [math]::Abs($normalizedObservedOffsetMs - $ExpectedDatasetOffsetMs)
Write-Host "PHASE6E_BROKER_HOST_OFFSET_MS=$observedOffsetMs"
Write-Host "PHASE6E_NORMALIZED_OFFSET_MS=$normalizedObservedOffsetMs"
Write-Host "PHASE6E_OFFSET_DEVIATION_MS=$offsetDeviationMs"
if ($offsetDeviationMs -gt $AllowedObservedOffsetDeviationMs) {
  Write-Host "PHASE6E_TIMEBASE_STATUS=FAIL"
  throw "Observed broker timestamp offset does not match the locked +03:00 dataset timebase."
}
Write-Host "PHASE6E_TIMEBASE_STATUS=PASS"

Write-Host "PHASE6E_PREP_START"
& node $Preparer `
  --frozenM15 $FrozenM15 `
  --rawM15 $rawM15 `
  --rawM5 $rawM5 `
  --rawMeta $rawMeta `
  --outM15 $preparedM15 `
  --outM5 $preparedM5 `
  --outMeta $preparedMeta `
  --blindDays $BlindDays `
  --warmupDays $WarmupDays `
  --datasetOffsetMs $ExpectedDatasetOffsetMs 2>&1 | Tee-Object -FilePath $prepareLog
if ($LASTEXITCODE -ne 0) { throw "Phase 6E blind dataset preparation failed with exit code $LASTEXITCODE" }
foreach ($output in @($preparedM15, $preparedM5, $preparedMeta)) {
  if (-not (Test-Path $output)) { throw "Expected Phase 6E prepared file missing: $output" }
}
Write-Host "PHASE6E_PREP_STATUS=PASS"

$meta = Get-Content $preparedMeta -Raw | ConvertFrom-Json
$blind = $meta.phase6eHistoricalBlind
if ($null -eq $blind -or -not $blind.strictNoOverlap) {
  throw "Phase 6E prepared metadata did not confirm strict no-overlap."
}

$env:ZIQ_M15_JSON = $preparedM15
$env:ZIQ_M5_JSON = $preparedM5
$env:ZIQ_META_JSON = $preparedMeta
$env:ZIQ_PHASE6E_BLIND_START_MS = [string]$blind.blindStartTimestamp
$env:ZIQ_PHASE6E_BLIND_END_MS = [string]$blind.blindEndTimestamp
$env:ZIQ_PHASE6E_DATASET_OFFSET_MS = [string]$ExpectedDatasetOffsetMs
$env:ZIQ_PHASE6E_AUDIT_CSV = $auditCsv

Get-FileHash $preparedM15, $preparedM5, $preparedMeta -Algorithm SHA256 | ForEach-Object {
  Write-Host ("PHASE6E_SHA256={0}|{1}" -f (Split-Path $_.Path -Leaf), $_.Hash)
}

Push-Location $ProjectRoot
try {
  Write-Host "PHASE6E_BUILD_START"
  & pnpm --filter @xauusd/risk-engine build
  if ($LASTEXITCODE -ne 0) { throw "Phase 6E risk-engine build failed with exit code $LASTEXITCODE" }
  Write-Host "PHASE6E_BUILD_STATUS=PASS"
  Write-Host "PHASE6E_REPLAY_START"
  & pnpm exec tsx $Driver 2>&1 | Tee-Object -FilePath $consoleLog | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "PHASE6E_REPLAY_STATUS=FAIL"
    Get-Content $consoleLog -Tail 120
    throw "Phase 6E historical blind replay failed with exit code $LASTEXITCODE"
  }
}
finally { Pop-Location }

Write-Host "PHASE6E_REPLAY_STATUS=PASS"
if (-not (Test-Path $auditCsv)) { throw "Phase 6E trade audit CSV was not created." }
Copy-Item $auditCsv $latestAuditCsv -Force
Write-Host "PHASE6E_LOG=$consoleLog"
Write-Host "PHASE6E_TRADE_AUDIT=$auditCsv"
Write-Host "PHASE6E_TRADE_AUDIT_LATEST=$latestAuditCsv"
Write-Host "PHASE6E_RESULT_BEGIN"
Select-String -Path $consoleLog -Pattern "^PHASE6E_" | ForEach-Object { $_.Line }
Write-Host "PHASE6E_RESULT_END"
Write-Host "PHASE6E_RUN_STATUS=PASS"
Write-Host "PHASE6E_PRODUCTION_MUTATION=false"