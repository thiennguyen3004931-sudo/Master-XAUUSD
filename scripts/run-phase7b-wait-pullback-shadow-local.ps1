param(
  [ValidateRange(1, 240)] [int]$WaitMinutes = 60,
  [ValidateRange(1, 60)] [int]$IntervalSeconds = 5,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BridgeEnv = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo"
$WorkDir = Join-Path $ProjectRoot ".runtime\phase7b-wait-pullback-shadow"

if (-not (Test-Path $BridgeEnv)) {
  throw "Phase 7B DEMO bridge env not found: $BridgeEnv"
}

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

$env:ZIQ_DEMO_WORK_DIR = $WorkDir
$env:ZIQ_BRIDGE_ENV = $BridgeEnv
$env:ZIQ_PHASE7B_PULLBACK_WAIT_MINUTES = "$WaitMinutes"
$env:ZIQ_PHASE7B_SHADOW_INTERVAL_SECONDS = "$IntervalSeconds"

Write-Host "PHASE7B_WAIT_PULLBACK_SHADOW_LAUNCH=READ_ONLY"
Write-Host "PHASE7B_WAIT_PULLBACK_EXECUTION_MUTATION=False"
Write-Host "PHASE7B_WAIT_PULLBACK_REAL_ACCOUNT_ALLOWED=False"
Write-Host "PHASE7B_WAIT_PULLBACK_WAIT_MINUTES=$WaitMinutes"
Write-Host "PHASE7B_WAIT_PULLBACK_INTERVAL_SECONDS=$IntervalSeconds"
Write-Host "PHASE7B_WAIT_PULLBACK_WORK_DIR=$WorkDir"

Push-Location $ProjectRoot
try {
  if (-not $SkipBuild) {
    Write-Host "PHASE7B_WAIT_PULLBACK_BUILD=START"
    & pnpm --filter "@xauusd/risk-engine..." build
    if ($LASTEXITCODE -ne 0) {
      throw "Phase 7B risk-engine dependency build failed with exit code $LASTEXITCODE"
    }
    Write-Host "PHASE7B_WAIT_PULLBACK_BUILD=PASS"
  }

  Write-Host "PHASE7B_WAIT_PULLBACK_SHADOW_RUNTIME=START"
  & pnpm exec tsx scripts/run-phase7b-wait-pullback-shadow.ts
  if ($LASTEXITCODE -ne 0) {
    throw "Phase 7B wait-pullback shadow runtime failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
