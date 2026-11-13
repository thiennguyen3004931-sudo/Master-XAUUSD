$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$files = @{
  service = Join-Path $ProjectRoot "apps\api\src\services\phase7c-account-switch.service.ts"
  route = Join-Path $ProjectRoot "apps\api\src\routes\phase7c-account-switch.route.ts"
  telemetryService = Join-Path $ProjectRoot "apps\api\src\services\mt5.service.ts"
  webApi = Join-Path $ProjectRoot "apps\web\src\phase7c-account-switch-api.ts"
  webTypes = Join-Path $ProjectRoot "apps\web\src\phase7c-account-switch-types.ts"
  telemetryTypes = Join-Path $ProjectRoot "apps\web\src\types.ts"
  helper = Join-Path $ProjectRoot "apps\web\src\phase7c-account-switch.ts"
  card = Join-Path $ProjectRoot "apps\web\src\ui\Phase7CAccountSwitchCard.tsx"
  accountRisk = Join-Path $ProjectRoot "apps\web\src\pages\Phase7CAccountRiskPage.tsx"
  controlCenterShell = Join-Path $ProjectRoot "apps\web\src\pages\Phase7CControlCenterShellPage.tsx"
}

function Assert-Literal([string]$Source, [string]$Text, [string]$Label) {
  if ($Source.IndexOf($Text, [System.StringComparison]::Ordinal) -lt 0) {
    throw "Missing MT5 account-switch literal: $Label"
  }
}
function Assert-Contains([string]$Source, [string]$Pattern, [string]$Label) {
  if ($Source -notmatch $Pattern) { throw "Missing MT5 account-switch marker: $Label" }
}
function Assert-NotContains([string]$Source, [string]$Pattern, [string]$Label) {
  if ($Source -match $Pattern) { throw "Forbidden MT5 account-switch pattern: $Label" }
}

foreach ($entry in $files.GetEnumerator()) {
  if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) {
    throw "Missing MT5 account-switch source: $($entry.Key) $($entry.Value)"
  }
}

$service = Get-Content -LiteralPath $files.service -Raw
$route = Get-Content -LiteralPath $files.route -Raw
$telemetryService = Get-Content -LiteralPath $files.telemetryService -Raw
$webApi = Get-Content -LiteralPath $files.webApi -Raw
$webTypes = Get-Content -LiteralPath $files.webTypes -Raw
$telemetryTypes = Get-Content -LiteralPath $files.telemetryTypes -Raw
$helper = Get-Content -LiteralPath $files.helper -Raw
$card = Get-Content -LiteralPath $files.card -Raw
$accountRisk = Get-Content -LiteralPath $files.accountRisk -Raw
$controlCenterShell = Get-Content -LiteralPath $files.controlCenterShell -Raw

# Canonical DEMO <-> LIVE account switching stays on the existing guarded service.
Assert-Literal $route 'router.get("/capability"' 'capability endpoint'
Assert-Literal $route 'router.post("/preflight"' 'preflight endpoint'
Assert-Literal $route 'router.post("/execute"' 'execute endpoint'
Assert-Literal $route 'router.get("/status"' 'status endpoint'
Assert-Literal $service 'finalBotMode: "PAUSE"' 'switch final mode policy'
Assert-Literal $service 'finalLiveArmStatus: "DISARMED"' 'switch final LIVE ARM policy'
Assert-Literal $service 'armAfterLiveSwitch: false' 'no automatic ARM after switch'

# Same-mode login preparation remains read-only and guarded.
Assert-Literal $service 'getPhase7CSameModeAccountChangeReadiness' 'same-mode readiness service'
Assert-Literal $route 'router.get("/same-mode-readiness"' 'same-mode readiness GET route'
Assert-Literal $service 'noTrendManagedTicket' 'same-mode Trend managed guard'
Assert-Literal $service 'noSidewayManagedTicket' 'same-mode Sideway managed guard'
Assert-Literal $service 'noTrendPendingPullback' 'same-mode Trend pending guard'
Assert-Literal $service 'noSidewayPendingEntry' 'same-mode Sideway pending guard'
Assert-Literal $service 'noExecutionLock' 'same-mode execution lock guard'
Assert-Literal $service 'liveDisarmed' 'same-mode LIVE DISARM guard'

