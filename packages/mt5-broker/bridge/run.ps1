param(
  [string]$EnvFile = ".env",
  [ValidateSet("DEMO", "LIVE")] [string]$AccountMode = "DEMO",
  [string]$LiveArmStatePath = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".venv")) {
  py -3 -m venv .venv
}

.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

if (-not (Test-Path $EnvFile)) {
  if ($EnvFile -eq ".env") {
    Copy-Item ".env.example" ".env"
    Write-Host "Created bridge/.env. Edit it before starting the bridge." -ForegroundColor Yellow
  } else {
    Write-Host "MT5 bridge env file not found: $EnvFile" -ForegroundColor Red
  }
  exit 1
}

Get-Content $EnvFile | ForEach-Object {
  $line = ([string]$_).Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
  $index = $line.IndexOf("=")
  $name = $line.Substring(0, $index).Trim().TrimStart([char]0xFEFF)
  $value = $line.Substring($index + 1).Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

# Account selection is supplied by the trusted Phase7C bridge runner, not by
# the local env file. Direct/legacy launches default to DEMO and therefore
# cannot accidentally authorize a REAL mutation.
[Environment]::SetEnvironmentVariable("MT5_ACCOUNT_MODE", $AccountMode.ToUpperInvariant(), 'Process')
if (-not [string]::IsNullOrWhiteSpace($LiveArmStatePath)) {
  [Environment]::SetEnvironmentVariable("MT5_LIVE_ARM_STATE_PATH", $LiveArmStatePath, 'Process')
} else {
  [Environment]::SetEnvironmentVariable("MT5_LIVE_ARM_STATE_PATH", "", 'Process')
}

Write-Host "MT5_BRIDGE_ENV_FILE=$EnvFile"
Write-Host "MT5_BRIDGE_ACCOUNT_MODE=$env:MT5_ACCOUNT_MODE"
Write-Host "MT5_BRIDGE_LIVE_ARM_BINDING=$(-not [string]::IsNullOrWhiteSpace($env:MT5_LIVE_ARM_STATE_PATH))"
.\.venv\Scripts\python.exe -m uvicorn mt5_bridge.app:app --host $env:MT5_BRIDGE_HOST --port $env:MT5_BRIDGE_PORT
