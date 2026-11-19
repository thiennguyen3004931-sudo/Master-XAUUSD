$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Library = Join-Path $PSScriptRoot "lib\phase7c-core-endpoint-ownership.ps1"
$Cleanup = Join-Path $PSScriptRoot "clear-phase7c-project-core-ports-local.ps1"
$SafeActivation = Join-Path $PSScriptRoot "activate-phase7c-safe-local.ps1"

if (-not (Test-Path -LiteralPath $Library)) { throw "Missing ownership library: $Library" }
if (-not (Test-Path -LiteralPath $Cleanup)) { throw "Missing cleanup script: $Cleanup" }
if (-not (Test-Path -LiteralPath $SafeActivation)) { throw "Missing safe activation wrapper: $SafeActivation" }
. $Library

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw "ASSERT_TRUE failed: $Message" }
}

function Assert-False([bool]$Value, [string]$Message) {
  if ($Value) { throw "ASSERT_FALSE failed: $Message" }
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) {
    throw "ASSERT_EQUAL failed: $Message. Expected=$Expected Actual=$Actual"
  }
}

function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    $Path,
    [ref]$tokens,
    [ref]$errors
  )
  if (@($errors).Count -gt 0) {
    $messages = @($errors | ForEach-Object { $_.Message }) -join " | "
    throw "PowerShell syntax errors in ${Path}: $messages"
  }
}

$goodMode = [pscustomobject]@{
  state = [pscustomobject]@{ mode = "AUTO" }
  options = @("AUTO", "TREND", "SIDEWAY", "PAUSE")
}
Assert-True (Test-Phase7CModePayload $goodMode) "canonical bot-mode payload must be recognized"

$missingPause = [pscustomobject]@{
  state = [pscustomobject]@{ mode = "AUTO" }
  options = @("AUTO", "TREND", "SIDEWAY")
}
Assert-False (Test-Phase7CModePayload $missingPause) "partial mode payload must not prove ownership"
Assert-False (Test-Phase7CModePayload ([pscustomobject]@{ status = "ok" })) "generic JSON must not prove API ownership"

$goodLot = [pscustomobject]@{
  state = [pscustomobject]@{
    trendFixedLot = 0.12
    sidewayRiskPercent = 1
    sidewayMaxLot = 0.30
  }
}
Assert-True (Test-Phase7CLotSettingsPayload $goodLot) "valid Phase7C lot payload must be recognized"

$badLot = [pscustomobject]@{
  state = [pscustomobject]@{
    trendFixedLot = 0.12
    sidewayRiskPercent = 5
    sidewayMaxLot = 0.30
  }
}
Assert-False (Test-Phase7CLotSettingsPayload $badLot) "out-of-policy lot payload must not prove ownership"

$demoBridge = [pscustomobject]@{
  status = "ok"
  connected = $true
  accountMode = "demo"
}
Assert-True (Test-Phase7CBridgeHealthPayload $demoBridge) "DEMO bridge health shape must be recognized"

$liveBridge = [pscustomobject]@{
  status = "ok"
  connected = $true
  accountMode = "live"
}
Assert-False (Test-Phase7CBridgeHealthPayload $liveBridge) "LIVE bridge must never authorize cleanup fallback"
Assert-False (Test-Phase7CBridgeHealthPayload ([pscustomobject]@{ status = "ok" })) "generic health JSON must not prove bridge ownership"

$goodWebSource = @"
import { Phase7CControlCenterPage } from './pages/Phase7CControlCenterPage';
import { Phase7BOpsPage } from './pages/Phase7BOpsPage';
const routes = ['phase7c-control-center', 'phase7b-pattern-check'];
"@
Assert-True (Test-Phase7CWebSource $goodWebSource) "project-specific Vite router source must be recognized"
Assert-False (Test-Phase7CWebSource "<html><div id='root'></div></html>") "generic Vite/React page must not prove web ownership"

Assert-Equal (Resolve-Phase7CEndpointFallbackPid -ListenerPid 4242 -EndpointOwned $true) 4242 "owned endpoint may authorize exact listener only"
Assert-Equal (Resolve-Phase7CEndpointFallbackPid -ListenerPid 4242 -EndpointOwned $false) 0 "unproven endpoint must not authorize a kill"
Assert-Equal (Resolve-Phase7CEndpointFallbackPid -ListenerPid 0 -EndpointOwned $true) 0 "invalid PID must fail closed"

Assert-PowerShellSyntax $Library
Assert-PowerShellSyntax $Cleanup
Assert-PowerShellSyntax $SafeActivation
Assert-PowerShellSyntax (Join-Path $PSScriptRoot "activate-phase7c-local.ps1")

$cleanupText = Get-Content -LiteralPath $Cleanup -Raw
Assert-True ($cleanupText -match 'SCOPE=LISTENER_ONLY') "cleanup must log listener-only fallback scope"
Assert-True ($cleanupText -match 'ACTION=KEEP') "cleanup must preserve unproven listeners"
Assert-True ($cleanupText -match 'refused to kill one or more unproven listeners') "cleanup must fail closed when ownership cannot be proven"

$safeActivationText = Get-Content -LiteralPath $SafeActivation -Raw
Assert-True ($safeActivationText -match 'safe-activation-entry-freeze') "safe activation must freeze entries before cleanup"
Assert-True ($safeActivationText -match 'Stop-ExecutorTaskIfRunning') "safe activation must stop an existing task-managed runner before cleanup"
Assert-True ($safeActivationText -match 'PHASE7C_SAFE_ACTIVATE_TASK_HANDOFF=PASS') "safe activation must restore task-managed ownership after armed recovery"
Assert-True ($safeActivationText -match 'PHASE7C_SAFE_ACTIVATE_FINAL_MODE=PAUSE') "safe activation must finish fail-closed in PAUSE"
Assert-True ($safeActivationText -match 'PSBoundParameters.ContainsKey\("TrendFixedVolume"\)') "safe activation must not overwrite saved trend lot with wrapper defaults"
Assert-True ($safeActivationText -match 'PSBoundParameters.ContainsKey\("SidewayRiskPercent"\)') "safe activation must not overwrite saved sideway risk with wrapper defaults"
Assert-True ($safeActivationText -match 'PSBoundParameters.ContainsKey\("SidewayMaxLot"\)') "safe activation must not overwrite saved sideway max lot with wrapper defaults"

Write-Host "PHASE7C_STALE_PORT_OWNERSHIP_TEST=PASS"
