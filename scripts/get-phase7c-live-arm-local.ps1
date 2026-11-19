param(
  [string]$WorkDir = ".runtime",
  [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
if (-not (Test-Path -LiteralPath $AccountLibrary)) { throw "Phase7C account-mode library not found: $AccountLibrary" }
. $AccountLibrary

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$statePath = Join-Path $WorkDir "phase7c-account-mode.json"
if (-not (Test-Path -LiteralPath $statePath)) { throw "Account-mode state not found: $statePath" }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$mode = ConvertTo-Phase7CAccountMode ([string]$state.accountMode)

if ([string]::IsNullOrWhiteSpace($EnvFile)) { $EnvFile = [string]$state.envFile }
if (-not [string]::IsNullOrWhiteSpace($EnvFile) -and -not [System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $ProjectRoot $EnvFile }

$arm = $null
try { $arm = Read-Phase7CLiveArmState -WorkDir $WorkDir } catch {}
$status = "DISARMED"
$reason = if ($null -eq $arm) { "ARM_FILE_MISSING" } else { "BRIDGE_CONFIRMATION_UNAVAILABLE" }
$accountLogin = "UNKNOWN"
$server = "UNKNOWN"
$bridgeSession = "UNKNOWN"

if (-not [string]::IsNullOrWhiteSpace($EnvFile) -and (Test-Path -LiteralPath $EnvFile)) {
  try {
    $envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode $mode
    $health = Invoke-RestMethod -Uri "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)/health" -Headers @{ "x-mt5-api-key" = $envInfo.apiKey } -Method Get -TimeoutSec 5
    $status = [string]$health.liveArmStatus
    if ([string]::IsNullOrWhiteSpace($status)) { $status = "DISARMED" }
    $reason = [string]$health.liveArmReason
    $accountLogin = [string]$health.accountLogin
    $server = [string]$health.server
    $bridgeSession = [string]$health.bridgeSessionId
    Write-Host "PHASE7C_LIVE_ARM_BRIDGE_CONNECTED=$($health.connected)"
    Write-Host "PHASE7C_LIVE_ARM_CONFIGURED_MODE=$($health.configuredAccountMode)"
    Write-Host "PHASE7C_LIVE_ARM_BROKER_MODE=$($health.accountMode)"
  } catch {
    $reason = "BRIDGE_UNAVAILABLE"
  }
}

Write-Host "PHASE7C_LIVE_ARM_SELECTED_MODE=$mode"
Write-Host "PHASE7C_LIVE_ARM_ACCOUNT_LOGIN=$accountLogin"
Write-Host "PHASE7C_LIVE_ARM_SERVER=$server"
Write-Host "PHASE7C_LIVE_ARM_BRIDGE_SESSION=$bridgeSession"
Write-Host "PHASE7C_LIVE_ARM_STATUS=$status"
Write-Host "PHASE7C_LIVE_ARM_REASON=$reason"
