param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [int]$IntervalMinutes = 30,
  [int]$Days = 180,
  [decimal]$MaxRiskUsd = 10,
  [string]$PythonExe = "python",
  [string]$BridgeEnv = "",
  [string]$FrozenDir = ""
)

$ErrorActionPreference = "Continue"
if ($IntervalMinutes -lt 1) { throw "IntervalMinutes must be >= 1." }

$Runner = Join-Path $PSScriptRoot "run-phase6d-forward-local.ps1"
$WatchLogDir = Join-Path $WorkDir "phase6d-forward-watch"
$WatchLog = Join-Path $WatchLogDir "phase6d-watch.log"
New-Item -ItemType Directory -Path $WatchLogDir -Force | Out-Null

function Add-Phase6DWatchLog {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string[]]$Lines
  )

  foreach ($line in $Lines) {
    $written = $false
    for ($attempt = 1; $attempt -le 20; $attempt += 1) {
      try {
        Add-Content -Path $WatchLog -Value $line -Encoding UTF8 -ErrorAction Stop
        $written = $true
        break
      }
      catch [System.IO.IOException] {
        Start-Sleep -Milliseconds 250
      }
    }
    if (-not $written) {
      Write-Warning "PHASE6D_WATCH_LOG_WRITE_SKIPPED=$line"
    }
  }
}

# Prevent multiple Phase 6D watcher instances from writing the same log concurrently.
$mutexName = "Global\XAUUSD_AI_MASTER_PHASE6D_FORWARD_WATCH"
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$mutexAcquired = $false
try {
  $mutexAcquired = $mutex.WaitOne(0, $false)
}
catch [System.Threading.AbandonedMutexException] {
  $mutexAcquired = $true
}

if (-not $mutexAcquired) {
  Write-Host "PHASE6D_WATCH_STATUS=ALREADY_RUNNING"
  Write-Host "PHASE6D_WATCH_LOG=$WatchLog"
  throw "Another Phase 6D watcher instance is already running. Stop it before starting a new one."
}

try {
  Write-Host "PHASE6D_WATCH_STATUS=STARTED"
  Write-Host "PHASE6D_WATCH_INTERVAL_MINUTES=$IntervalMinutes"
  Write-Host "PHASE6D_WATCH_CANDIDATE=BASELINE_BUY_SELL"
  Write-Host "PHASE6D_WATCH_WORK_DIR=$WorkDir"
  Write-Host "PHASE6D_WATCH_LOG=$WatchLog"
  Write-Host "PHASE6D_WATCH_SINGLE_WRITER=PASS"
  Write-Host "PHASE6D_WATCH_STOP=CTRL+C"

  Add-Phase6DWatchLog @(
    "PHASE6D_WATCH_SESSION_START=$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))",
    "PHASE6D_WATCH_SINGLE_WRITER=PASS"
  )

  $runNumber = 0
  while ($true) {
    $runNumber += 1
    $started = Get-Date
    $header = "PHASE6D_WATCH_RUN_START=$runNumber|$($started.ToString('yyyy-MM-dd HH:mm:ss'))"
    Write-Host $header
    Add-Phase6DWatchLog @($header)

    $argsList = @(
      "-ExecutionPolicy", "Bypass",
      "-File", $Runner,
      "-WorkDir", $WorkDir,
      "-Days", [string]$Days,
      "-MaxRiskUsd", [string]$MaxRiskUsd,
      "-PythonExe", $PythonExe
    )
    if (-not [string]::IsNullOrWhiteSpace($BridgeEnv)) { $argsList += @("-BridgeEnv", $BridgeEnv) }
    if (-not [string]::IsNullOrWhiteSpace($FrozenDir)) { $argsList += @("-FrozenDir", $FrozenDir) }

    try {
      # Capture child output first. This avoids Tee-Object and Add-Content holding
      # competing handles on the same watch log under Windows PowerShell.
      $runOutput = @(& powershell @argsList 2>&1 | ForEach-Object { [string]$_ })
      foreach ($line in $runOutput) { Write-Host $line }
      Add-Phase6DWatchLog $runOutput

      $exitCode = $LASTEXITCODE
      if ($exitCode -eq 0) {
        $result = "PHASE6D_WATCH_RUN_STATUS=PASS|RUN=$runNumber"
      }
      else {
        $result = "PHASE6D_WATCH_RUN_STATUS=FAIL|RUN=$runNumber|EXIT_CODE=$exitCode"
      }
    }
    catch {
      $result = "PHASE6D_WATCH_RUN_STATUS=ERROR|RUN=$runNumber|MESSAGE=$($_.Exception.Message)"
    }

    Write-Host $result
    Add-Phase6DWatchLog @($result)

    $nextRun = (Get-Date).AddMinutes($IntervalMinutes)
    $nextLine = "PHASE6D_WATCH_NEXT_RUN=$($nextRun.ToString('yyyy-MM-dd HH:mm:ss'))"
    Write-Host $nextLine
    Add-Phase6DWatchLog @($nextLine)

    Start-Sleep -Seconds ($IntervalMinutes * 60)
  }
}
finally {
  if ($mutexAcquired) {
    try { $mutex.ReleaseMutex() } catch { }
  }
  $mutex.Dispose()
}
