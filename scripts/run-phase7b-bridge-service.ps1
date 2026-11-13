param(
  [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BridgeDir = Join-Path $ProjectRoot "packages\mt5-broker\bridge"

if ([string]::IsNullOrWhiteSpace($EnvFile)) {
  $EnvFile = Join-Path $BridgeDir ".env.phase7b-demo"
}
if (-not (Test-Path $EnvFile)) {
  throw "Phase 7B bridge env not found: $EnvFile"
}
$EnvFile = (Resolve-Path $EnvFile).Path

$Python = Join-Path $BridgeDir ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
  throw "Bridge virtualenv is missing. Run packages\mt5-broker\bridge\run.ps1 once before installing autostart."
}

Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
  $parts = $line -split "=", 2
  $name = $parts[0].Trim().TrimStart([char]0xFEFF)
  $value = $parts[1].Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

if ($env:MT5_ALLOW_REAL_ACCOUNT -match '^(?i:true|1|yes|on)$') {
  throw "Phase 7B bridge service refuses MT5_ALLOW_REAL_ACCOUNT=true."
}
if ([string]::IsNullOrWhiteSpace($env:MT5_API_KEY) -or $env:MT5_API_KEY.Length -lt 16) {
  throw "Phase 7B bridge service requires a valid MT5_API_KEY."
}
if ([string]::IsNullOrWhiteSpace($env:MT5_BRIDGE_HOST)) { $env:MT5_BRIDGE_HOST = "127.0.0.1" }
if ([string]::IsNullOrWhiteSpace($env:MT5_BRIDGE_PORT)) { $env:MT5_BRIDGE_PORT = "8765" }

$bridgeBase = "http://$($env:MT5_BRIDGE_HOST):$($env:MT5_BRIDGE_PORT)"
try {
  $existing = Invoke-RestMethod -Uri "$bridgeBase/health" -Headers @{ "x-mt5-api-key" = $env:MT5_API_KEY } -Method Get -TimeoutSec 3
  if ($null -ne $existing) {
    Write-Host "PHASE7B_BRIDGE_SERVICE=ALREADY_RUNNING"
    Write-Host "PHASE7B_BRIDGE_EXISTING_ACCOUNT_MODE=$($existing.accountMode)"
    exit 0
  }
} catch {}

Write-Host "PHASE7B_BRIDGE_SERVICE=STARTING"
Write-Host "PHASE7B_BRIDGE_ENV=$EnvFile"
Write-Host "PHASE7B_BRIDGE_BIND=$($env:MT5_BRIDGE_HOST):$($env:MT5_BRIDGE_PORT)"
Write-Host "PHASE7B_BRIDGE_REAL_ACCOUNT_ALLOWED=false"

Push-Location $BridgeDir
try {
  & $Python -m uvicorn mt5_bridge.app:app --host $env:MT5_BRIDGE_HOST --port $env:MT5_BRIDGE_PORT
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Phase 7B bridge exited with code $exitCode"
  }
}
finally {
  Pop-Location
}
