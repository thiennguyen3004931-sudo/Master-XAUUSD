param(
  [string]$EnvFile = ".env.phase7b-telegram",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [int]$IntervalSeconds = 2
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Controller = Join-Path $PSScriptRoot "run-phase7c-telegram-mode-controller.mjs"

if (-not [System.IO.Path]::IsPathRooted($EnvFile)) {
  $EnvFile = Join-Path $ProjectRoot $EnvFile
}
if (-not (Test-Path $EnvFile)) {
  throw "Telegram env file not found: $EnvFile"
}
if (-not (Test-Path $Controller)) {
  throw "Phase 7C Telegram mode controller not found: $Controller"
}

foreach ($raw in Get-Content $EnvFile) {
  $line = $raw.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
  $index = $line.IndexOf("=")
  $name = $line.Substring(0, $index).Trim().TrimStart([char]0xFEFF)
  $value = $line.Substring($index + 1).Trim().Trim('"').Trim("'")
  [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
}

if ([string]::IsNullOrWhiteSpace($env:ZIQ_TELEGRAM_BOT_TOKEN)) {
  throw "ZIQ_TELEGRAM_BOT_TOKEN is missing in $EnvFile"
}
if ([string]::IsNullOrWhiteSpace($env:ZIQ_TELEGRAM_CHAT_ID)) {
  throw "ZIQ_TELEGRAM_CHAT_ID is missing in $EnvFile"
}

$env:ZIQ_PHASE7C_CONTROL_API_URL = $ControlApiUrl.TrimEnd('/')
$env:ZIQ_PHASE7C_CONTROL_INTERVAL_MS = [string]([Math]::Max(1, $IntervalSeconds) * 1000)

Write-Host "PHASE7C_TELEGRAM_MODE_CONTROLLER=STARTING"
Write-Host "PHASE7C_TELEGRAM_ENV=$EnvFile"
Write-Host "PHASE7C_CONTROL_API=$($env:ZIQ_PHASE7C_CONTROL_API_URL)"
Write-Host "PHASE7C_CONTROL_INTERVAL_SECONDS=$IntervalSeconds"
Write-Host "PHASE7C_MT5_ORDER_PERMISSION=NONE"

Push-Location $ProjectRoot
try {
  node $Controller
  if ($LASTEXITCODE -ne 0) {
    throw "Phase 7C Telegram mode controller exited with code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}
