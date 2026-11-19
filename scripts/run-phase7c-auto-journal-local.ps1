param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$Symbol = "XAUUSD",
  [int]$IntervalSeconds = 15,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Journal = Join-Path $PSScriptRoot "run-phase7c-auto-journal.mjs"

if (-not (Test-Path $Journal)) { throw "Phase 7C AUTO journal not found: $Journal" }
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$WorkDir = (Resolve-Path $WorkDir).Path

$env:ZIQ_PHASE7C_CONTROL_API_URL = $ControlApiUrl.TrimEnd('/')
$env:ZIQ_PHASE7C_REGIME_SYMBOL = $Symbol.Trim().ToUpperInvariant()
$env:ZIQ_PHASE7C_AUTO_JOURNAL_INTERVAL_MS = [string]([Math]::Max(5, $IntervalSeconds) * 1000)
$env:ZIQ_PHASE7C_AUTO_JOURNAL_WORK_DIR = $WorkDir
$env:ZIQ_PHASE7C_AUTO_JOURNAL_ONCE = if ($Once) { "true" } else { "false" }

Write-Host "PHASE7C_AUTO_JOURNAL=STARTING"
Write-Host "PHASE7C_AUTO_JOURNAL_WORK_DIR=$WorkDir"
Write-Host "PHASE7C_AUTO_JOURNAL_CONTROL_API=$($env:ZIQ_PHASE7C_CONTROL_API_URL)"
Write-Host "PHASE7C_AUTO_JOURNAL_SYMBOL=$($env:ZIQ_PHASE7C_REGIME_SYMBOL)"
Write-Host "PHASE7C_AUTO_JOURNAL_INTERVAL_SECONDS=$IntervalSeconds"
Write-Host "PHASE7C_AUTO_JOURNAL_MT5_ORDER_PERMISSION=NONE"

Push-Location $ProjectRoot
try {
  node $Journal
  if ($LASTEXITCODE -ne 0) { throw "Phase 7C AUTO journal exited with code $LASTEXITCODE" }
}
finally {
  Pop-Location
}
