param(
  [Parameter(Mandatory = $true)]
  [string]$WorkDir,

  [int]$IntervalMinutes = 30,
  [int]$Days = 180,
  [decimal]$MaxRiskUsd = 10,
  [string]$PythonExe = "python",
  [string]$BridgeEnv = "",
  [string]$FrozenDir = ""
)

$ErrorActionPreference = "Continue"

if ($IntervalMinutes -lt 1) {
  throw "IntervalMinutes must be >= 1."
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Runner = Join-Path $PSScriptRoot "run-phase5-forward-local.ps1"
$WatchLogDir = Join-Path $WorkDir "phase5-forward-watch"
$WatchLog = Join-Path $WatchLogDir "phase5-watch.log"
New-Item -ItemType Directory -Path $WatchLogDir -Force | Out-Null

Write-Host "PHASE5_WATCH_STATUS=STARTED"
Write-Host "PHASE5_WATCH_INTERVAL_MINUTES=$IntervalMinutes"
Write-Host "PHASE5_WATCH_WORK_DIR=$WorkDir"
Write-Host "PHASE5_WATCH_LOG=$WatchLog"
Write-Host "PHASE5_WATCH_STOP=CTRL+C"

$runNumber = 0
while ($true) {
  $runNumber += 1
  $started = Get-Date
  $stamp = $started.ToString("yyyy-MM-dd HH:mm:ss")
  $header = "PHASE5_WATCH_RUN_START=$runNumber|$stamp"
  Write-Host $header
  Add-Content -Path $WatchLog -Value $header

  $argsList = @(
    "-ExecutionPolicy", "Bypass",
    "-File", $Runner,
    "-WorkDir", $WorkDir,
    "-Days", [string]$Days,
    "-MaxRiskUsd", [string]$MaxRiskUsd,
    "-PythonExe", $PythonExe
  )
  if (-not [string]::IsNullOrWhiteSpace($BridgeEnv)) {
    $argsList += @("-BridgeEnv", $BridgeEnv)
  }
  if (-not [string]::IsNullOrWhiteSpace($FrozenDir)) {
    $argsList += @("-FrozenDir", $FrozenDir)
  }

  try {
    & powershell @argsList 2>&1 |
      Tee-Object -FilePath $WatchLog -Append

    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
      $result = "PHASE5_WATCH_RUN_STATUS=PASS|RUN=$runNumber"
    }
    else {
      $result = "PHASE5_WATCH_RUN_STATUS=FAIL|RUN=$runNumber|EXIT_CODE=$exitCode"
    }
  }
  catch {
    $result = "PHASE5_WATCH_RUN_STATUS=ERROR|RUN=$runNumber|MESSAGE=$($_.Exception.Message)"
  }

  Write-Host $result
  Add-Content -Path $WatchLog -Value $result

  $nextRun = (Get-Date).AddMinutes($IntervalMinutes)
  $nextLine = "PHASE5_WATCH_NEXT_RUN=$($nextRun.ToString('yyyy-MM-dd HH:mm:ss'))"
  Write-Host $nextLine
  Add-Content -Path $WatchLog -Value $nextLine

  Start-Sleep -Seconds ($IntervalMinutes * 60)
}
