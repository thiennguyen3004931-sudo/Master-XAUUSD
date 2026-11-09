param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [decimal]$FixedVolume = 0.03,
  [string]$DataDir = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$Driver = Join-Path $PSScriptRoot "run-phase7b-fvg-ab-comparison.ts"

if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $latest = Get-ChildItem (Join-Path $WorkDir "phase6e-historical-runs") -Directory -ErrorAction SilentlyContinue |
    Where-Object {
      (Test-Path (Join-Path $_.FullName "phase6e-blind-m15.json")) -and
      (Test-Path (Join-Path $_.FullName "phase6e-blind-m5.json")) -and
      (Test-Path (Join-Path $_.FullName "phase6e-blind-meta.json"))
    } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $latest) {
    throw "No completed Phase 6E historical dataset found. Pass -DataDir explicitly."
  }
  $DataDir = $latest.FullName
}
$DataDir = (Resolve-Path $DataDir).Path

$m15 = Join-Path $DataDir "phase6e-blind-m15.json"
$m5 = Join-Path $DataDir "phase6e-blind-m5.json"
$meta = Join-Path $DataDir "phase6e-blind-meta.json"
foreach ($required in @($Driver, $m15, $m5, $meta)) {
  if (-not (Test-Path $required)) { throw "Required Phase 7B FVG A/B input missing: $required" }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $WorkDir "phase7b-fvg-ab-runs\$stamp"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$consoleLog = Join-Path $runDir "phase7b-fvg-ab-console.log"
$summaryCsv = Join-Path $runDir "phase7b-fvg-ab-summary.csv"
$summaryJson = Join-Path $runDir "phase7b-fvg-ab-summary.json"
$currentTrades = Join-Path $runDir "phase7b-current-fvg-optional-trades.csv"
$previousTrades = Join-Path $runDir "phase7b-previous-fvg-mandatory-trades.csv"
$latestCsv = Join-Path $WorkDir "phase7b-fvg-ab-summary-latest.csv"
$latestJson = Join-Path $WorkDir "phase7b-fvg-ab-summary-latest.json"

$env:ZIQ_M15_JSON = $m15
$env:ZIQ_M5_JSON = $m5
$env:ZIQ_META_JSON = $meta
$env:ZIQ_FIXED_VOLUME = [string]$FixedVolume
$env:ZIQ_PHASE7B_FVG_AB_SUMMARY_CSV = $summaryCsv
$env:ZIQ_PHASE7B_FVG_AB_SUMMARY_JSON = $summaryJson
$env:ZIQ_PHASE7B_FVG_AB_CURRENT_TRADES_CSV = $currentTrades
$env:ZIQ_PHASE7B_FVG_AB_PREVIOUS_TRADES_CSV = $previousTrades

Write-Host "PHASE7B_FVG_AB_RUN_DIR=$runDir"
Write-Host "PHASE7B_FVG_AB_DATA_DIR=$DataDir"
Write-Host "PHASE7B_FVG_AB_FIXED_VOLUME=$FixedVolume"
Write-Host "PHASE7B_FVG_AB_ISOLATED_VARIABLE=FVG_ENTRY_GATE_ONLY"
Write-Host "PHASE7B_FVG_AB_CURRENT=PATTERN_PLUS_MA_FVG_OPTIONAL"
Write-Host "PHASE7B_FVG_AB_PREVIOUS=PATTERN_PLUS_MA_PLUS_MANDATORY_FVG"
Write-Host "PHASE7B_FVG_AB_TWO_CANDLE_RULE=REFINED_CURRENT_RULE_BOTH_ARMS"
Write-Host "PHASE7B_FVG_AB_MAX_MANAGED_POSITIONS=1"
Write-Host "PHASE7B_FVG_AB_RISK_CAP=OFF"
Write-Host "PHASE7B_FVG_AB_RESEARCH_ONLY=YES"
if ([math]::Abs([double]$FixedVolume - 0.03) -gt 0.000001) {
  Write-Host "PHASE7B_FVG_AB_VOLUME_COMPARABILITY=WARNING|REFERENCE=0.03|ACTUAL=$FixedVolume"
} else {
  Write-Host "PHASE7B_FVG_AB_VOLUME_COMPARABILITY=PASS"
}

Push-Location $ProjectRoot
try {
  Write-Host "PHASE7B_FVG_AB_BUILD_START"
  & pnpm --filter @xauusd/risk-engine build
  if ($LASTEXITCODE -ne 0) { throw "Phase 7B FVG A/B build failed with exit code $LASTEXITCODE" }
  Write-Host "PHASE7B_FVG_AB_BUILD_STATUS=PASS"

  Write-Host "PHASE7B_FVG_AB_REPLAY_START"
  & pnpm exec tsx $Driver 2>&1 | Tee-Object -FilePath $consoleLog
  if ($LASTEXITCODE -ne 0) { throw "Phase 7B FVG A/B replay failed with exit code $LASTEXITCODE" }
}
finally {
  Pop-Location
}

Copy-Item $summaryCsv $latestCsv -Force
Copy-Item $summaryJson $latestJson -Force

Write-Host "PHASE7B_FVG_AB_REPLAY_STATUS=PASS"
Write-Host "PHASE7B_FVG_AB_LOG=$consoleLog"
Write-Host "PHASE7B_FVG_AB_SUMMARY_CSV_LATEST=$latestCsv"
Write-Host "PHASE7B_FVG_AB_SUMMARY_JSON_LATEST=$latestJson"
Write-Host "PHASE7B_FVG_AB_CURRENT_TRADES=$currentTrades"
Write-Host "PHASE7B_FVG_AB_PREVIOUS_TRADES=$previousTrades"
Write-Host "PHASE7B_FVG_AB_RUN_STATUS=PASS"
Write-Host "PHASE7B_FVG_AB_PRODUCTION_MUTATION=false"
