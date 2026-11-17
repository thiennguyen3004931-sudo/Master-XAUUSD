param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [ValidateRange(1, 240)] [int]$WaitMinutes = 15,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$DemoDir = Join-Path $WorkDir "phase7b-demo-forward"
$Controller = Join-Path $ProjectRoot "scripts\run-phase7b-demo-controller.ts"
$Hook = Join-Path $ProjectRoot "scripts\apply-phase7b-wait-pullback-demo-controller-hook.mjs"
$BridgeEnv = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo"

if (-not (Test-Path $Controller)) { throw "Phase 7B controller not found: $Controller" }
if (-not (Test-Path $Hook)) { throw "Phase 7B WAIT_PULLBACK hook not found: $Hook" }
if (-not (Test-Path $BridgeEnv)) { throw "Phase 7B DEMO bridge env not found: $BridgeEnv" }
New-Item -ItemType Directory -Force -Path $DemoDir | Out-Null

Write-Host "PHASE7B_WAIT_PULLBACK_UPGRADE=START"
Write-Host "PHASE7B_WAIT_PULLBACK_EXECUTION_MUTATION_DURING_UPGRADE=False"
Write-Host "PHASE7B_WAIT_PULLBACK_REAL_ACCOUNT_ALLOWED=False"
Write-Host "PHASE7B_WAIT_PULLBACK_WAIT_MINUTES=$WaitMinutes"

Push-Location $ProjectRoot
try {
  Write-Host "PHASE7B_WAIT_PULLBACK_PATCH=START"
  & node $Hook $Controller
  if ($LASTEXITCODE -ne 0) { throw "Phase 7B WAIT_PULLBACK patch failed with exit code $LASTEXITCODE" }
  Write-Host "PHASE7B_WAIT_PULLBACK_PATCH=PASS"

  if (-not $SkipBuild) {
    Write-Host "PHASE7B_WAIT_PULLBACK_BUILD=START"
    & pnpm --filter "@xauusd/risk-engine..." build
    if ($LASTEXITCODE -ne 0) { throw "Risk-engine dependency build failed with exit code $LASTEXITCODE" }
    & pnpm --filter @xauusd/risk-engine typecheck
    if ($LASTEXITCODE -ne 0) { throw "Risk-engine typecheck failed with exit code $LASTEXITCODE" }
    & pnpm --filter @xauusd/risk-engine test
    if ($LASTEXITCODE -ne 0) { throw "Risk-engine tests failed with exit code $LASTEXITCODE" }
    Write-Host "PHASE7B_WAIT_PULLBACK_BUILD=PASS"
  }

  $env:ZIQ_DEMO_WORK_DIR = $DemoDir
  $env:ZIQ_BRIDGE_ENV = $BridgeEnv
  $env:ZIQ_DEMO_ARMED = "false"
  $env:ZIQ_DEMO_ONCE = "true"
  $env:ZIQ_PHASE7B_PULLBACK_WAIT_MINUTES = "$WaitMinutes"

  Write-Host "PHASE7B_WAIT_PULLBACK_PREVIEW=START"
  & pnpm exec tsx scripts/run-phase7b-demo-controller.ts
  if ($LASTEXITCODE -ne 0) { throw "Phase 7B WAIT_PULLBACK unarmed preview failed with exit code $LASTEXITCODE" }
  Write-Host "PHASE7B_WAIT_PULLBACK_PREVIEW=PASS"
  Write-Host "PHASE7B_WAIT_PULLBACK_ORDER_SEND=DISABLED_NOT_ARMED"
  Write-Host "PHASE7B_WAIT_PULLBACK_UPGRADE=PASS"
} finally {
  Pop-Location
}
