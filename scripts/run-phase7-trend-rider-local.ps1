param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [decimal]$FixedVolume = 0.03,
  [string]$DataDir = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$Driver = Join-Path $PSScriptRoot "run-phase7-trend-rider.ts"

if ($FixedVolume -le 0) {
  throw "Phase 7 FixedVolume must be > 0."
}

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
  if (-not (Test-Path $required)) { throw "Required Phase 7 input missing: $required" }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $WorkDir "phase7-research-runs\$stamp"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$consoleLog = Join-Path $runDir "phase7-console.log"

$env:ZIQ_M15_JSON = $m15
$env:ZIQ_M5_JSON = $m5
$env:ZIQ_META_JSON = $meta
$env:ZIQ_FIXED_VOLUME = [string]$FixedVolume

Write-Host "PHASE7_RUN_DIR=$runDir"
Write-Host "PHASE7_DATA_DIR=$DataDir"
Write-Host "PHASE7_FIXED_VOLUME=$FixedVolume"
Write-Host "PHASE7_RISK_CAP=OFF"
Write-Host "PHASE7_VALIDATION_STATUS=RESEARCH_REPLAY_NOT_INDEPENDENT_HOLDOUT"

Push-Location $ProjectRoot
try {
  Write-Host "PHASE7_BUILD_START"
  & pnpm --filter @xauusd/risk-engine build
  if ($LASTEXITCODE -ne 0) { throw "Phase 7 build failed with exit code $LASTEXITCODE" }
  Write-Host "PHASE7_BUILD_STATUS=PASS"

  Write-Host "PHASE7_REPLAY_START"
  & pnpm exec tsx $Driver 2>&1 | Tee-Object -FilePath $consoleLog
  if ($LASTEXITCODE -ne 0) { throw "Phase 7 replay failed with exit code $LASTEXITCODE" }
}
finally { Pop-Location }

Write-Host "PHASE7_REPLAY_STATUS=PASS"
Write-Host "PHASE7_LOG=$consoleLog"
Write-Host "PHASE7_RUN_STATUS=PASS"
Write-Host "PHASE7_PRODUCTION_MUTATION=false"
