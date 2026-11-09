param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$EnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [int]$IntervalSeconds = 300,
  [int]$LookbackDays = 7,
  [string]$Symbol = "XAUUSD",
  [int]$ParentPid = 0
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Reporter = Join-Path $PSScriptRoot "report-phase7c-forward.mjs"

if (-not (Test-Path $Reporter)) { throw "Phase 7C forward reporter not found: $Reporter" }
if ($IntervalSeconds -lt 60 -or $IntervalSeconds -gt 3600) { throw "IntervalSeconds must be between 60 and 3600." }
if ($LookbackDays -lt 1 -or $LookbackDays -gt 90) { throw "LookbackDays must be between 1 and 90." }

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

$ReportDir = Join-Path $WorkDir "phase7c-reports"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$StatusPath = Join-Path $ReportDir "auto-refresh-status.json"
$Symbol = $Symbol.Trim().ToUpperInvariant()

function Test-ParentAlive {
  if ($ParentPid -le 0) { return $true }
  return $null -ne (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)
}

function Write-RefreshStatus($Status, $StartedAt, $FinishedAt, $NextRunAt, $ExitCode, $Message) {
  $payload = [pscustomobject]@{
    version = 1
    status = $Status
    pid = $PID
    parentPid = if ($ParentPid -gt 0) { $ParentPid } else { $null }
    intervalSeconds = $IntervalSeconds
    lookbackDays = $LookbackDays
    symbol = $Symbol
    readOnly = $true
    mt5Mutation = $false
    startedAt = $StartedAt
    finishedAt = $FinishedAt
    nextRunAt = $NextRunAt
    exitCode = $ExitCode
    message = $Message
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  $temporary = "$StatusPath.$PID.tmp"
  $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding utf8
  Move-Item -LiteralPath $temporary -Destination $StatusPath -Force
}

Write-Host "PHASE7C_FORWARD_REPORT_REFRESH=RUNNING"
Write-Host "PHASE7C_FORWARD_REPORT_REFRESH_WORK_DIR=$WorkDir"
Write-Host "PHASE7C_FORWARD_REPORT_REFRESH_INTERVAL_SECONDS=$IntervalSeconds"
Write-Host "PHASE7C_FORWARD_REPORT_REFRESH_LOOKBACK_DAYS=$LookbackDays"
Write-Host "PHASE7C_FORWARD_REPORT_REFRESH_SYMBOL=$Symbol"
Write-Host "PHASE7C_FORWARD_REPORT_REFRESH_READ_ONLY=TRUE"
Write-Host "PHASE7C_FORWARD_REPORT_REFRESH_MT5_MUTATION=NONE"

while (Test-ParentAlive) {
  $startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $toOffset = [DateTimeOffset](Get-Date)
  $fromOffset = $toOffset.AddDays(-$LookbackDays)

  $env:ZIQ_PHASE7C_REPORT_WORK_DIR = $WorkDir
  $env:ZIQ_PHASE7C_REPORT_FROM_MS = [string]$fromOffset.ToUnixTimeMilliseconds()
  $env:ZIQ_PHASE7C_REPORT_TO_MS = [string]$toOffset.ToUnixTimeMilliseconds()
  $env:ZIQ_PHASE7C_REPORT_SYMBOL = $Symbol

  $exitCode = 1
  $message = ""
  try {
    Push-Location $ProjectRoot
    try {
      node $Reporter
      $exitCode = $LASTEXITCODE
    }
    finally {
      Pop-Location
    }
    if ($exitCode -ne 0) {
      $message = "Forward reporter exited with code $exitCode"
    }
  }
  catch {
    $message = $_.Exception.Message
    $exitCode = 1
  }

  $finishedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $nextRunAt = $finishedAt + ([long]$IntervalSeconds * 1000)
  if ($exitCode -eq 0) {
    Write-RefreshStatus "PASS" $startedAt $finishedAt $nextRunAt 0 "Report refreshed successfully."
    Write-Host "PHASE7C_FORWARD_REPORT_REFRESH_CYCLE=PASS"
  } else {
    Write-RefreshStatus "ERROR_RETRYING" $startedAt $finishedAt $nextRunAt $exitCode $message
    Write-Warning "Phase 7C forward report refresh failed; old report remains available. $message"
    Write-Host "PHASE7C_FORWARD_REPORT_REFRESH_CYCLE=ERROR_RETRYING"
  }

  $deadline = (Get-Date).AddSeconds($IntervalSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-ParentAlive)) { break }
    $remaining = [Math]::Max(1, [Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds))
    Start-Sleep -Seconds ([Math]::Min(5, [int]$remaining))
  }
}

$stoppedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Write-RefreshStatus "STOPPED_PARENT_EXIT" $stoppedAt $stoppedAt $null 0 "Dashboard parent process is no longer running."
Write-Host "PHASE7C_FORWARD_REPORT_REFRESH=STOPPED_PARENT_EXIT"
