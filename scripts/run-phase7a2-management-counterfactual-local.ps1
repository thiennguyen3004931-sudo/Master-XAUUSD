param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [decimal]$FixedVolume = 0.03,
  [string]$DataDir = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$Driver = Join-Path $PSScriptRoot "run-phase7a2-management-counterfactual.ts"

if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $latest = Get-ChildItem (Join-Path $WorkDir "phase6e-historical-runs") -Directory -ErrorAction SilentlyContinue |
    Where-Object {
      (Test-Path (Join-Path $_.FullName "phase6e-blind-m15.json")) -and
      (Test-Path (Join-Path $_.FullName "phase6e-blind-m5.json")) -and
      (Test-Path (Join-Path $_.FullName "phase6e-blind-meta.json"))
    } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $latest) { throw "No completed Phase 6E historical dataset found. Pass -DataDir explicitly." }
  $DataDir = $latest.FullName
}
$DataDir = (Resolve-Path $DataDir).Path

$m15 = Join-Path $DataDir "phase6e-blind-m15.json"
$m5 = Join-Path $DataDir "phase6e-blind-m5.json"
$meta = Join-Path $DataDir "phase6e-blind-meta.json"
foreach ($required in @($Driver, $m15, $m5, $meta)) {
  if (-not (Test-Path $required)) { throw "Required Phase 7A2 input missing: $required" }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $WorkDir "phase7a2-management-runs\$stamp"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$consoleLog = Join-Path $runDir "phase7a2-console.log"

$env:ZIQ_M15_JSON = $m15
$env:ZIQ_M5_JSON = $m5
$env:ZIQ_META_JSON = $meta
$env:ZIQ_FIXED_VOLUME = [string]$FixedVolume

Write-Host "PHASE7A2_RUN_DIR=$runDir"
Write-Host "PHASE7A2_DATA_DIR=$DataDir"
Write-Host "PHASE7A2_FIXED_VOLUME=$FixedVolume"
if ([math]::Abs([double]$FixedVolume - 0.03) -gt 0.000001) {
  Write-Host "PHASE7A2_VOLUME_COMPARABILITY=WARNING|BASELINE=0.03|ACTUAL=$FixedVolume"
} else {
  Write-Host "PHASE7A2_VOLUME_COMPARABILITY=PASS"
}
Write-Host "PHASE7A2_MODE=MANAGEMENT_COUNTERFACTUAL_ONLY"

Push-Location $ProjectRoot
try {
  Write-Host "PHASE7A2_BUILD_START"
  & pnpm --filter @xauusd/risk-engine build
  if ($LASTEXITCODE -ne 0) { throw "Phase 7A2 build failed with exit code $LASTEXITCODE" }
  Write-Host "PHASE7A2_BUILD_STATUS=PASS"

  Write-Host "PHASE7A2_REPLAY_START"
  & pnpm exec tsx $Driver 2>&1 | Tee-Object -FilePath $consoleLog
  if ($LASTEXITCODE -ne 0) { throw "Phase 7A2 diagnostics failed with exit code $LASTEXITCODE" }
}
finally { Pop-Location }

Write-Host "PHASE7A2_REPLAY_STATUS=PASS"
Write-Host "PHASE7A2_LOG=$consoleLog"
Write-Host "PHASE7A2_RUN_STATUS=PASS"
Write-Host "PHASE7A2_STRATEGY_MUTATION=false"
Write-Host "PHASE7A2_PRODUCTION_MUTATION=false"
