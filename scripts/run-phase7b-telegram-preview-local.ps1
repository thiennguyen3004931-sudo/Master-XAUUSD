param(
  [string]$EnvFile = ".env.phase7b-telegram",
  [int]$DelayMilliseconds = 650
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Preview = Join-Path $PSScriptRoot "run-phase7b-telegram-preview.mjs"

if (-not [System.IO.Path]::IsPathRooted($EnvFile)) {
  $EnvFile = Join-Path $ProjectRoot $EnvFile
}
if (-not (Test-Path $EnvFile)) {
  throw "Telegram env file not found: $EnvFile"
}
if (-not (Test-Path $Preview)) {
  throw "Telegram preview script not found: $Preview"
}
if ($DelayMilliseconds -lt 250) { $DelayMilliseconds = 250 }

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

$env:ZIQ_TELEGRAM_PREVIEW_DELAY_MS = [string]$DelayMilliseconds

Write-Host "PHASE7B_TELEGRAM_PREVIEW_ENV=$EnvFile"
Write-Host "PHASE7B_TELEGRAM_PREVIEW_DELAY_MS=$DelayMilliseconds"
Write-Host "PHASE7B_TELEGRAM_PREVIEW_JOURNAL_MUTATION=false"
Write-Host "PHASE7B_TELEGRAM_PREVIEW_MT5_MUTATION=false"
Write-Host "PHASE7B_TELEGRAM_PREVIEW_SAFE=PASS"

Push-Location $ProjectRoot
try {
  & node $Preview
  if ($LASTEXITCODE -ne 0) {
    throw "Phase 7B Telegram preview exited with code $LASTEXITCODE"
  }
}
finally {
  Remove-Item Env:ZIQ_TELEGRAM_PREVIEW_DELAY_MS -ErrorAction SilentlyContinue
  Pop-Location
}
