param(
  [Parameter(Mandatory = $true)]
  [string]$WorkDir,

  [decimal]$MaxRiskUsd = 10,
  [string]$FrozenDir = ""
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$Driver = Join-Path $PSScriptRoot "run-phase6a-diagnostics.ts"

if (-not (Test-Path $Driver)) {
  throw "Phase 6A standalone driver not found: $Driver"
}

if ([string]::IsNullOrWhiteSpace($FrozenDir)) {
  $latestFrozen = Get-ChildItem $WorkDir -Directory -Filter "frozen-*" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $latestFrozen) {
    throw "No frozen Phase 4 dataset found under $WorkDir."
  }
  $FrozenDir = $latestFrozen.FullName
}
$FrozenDir = (Resolve-Path $FrozenDir).Path

$m15 = Join-Path $FrozenDir "phase4-m15.json"
$m5 = Join-Path $FrozenDir "phase4-m5.json"
$meta = Join-Path $FrozenDir "phase4-meta.json"
foreach ($required in @($m15, $m5, $meta)) {
  if (-not (Test-Path $required)) {
    throw "Required frozen Phase 6A input not found: $required"
  }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $WorkDir "phase6a-diagnostics\$stamp"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$consoleLog = Join-Path $runDir "phase6a-console.log"

$env:ZIQ_M15_JSON = $m15
$env:ZIQ_M5_JSON = $m5
$env:ZIQ_META_JSON = $meta
$env:ZIQ_MAX_RISK_USD = [string]$MaxRiskUsd

Write-Host "PHASE6A_RUN_DIR=$runDir"
Write-Host "PHASE6A_FROZEN_DIR=$FrozenDir"
Write-Host "PHASE6A_MAX_RISK_USD=$MaxRiskUsd"
Write-Host "PHASE6A_DRIVER=STANDALONE"

Push-Location $ProjectRoot
try {
  Write-Host "PHASE6A_BUILD_START"
  & pnpm --filter @xauusd/risk-engine build
  if ($LASTEXITCODE -ne 0) {
    throw "Phase 6A risk-engine build failed with exit code $LASTEXITCODE"
  }
  Write-Host "PHASE6A_BUILD_STATUS=PASS"

  Write-Host "PHASE6A_REPLAY_START"
  & pnpm exec tsx $Driver 2>&1 | Tee-Object -FilePath $consoleLog | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "PHASE6A_REPLAY_STATUS=FAIL"
    Write-Host "PHASE6A_LOG=$consoleLog"
    Get-Content $consoleLog -Tail 80
    throw "Phase 6A diagnostics failed with exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

Write-Host "PHASE6A_REPLAY_STATUS=PASS"
Write-Host "PHASE6A_LOG=$consoleLog"
Write-Host "PHASE6A_RESULT_BEGIN"
$lines = Select-String -Path $consoleLog -Pattern "^PHASE6A_" | ForEach-Object { $_.Line }
if ($lines.Count -eq 0) {
  throw "Phase 6A completed but emitted no PHASE6A_* lines."
}
$lines | ForEach-Object { Write-Host $_ }
Write-Host "PHASE6A_RESULT_END"
Write-Host "PHASE6A_STATUS=PASS"