# LIVE A -> LIVE B is detect-only until a separate canonical profile-rebind workflow exists.
# Bridge login change alone must never become a verified LIVE account.
Assert-Literal $helper 'liveSameModeVerificationRequiresCanonicalProfile: true' 'LIVE verification policy'
Assert-Literal $helper 'getSameModeMt5AccountVerificationState' 'verification state classifier'
Assert-Literal $helper 'IDENTITY_CHANGED_BUT_CANONICAL_PROFILE_UNVERIFIED' 'unverified identity state'
Assert-Literal $helper 'if (baseline.accountMode === "LIVE")' 'LIVE detect-only branch'
Assert-Literal $helper 'getSameModeMt5AccountVerificationState(input) === "VERIFIED"' 'verified boolean delegates to state classifier'
Assert-Literal $card 'IDENTITY_CHANGED_BUT_CANONICAL_PROFILE_UNVERIFIED' 'card unverified LIVE identity state'
Assert-Contains $card 'canonical profile|canonical.*profile' 'card canonical profile guidance'

# Telemetry exposes account login only as a sanitized top-level identity while nested
# health explicitly strips the login. Web types must follow that exact boundary.
Assert-Literal $telemetryService 'const { accountLogin: _accountLogin, ...safe } = health;' 'nested health strips account login'
Assert-Literal $telemetryService 'accountLogin: health.accountLogin ?? null' 'sanitized top-level account login'
Assert-Contains $telemetryTypes 'export interface Mt5TelemetrySnapshot\s*\{[\s\S]*?accountLogin\??:\s*number\s*\|\s*null' 'top-level telemetry accountLogin type'

# Web API is typed and centralised instead of duplicating raw account-switch fetches.
Assert-Literal $webApi 'getPhase7CAccountSwitchCapability' 'typed capability API'
Assert-Literal $webApi 'preflightPhase7CAccountSwitch' 'typed preflight API'
Assert-Literal $webApi 'executePhase7CAccountSwitch' 'typed execute API'
Assert-Literal $webApi 'getPhase7CAccountSwitchStatus' 'typed status API'
Assert-Literal $webApi 'getPhase7CSameModeAccountChangeReadiness' 'typed same-mode readiness API'
Assert-Literal $webTypes 'Phase7CAccountSwitchCapability' 'account-switch capability type'
Assert-Literal $webTypes 'Phase7CAccountSwitchPreflight' 'account-switch preflight type'
Assert-Literal $webTypes 'Phase7CSameModeAccountChangeReadiness' 'same-mode readiness type'

# Pure helper owns identity comparison and the no-credential/no-auto-reactivation policy.
Assert-Literal $helper 'captureMt5AccountIdentity' 'identity capture helper'
Assert-Literal $helper 'hasMt5AccountIdentityChanged' 'identity change helper'
Assert-Literal $helper 'isSameModeMt5AccountVerified' 'same-mode verification helper'
Assert-Literal $helper 'credentialInput: "NONE"' 'no credential input policy'
Assert-Literal $helper 'manualLoginInMt5: true' 'manual MT5 login policy'
Assert-Literal $helper 'autoArmAfterVerification: false' 'no auto ARM policy'
Assert-Literal $helper 'autoAutoAfterVerification: false' 'no auto AUTO policy'

# Account switching belongs to Account & Risk only; Control Center must not duplicate it.
Assert-Literal $accountRisk 'Phase7CAccountSwitchCard' 'Account & Risk account-switch import'
Assert-Literal $accountRisk '<Phase7CAccountSwitchCard />' 'Account & Risk account-switch render'
Assert-NotContains $controlCenterShell 'Phase7CAccountSwitchCard' 'Control Center duplicate account-switch card'
Assert-Literal $card 'getPhase7CSameModeAccountChangeReadiness' 'card same-mode readiness query'
Assert-Literal $card 'getMt5Telemetry' 'card MT5 identity polling'
Assert-Literal $card 'captureMt5AccountIdentity' 'card baseline identity capture'
Assert-Literal $card 'hasMt5AccountIdentityChanged' 'card account identity change detection'
Assert-Literal $card 'isSameModeMt5AccountVerified' 'card post-login verification'
Assert-Literal $card 'SAME_MODE_ACCOUNT_CHANGE_POLICY' 'card explicit same-mode policy'
Assert-Literal $card 'sameModeBaseline' 'card same-mode baseline state'
Assert-Literal $card 'sameModeVerified' 'card same-mode verified state'
Assert-NotContains $card '<TextField[\s\S]{0,500}type\s*=\s*["'']password["'']' 'password input must not exist'
Assert-NotContains $card 'name\s*=\s*["''](?:password|passwd|secret|apiKey)["'']' 'credential field must not exist'
Assert-NotContains $card 'autoArmAfterVerification:\s*true|autoAutoAfterVerification:\s*true' 'same-mode verification must not reactivate trading'

Write-Host "PHASE7C_WEB_MT5_ACCOUNT_SWITCH_SOURCE_TEST=PASS"