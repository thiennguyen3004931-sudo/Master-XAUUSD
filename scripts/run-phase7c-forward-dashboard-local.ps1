param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$EnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$HostAddress = "127.0.0.1",
  [int]$Port = 5727,
  [int]$RefreshSeconds = 15,
  [int]$ReportRefreshSeconds = 300,
  [int]$ReportLookbackDays = 7,
  [switch]$DisableAutoReportRefresh
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Dashboard = Join-Path $PSScriptRoot "run-phase7c-forward-dashboard.mjs"
$ReportRefresher = Join-Path $PSScriptRoot "run-phase7c-forward-report-refresh-local.ps1"

if (-not (Test-Path $Dashboard)) { throw "Phase 7C forward dashboard not found: $Dashboard" }
if (-not $DisableAutoReportRefresh -and -not (Test-Path $ReportRefresher)) {
  throw "Phase 7C forward report refresher not found: $ReportRefresher"
}
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path $WorkDir).Path

if (-not [System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $ProjectRoot $EnvFile }
if (-not (Test-Path $EnvFile)) { throw "EnvFile not found: $EnvFile" }
$EnvFile = (Resolve-Path $EnvFile).Path

if ($HostAddress -notin @("127.0.0.1", "localhost", "::1")) {
  throw "Phase 7C forward dashboard is loopback-only. Refused HostAddress=$HostAddress"
}
if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535." }
if ($RefreshSeconds -lt 5 -or $RefreshSeconds -gt 300) { throw "RefreshSeconds must be between 5 and 300." }
if ($ReportRefreshSeconds -lt 60 -or $ReportRefreshSeconds -gt 3600) { throw "ReportRefreshSeconds must be between 60 and 3600." }
if ($ReportLookbackDays -lt 1 -or $ReportLookbackDays -gt 90) { throw "ReportLookbackDays must be between 1 and 90." }

$env:ZIQ_PHASE7C_DASHBOARD_WORK_DIR = $WorkDir
$env:ZIQ_PHASE7C_DASHBOARD_HOST = $HostAddress
$env:ZIQ_PHASE7C_DASHBOARD_PORT = [string]$Port
$env:ZIQ_PHASE7C_DASHBOARD_REFRESH_MS = [string]($RefreshSeconds * 1000)
$env:ZIQ_PHASE7C_CONTROL_API_URL = $ControlApiUrl.TrimEnd('/')

$ReportDir = Join-Path $WorkDir "phase7c-reports"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$RefresherOut = Join-Path $ReportDir "auto-refresh.out.log"
$RefresherErr = Join-Path $ReportDir "auto-refresh.err.log"
$refreshProcess = $null

function Stop-ProcessTree([int]$ProcessId) {
  if ($ProcessId -le 0) { return }
  if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
  try {
    $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    if (Test-Path $taskkill) {
      & $taskkill /PID $ProcessId /T /F 2>$null | Out-Null
    } else {
      Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "PHASE7C_FORWARD_DASHBOARD=STARTING"
Write-Host "PHASE7C_FORWARD_DASHBOARD_URL=http://${HostAddress}:${Port}/"
Write-Host "PHASE7C_FORWARD_DASHBOARD_WORK_DIR=$WorkDir"
Write-Host "PHASE7C_FORWARD_DASHBOARD_CONTROL_API=$($env:ZIQ_PHASE7C_CONTROL_API_URL)"
Write-Host "PHASE7C_FORWARD_DASHBOARD_REFRESH_SECONDS=$RefreshSeconds"
Write-Host "PHASE7C_FORWARD_DASHBOARD_READ_ONLY=TRUE"
Write-Host "PHASE7C_FORWARD_DASHBOARD_MT5_MUTATION=NONE"

try {
  if (-not $DisableAutoReportRefresh) {
    $refreshArgs = @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", ('"{0}"' -f $ReportRefresher),
      "-WorkDir", ('"{0}"' -f $WorkDir),
      "-EnvFile", ('"{0}"' -f $EnvFile),
      "-IntervalSeconds", [string]$ReportRefreshSeconds,
      "-LookbackDays", [string]$ReportLookbackDays,
      "-Symbol", "XAUUSD",
      "-ParentPid", [string]$PID
    )
    $refreshProcess = Start-Process -FilePath "powershell.exe" -ArgumentList $refreshArgs -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $RefresherOut -RedirectStandardError $RefresherErr -PassThru
    Start-Sleep -Seconds 1
    $refreshProcess.Refresh()
    if ($refreshProcess.HasExited) {
      throw "Phase 7C report refresher exited during startup. Check $RefresherErr"
    }
    Write-Host "PHASE7C_FORWARD_DASHBOARD_AUTO_REPORT_REFRESH=TRUE"
    Write-Host "PHASE7C_FORWARD_DASHBOARD_REPORT_REFRESH_SECONDS=$ReportRefreshSeconds"
    Write-Host "PHASE7C_FORWARD_DASHBOARD_REPORT_LOOKBACK_DAYS=$ReportLookbackDays"
    Write-Host "PHASE7C_FORWARD_DASHBOARD_REPORT_REFRESH_PID=$($refreshProcess.Id)"
    Write-Host "PHASE7C_FORWARD_DASHBOARD_REPORT_REFRESH_MT5_MUTATION=NONE"
  } else {
    Write-Host "PHASE7C_FORWARD_DASHBOARD_AUTO_REPORT_REFRESH=FALSE"
  }

  Push-Location $ProjectRoot
  try {
    node $Dashboard
    if ($LASTEXITCODE -ne 0) { throw "Phase 7C forward dashboard exited with code $LASTEXITCODE" }
  }
  finally {
    Pop-Location
  }
}
finally {
  if ($null -ne $refreshProcess) {
    Stop-ProcessTree $refreshProcess.Id
    Write-Host "PHASE7C_FORWARD_DASHBOARD_REPORT_REFRESH_STOP=PASS"
  }
}
