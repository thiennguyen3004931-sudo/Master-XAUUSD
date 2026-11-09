$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DeployScript = Join-Path $PSScriptRoot "deploy-phase7c-sideway-runtime-local.ps1"

if (-not (Test-Path -LiteralPath $DeployScript -PathType Leaf)) {
  throw "Missing Sideway runtime deploy helper: $DeployScript"
}

$source = Get-Content -LiteralPath $DeployScript -Raw

function Assert-Contains([string]$Literal, [string]$Label) {
  if (-not $source.Contains($Literal)) {
    throw "Missing Sideway runtime deploy contract: $Label"
  }
}

function Assert-NotContains([string]$Literal, [string]$Label) {
  if ($source.Contains($Literal)) {
    throw "Forbidden Sideway runtime deploy behavior: $Label"
  }
}

function Assert-Before([string]$First, [string]$Second, [string]$Label) {
  $firstIndex = $source.IndexOf($First, [System.StringComparison]::Ordinal)
  $secondIndex = $source.IndexOf($Second, [System.StringComparison]::Ordinal)
  if ($firstIndex -lt 0 -or $secondIndex -lt 0 -or $firstIndex -ge $secondIndex) {
    throw "Invalid Sideway runtime deploy ordering: $Label"
  }
}

Assert-Contains '[string]$ExpectedCommit' 'mandatory exact SHA input'
Assert-Contains '^[0-9a-fA-F]{40}$' '40-character SHA validation'
Assert-Contains 'branch --show-current' 'branch guard'
Assert-Contains 'status --porcelain' 'clean-worktree guard'
Assert-Contains 'rev-parse HEAD' 'exact HEAD guard'
Assert-Contains 'main' 'main-only deploy guard'
Assert-Contains '/api/v1/phase7c/bot-mode' 'canonical bot-mode endpoint'
Assert-Contains 'mode = "PAUSE"' 'fail-safe PAUSE mutation'
Assert-Contains '/api/v1/phase7c-live-arm-control/capability' 'canonical LIVE ARM capability read'
Assert-Contains '/api/v1/phase7c-live-arm-control/preflight' 'canonical LIVE ARM preflight'
Assert-Contains '/api/v1/phase7c-live-arm-control/execute' 'canonical LIVE ARM execute'
Assert-Contains 'DISARM_LIVE' 'explicit LIVE disarm before executor restart'
Assert-Contains 'ARM_LIVE' 'explicit LIVE re-arm after executor restart'
Assert-Contains '/api/v1/phase7c/lifecycle/stop' 'canonical lifecycle STOP'
Assert-Contains '/api/v1/phase7c/lifecycle/start' 'canonical lifecycle START'
Assert-Contains '/v1/positions?symbol=XAUUSD' 'zero-position broker guard'
Assert-Contains '/v1/orders?symbol=XAUUSD' 'zero-pending-order broker guard'
Assert-Contains 'bridgeSessionId' 'bridge-session preservation contract'
Assert-Contains '$LifecycleBrokerRunner' 'lifecycle broker runner freshness input'
Assert-Contains '$LifecycleBrokerLibrary' 'lifecycle broker library freshness input'
Assert-Contains 'phase7c-lifecycle-broker\logs\broker.log' 'broker boot log freshness evidence'
Assert-Contains 'Lifecycle broker starting. PID=$brokerPid' 'broker boot PID marker'
Assert-Contains '[DateTimeOffset]::Parse' 'broker boot timestamp parsing'
Assert-Contains 'LastWriteTimeUtc' 'current lifecycle source timestamp'
Assert-Contains 'PHASE7C_SIDEWAY_RUNTIME_DEPLOY_BROKER_SOURCE_FRESH=PASS' 'broker freshness preflight marker'
Assert-Contains '[void](Assert-LifecycleBrokerSourceFresh -WorkDir $WorkDir)' 'broker freshness preflight invocation'
Assert-Before '[void](Assert-LifecycleBrokerSourceFresh -WorkDir $WorkDir)' '$mutationStarted = $false' 'broker source freshness must be proven before mutation scope begins'
Assert-Contains 'PHASE7C_SIDEWAY_RUNTIME_DEPLOY_FINAL_MODE=PAUSE' 'final PAUSE marker'
Assert-Contains 'PHASE7C_SIDEWAY_RUNTIME_DEPLOY_FINAL_ARM=ARMED' 'final ARMED marker'
Assert-Contains 'PHASE7C_SIDEWAY_RUNTIME_DEPLOY_LIVE_TEST_ORDER=NONE' 'no LIVE test order marker'
Assert-Contains 'PHASE7C_SIDEWAY_RUNTIME_DEPLOY_BRIDGE_RESTART=NONE' 'no Bridge restart marker'
Assert-NotContains 'Get-Process -Id $brokerPid' 'deploy helper must not require privileged process introspection for broker freshness'
Assert-NotContains 'mode = "AUTO"' 'deploy helper must not bypass Web-only AUTO provenance'
Assert-NotContains 'web-control-center' 'deploy helper must not spoof Web provenance'
Assert-NotContains '/v1/orders" -Method Post' 'deploy helper must not submit MT5 orders'

Write-Host "PHASE7C_SIDEWAY_RUNTIME_SAFE_DEPLOY_SOURCE=PASS"
