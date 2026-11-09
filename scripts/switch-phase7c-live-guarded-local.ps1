param(
  [string]$WorkDir = ".runtime",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [switch]$ConfirmLiveExecution
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Preflight = Join-Path $PSScriptRoot "preflight-phase7c-live-switch-local.ps1"
$Switcher = Join-Path $PSScriptRoot "switch-phase7c-account-mode-local.ps1"
$Recovery = Join-Path $PSScriptRoot "recover-phase7c-demo-after-failed-switch-local.ps1"
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"

foreach ($required in @($Preflight, $Switcher, $Recovery, $AccountLibrary)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Guarded LIVE switch required file not found: $required" }
}
if (-not $ConfirmLiveExecution) {
  throw "Explicit -ConfirmLiveExecution is required for guarded LIVE account switching."
}
. $AccountLibrary

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Guarded LIVE switch requires PowerShell Administrator."
}

Write-Host "PHASE7C_GUARDED_LIVE_SWITCH=START"
& $Preflight -WorkDir $WorkDir -ControlApiUrl $ControlApiUrl
if ($LASTEXITCODE -ne 0) { throw "LIVE switch preflight failed before runtime mutation." }
Write-Host "PHASE7C_GUARDED_LIVE_SWITCH_PREFLIGHT=PASS"

$switchError = $null
try {
  & $Switcher -TargetMode LIVE -WorkDir $WorkDir -ControlApiUrl $ControlApiUrl -ConfirmLiveExecution
  if ($LASTEXITCODE -ne 0) { throw "Underlying LIVE account switch returned exit code $LASTEXITCODE." }
} catch {
  $switchError = $_
}

if ($null -ne $switchError) {
  Write-Host "PHASE7C_GUARDED_LIVE_SWITCH_SWITCH=FAIL"
  Write-Host "PHASE7C_GUARDED_LIVE_SWITCH_RECOVERY=START"
  try {
    & $Recovery -WorkDir $WorkDir -ControlApiUrl $ControlApiUrl
    if ($LASTEXITCODE -ne 0) { throw "DEMO recovery returned exit code $LASTEXITCODE." }
    Write-Host "PHASE7C_GUARDED_LIVE_SWITCH_RECOVERY=PASS"
  } catch {
    Write-Host "PHASE7C_GUARDED_LIVE_SWITCH_RECOVERY=FAIL"
    throw "LIVE switch failed and deterministic DEMO recovery also failed. Original=$($switchError.Exception.Message) Recovery=$($_.Exception.Message)"
  }
  throw "LIVE switch failed; deterministic DEMO recovery completed successfully. Original=$($switchError.Exception.Message)"
}

$accountStatePath = Join-Path $WorkDir "phase7c-account-mode.json"
$state = Get-Content -LiteralPath $accountStatePath -Raw | ConvertFrom-Json
$bot = Invoke-RestMethod -Uri "$($ControlApiUrl.TrimEnd('/'))/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
$armPath = Get-Phase7CLiveArmPath $WorkDir
if ((ConvertTo-Phase7CAccountMode ([string]$state.accountMode)) -ne "LIVE") { throw "Guarded switch completed but selected account is not LIVE." }
if ([string]$bot.state.mode -ne "PAUSE") { throw "Guarded switch completed but bot is not PAUSE." }
if (Test-Path -LiteralPath $armPath) { throw "Guarded switch completed with an unexpected LIVE arm file." }

Write-Host "PHASE7C_GUARDED_LIVE_SWITCH_FINAL_ACCOUNT_MODE=LIVE"
Write-Host "PHASE7C_GUARDED_LIVE_SWITCH_FINAL_BOT_MODE=PAUSE"
Write-Host "PHASE7C_GUARDED_LIVE_SWITCH_LIVE_ARM=DISARMED"
Write-Host "PHASE7C_GUARDED_LIVE_SWITCH_STATUS=PASS"
Write-Host "PHASE7C_GUARDED_LIVE_SWITCH_NEXT=EXPLICIT_LIVE_ARM_APPROVAL_REQUIRED"
