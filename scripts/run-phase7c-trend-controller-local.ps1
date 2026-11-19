param(
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$EnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$WorkDir = "",
  [ValidateSet("DEMO", "LIVE")] [string]$AccountMode = "DEMO",
  [switch]$LiveExecutionEnabled,
  [double]$FixedVolume = 0.03,
  [switch]$FixedTpEnabled,
  [double]$FixedTpDistance = 0,
  [switch]$Armed,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Controller = Join-Path $PSScriptRoot "run-phase7c-trend-account-mode.mjs"
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
if (-not (Test-Path $Controller)) { throw "Phase 7C Trend account-mode controller not found: $Controller" }
if (-not (Test-Path $AccountLibrary)) { throw "Phase 7C account-mode library not found: $AccountLibrary" }
. $AccountLibrary

$mode = ConvertTo-Phase7CAccountMode $AccountMode
if ($mode -eq "LIVE" -and -not $LiveExecutionEnabled) {
  throw "LIVE Trend execution requires -LiveExecutionEnabled."
}
if ($FixedVolume -lt 0.03 -or $FixedVolume -gt 1.2) { throw "FixedVolume must be between 0.03 and 1.20." }
$fixedUnits = $FixedVolume / 0.03
if ([math]::Abs($fixedUnits - [math]::Round($fixedUnits)) -gt 1e-8) {
  throw "FixedVolume must use 0.03 increments so +10 can close exactly one-third."
}
$fixedTpDistanceInvalid = [double]::IsNaN($FixedTpDistance) -or [double]::IsInfinity($FixedTpDistance)
if ($FixedTpEnabled -and ($fixedTpDistanceInvalid -or $FixedTpDistance -le 0)) {
  throw "Trend Fixed TP distance must be positive when Fixed TP is enabled."
}
if ($fixedTpDistanceInvalid -or $FixedTpDistance -lt 0) {
  throw "Trend Fixed TP distance must be finite and non-negative."
}

if (-not [System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $ProjectRoot $EnvFile }
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode $mode -RequireTrading:$Armed
$EnvFile = $envInfo.envFile

foreach ($raw in Get-Content -LiteralPath $EnvFile) {
  $line = ([string]$raw).Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
  $index = $line.IndexOf("=")
  $name = $line.Substring(0, $index).Trim().TrimStart([char]0xFEFF)
  $value = $line.Substring($index + 1).Trim().Trim('"').Trim("'")
  [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
}

if (-not [string]::IsNullOrWhiteSpace($WorkDir)) {
  if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  $env:ZIQ_DEMO_WORK_DIR = (Resolve-Path $WorkDir).Path
}
if ([string]::IsNullOrWhiteSpace($env:ZIQ_DEMO_WORK_DIR)) {
  throw "Phase 7C Trend controller requires -WorkDir or existing ZIQ_DEMO_WORK_DIR."
}

$env:ZIQ_PHASE7C_CONTROL_API_URL = $ControlApiUrl.TrimEnd('/')
$env:ZIQ_PHASE7C_ACCOUNT_MODE = $mode
$env:ZIQ_PHASE7C_LIVE_EXECUTION_ENABLED = if ($mode -eq "LIVE" -and $LiveExecutionEnabled) { "true" } else { "false" }
$env:ZIQ_BRIDGE_ENV = $EnvFile
$env:ZIQ_FIXED_VOLUME = $FixedVolume.ToString([System.Globalization.CultureInfo]::InvariantCulture)
$env:ZIQ_PHASE7C_TREND_FIXED_TP_ENABLED = if ($FixedTpEnabled) { "true" } else { "false" }
$env:ZIQ_PHASE7C_TREND_FIXED_TP_DISTANCE = $FixedTpDistance.ToString([System.Globalization.CultureInfo]::InvariantCulture)
$env:ZIQ_DEMO_ARMED = if ($Armed) { "true" } else { "false" }
$env:ZIQ_DEMO_ONCE = if ($Once) { "true" } else { "false" }

Write-Host "PHASE7C_TREND_CONTROLLER=STARTING"
Write-Host "PHASE7C_TREND_ACCOUNT_MODE=$mode"
Write-Host "PHASE7C_CONTROL_API=$($env:ZIQ_PHASE7C_CONTROL_API_URL)"
Write-Host "PHASE7C_TREND_ARMED=$($env:ZIQ_DEMO_ARMED)"
Write-Host "PHASE7C_TREND_FIXED_LOT=$($env:ZIQ_FIXED_VOLUME)"
Write-Host "PHASE7C_TREND_FIXED_TP_ENABLED=$($env:ZIQ_PHASE7C_TREND_FIXED_TP_ENABLED)"
Write-Host "PHASE7C_TREND_FIXED_TP_DISTANCE=$($env:ZIQ_PHASE7C_TREND_FIXED_TP_DISTANCE)"
Write-Host "PHASE7C_TREND_WORK_DIR=$($env:ZIQ_DEMO_WORK_DIR)"
Write-Host "PHASE7C_GATE_SCOPE=NEW_TREND_ENTRIES_ONLY"
Write-Host "PHASE7C_POSITION_MANAGEMENT=PASS_THROUGH"
Write-Host "PHASE7C_FAIL_CLOSED=TRUE"
Write-Host "PHASE7C_ENV_FILE=$EnvFile"

Push-Location $ProjectRoot
try {
  $NodePath = [string]$env:PHASE7C_NODE_PATH
  if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $NodeCommand) {
      throw "Node.js executable is unavailable. Set PHASE7C_NODE_PATH or install Node.js."
    }
    $NodePath = [string]$NodeCommand.Source
  }
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw "Node.js executable not found: $NodePath"
  }
  & $NodePath $Controller
  if ($LASTEXITCODE -ne 0) { throw "Phase 7C Trend controller exited with code $LASTEXITCODE" }
}
finally { Pop-Location }
