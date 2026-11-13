param(
  [string]$WorkDir = ".runtime",
  [string]$RequiredCommit = "",
  [switch]$SkipPanelCompile
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WebDeploy = Join-Path $PSScriptRoot "deploy-phase7c-web-ui-local.ps1"
$PanelSync = Join-Path $PSScriptRoot "install-phase7c-mt5-decision-panel-both-accounts-local.ps1"
$Verifier = Join-Path $PSScriptRoot "verify-phase7c-account-runtime-local.ps1"

foreach ($required in @($WebDeploy, $PanelSync, $Verifier)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required Web/MT5 sync component missing: $required" }
}

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$AccountStatePath = Join-Path $WorkDir "phase7c-account-mode.json"
$ArmPath = Join-Path $WorkDir "phase7c-live-arm.json"
$ControlApi = "http://127.0.0.1:3711"

function Read-AccountState {
  if (-not (Test-Path -LiteralPath $AccountStatePath)) { throw "Account-mode state missing: $AccountStatePath" }
  return Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
}

Write-Host "PHASE7C_WEB_MT5_SYNC_DEPLOY=START"
$stateBefore = Read-AccountState
$modeBefore = Invoke-RestMethod -Uri "$ControlApi/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 10
$armBefore = Test-Path -LiteralPath $ArmPath
Write-Host "PHASE7C_WEB_MT5_SYNC_BEFORE_ACCOUNT=$($stateBefore.accountMode)"
Write-Host "PHASE7C_WEB_MT5_SYNC_BEFORE_BOT_MODE=$($modeBefore.state.mode)"
Write-Host "PHASE7C_WEB_MT5_SYNC_BEFORE_ARM_FILE=$armBefore"

$webArgs = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass",
  "-File", $WebDeploy,
  "-WorkDir", $WorkDir
)
if (-not [string]::IsNullOrWhiteSpace($RequiredCommit)) {
  $webArgs += @("-RequiredCommit", $RequiredCommit)
}
& powershell.exe @webArgs
if ($LASTEXITCODE -ne 0) { throw "Safe Web deploy failed with exit code $LASTEXITCODE" }
Write-Host "PHASE7C_WEB_MT5_SYNC_WEB=PASS"

$panelArgs = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass",
  "-File", $PanelSync
)
if ($SkipPanelCompile) { $panelArgs += "-SkipCompile" }
& powershell.exe @panelArgs
if ($LASTEXITCODE -ne 0) { throw "Dual-terminal MT5 panel sync failed with exit code $LASTEXITCODE" }
Write-Host "PHASE7C_WEB_MT5_SYNC_PANELS=PASS"

$stateAfter = Read-AccountState
$modeAfter = Invoke-RestMethod -Uri "$ControlApi/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 10
$armAfter = Test-Path -LiteralPath $ArmPath
if ([string]$stateAfter.accountMode -ne [string]$stateBefore.accountMode) {
  throw "Account mode changed during Web/MT5 sync. Before=$($stateBefore.accountMode) After=$($stateAfter.accountMode)"
}
if ([string]$modeAfter.state.mode -ne [string]$modeBefore.state.mode) {
  throw "Bot mode changed during Web/MT5 sync. Before=$($modeBefore.state.mode) After=$($modeAfter.state.mode)"
}
if ($armAfter -ne $armBefore) {
  throw "LIVE arm file presence changed during Web/MT5 sync. Before=$armBefore After=$armAfter"
}
Write-Host "PHASE7C_WEB_MT5_SYNC_RUNTIME_PRESERVED=PASS"

$ui = Invoke-WebRequest -Uri "$ControlApi/api/v1/phase7c-ui/mt5?symbol=XAUUSD" -UseBasicParsing -TimeoutSec 10
$content = [string]$ui.Content
foreach ($marker in @(
  "version=2",
  "accountMode=$($stateAfter.accountMode)",
  "autoReason1=",
  "trendWaitReason1=",
  "sidewayWaitReason1=",
  "entryReason1=",
  "holdReason1=",
  "stopMoveReason1=",
  "partialReason1=",
  "exitReason1=",
  "readOnly=true",
  "mt5OrderPermission=NONE"
)) {
  if ($content -notmatch [regex]::Escape($marker)) { throw "Synchronized Semantic UI marker missing: $marker" }
}
Write-Host "PHASE7C_WEB_MT5_SYNC_SEMANTIC_CONTRACT=PASS"

$expectedMode = ([string]$stateAfter.accountMode).ToUpperInvariant()
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Verifier `
  -WorkDir $WorkDir `
  -ExpectedAccountMode $expectedMode `
  -RequireTelegram
if ($LASTEXITCODE -ne 0) { throw "Strict runtime verify failed after Web/MT5 sync." }

Write-Host "PHASE7C_WEB_MT5_SYNC_DEPLOY=PASS"
Write-Host "PHASE7C_WEB_MT5_SYNC_ACCOUNT=$($stateAfter.accountMode)"
Write-Host "PHASE7C_WEB_MT5_SYNC_BOT_MODE=$($modeAfter.state.mode)"
Write-Host "PHASE7C_WEB_MT5_SYNC_ARM_FILE_PRESENT=$armAfter"
Write-Host "PHASE7C_WEB_MT5_SYNC_MT5_ORDER_PERMISSION=NONE"
Write-Host "PHASE7C_WEB_MT5_SYNC_STRATEGY_CHANGED=False"
Write-Host "PHASE7C_WEB_MT5_SYNC_RISK_CHANGED=False"
