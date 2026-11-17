param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$EnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [datetime]$From = (Get-Date).AddDays(-7),
  [datetime]$To = (Get-Date),
  [string]$Symbol = "XAUUSD"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Reporter = Join-Path $PSScriptRoot "report-phase7c-forward.mjs"

if (-not (Test-Path $Reporter)) { throw "Phase 7C forward reporter not found: $Reporter" }
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path $WorkDir).Path

if (-not [System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $ProjectRoot $EnvFile }
if (-not (Test-Path $EnvFile)) { throw "EnvFile not found: $EnvFile" }
$EnvFile = (Resolve-Path $EnvFile).Path

foreach ($raw in Get-Content -LiteralPath $EnvFile) {
  $line = $raw.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
  $index = $line.IndexOf("=")
  $name = $line.Substring(0, $index).Trim().TrimStart([char]0xFEFF)
  $value = $line.Substring($index + 1).Trim().Trim('"').Trim("'")
  [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
}

if ([string]::IsNullOrWhiteSpace($env:MT5_API_KEY) -and [string]::IsNullOrWhiteSpace($env:MT5_BRIDGE_API_KEY)) {
  throw "MT5_API_KEY or MT5_BRIDGE_API_KEY is missing from $EnvFile"
}
if ($To -le $From) { throw "To must be later than From." }

$fromOffset = [DateTimeOffset]$From
$toOffset = [DateTimeOffset]$To
$env:ZIQ_PHASE7C_REPORT_WORK_DIR = $WorkDir
$env:ZIQ_PHASE7C_REPORT_FROM_MS = [string]$fromOffset.ToUnixTimeMilliseconds()
$env:ZIQ_PHASE7C_REPORT_TO_MS = [string]$toOffset.ToUnixTimeMilliseconds()
$env:ZIQ_PHASE7C_REPORT_SYMBOL = $Symbol.Trim().ToUpperInvariant()

Write-Host "PHASE7C_FORWARD_REPORT=STARTING"
Write-Host "PHASE7C_REPORT_WORK_DIR=$WorkDir"
Write-Host "PHASE7C_REPORT_FROM=$($fromOffset.ToString('o'))"
Write-Host "PHASE7C_REPORT_TO=$($toOffset.ToString('o'))"
Write-Host "PHASE7C_REPORT_SYMBOL=$($env:ZIQ_PHASE7C_REPORT_SYMBOL)"
Write-Host "PHASE7C_REPORT_SOURCE=LOCAL_JOURNALS_PLUS_MT5_DEAL_HISTORY"
Write-Host "PHASE7C_REPORT_MT5_MUTATION=NONE"

Push-Location $ProjectRoot
try {
  node $Reporter
  if ($LASTEXITCODE -ne 0) { throw "Phase 7C forward reporter exited with code $LASTEXITCODE" }
}
finally {
  Pop-Location
}
