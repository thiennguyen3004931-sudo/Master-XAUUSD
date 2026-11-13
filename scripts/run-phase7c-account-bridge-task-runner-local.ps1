param(
  [int]$RestartDelaySeconds = 10
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$JobObjectHelper = Join-Path $PSScriptRoot "lib\phase7b-windows-job-object.ps1"
$BridgeDir = Join-Path $ProjectRoot "packages\mt5-broker\bridge"
$BridgeRunner = Join-Path $BridgeDir "run.ps1"
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$AccountStatePath = Join-Path $RuntimeRoot "phase7c-account-mode.json"
$RuntimeDir = Join-Path $RuntimeRoot "phase7c-account-bridge"
$LockPath = Join-Path $RuntimeDir "startup-runner.lock"
$StatusPath = Join-Path $RuntimeDir "startup-runner-status.json"
$StdOut = Join-Path $RuntimeDir "bridge.out.log"
$StdErr = Join-Path $RuntimeDir "bridge.err.log"
$ErrorLog = Join-Path $RuntimeDir "startup-runner.err.log"

foreach ($required in @($AccountLibrary, $JobObjectHelper, $BridgeRunner, $AccountStatePath)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Phase7C account bridge required file not found: $required" }
}
if ($RestartDelaySeconds -lt 5 -or $RestartDelaySeconds -gt 300) { throw "RestartDelaySeconds must be between 5 and 300." }
. $AccountLibrary
. $JobObjectHelper
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$LiveArmStatePath = Get-Phase7CLiveArmPath $RuntimeRoot

function Read-AccountState {
  $state = Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
  if ([int]$state.version -ne 1) { throw "Unsupported Phase7C account-mode state version." }
  $mode = ConvertTo-Phase7CAccountMode ([string]$state.accountMode)
  $liveEnabled = if ($null -ne $state.PSObject.Properties["liveExecutionEnabled"]) { [bool]$state.liveExecutionEnabled } else { $false }
  if ($mode -eq "DEMO" -and $liveEnabled) { throw "DEMO account state cannot enable LIVE capability." }
  if ($mode -eq "LIVE" -and -not $liveEnabled) { throw "LIVE account state requires the legacy LIVE capability gate; explicit arm is still separate." }
  $envFile = [string]$state.envFile
  if ([string]::IsNullOrWhiteSpace($envFile)) { throw "Account-mode state envFile is missing." }
  if (-not [System.IO.Path]::IsPathRooted($envFile)) { $envFile = Join-Path $ProjectRoot $envFile }
  $envInfo = Assert-Phase7CAccountEnv -EnvFile $envFile -AccountMode $mode -RequireTrading
  return [pscustomobject]@{ mode = $mode; liveExecutionEnabled = $liveEnabled; envInfo = $envInfo }
}

$lock = $null
$runtimeJob = $null
try {
  try {
    $lock = [System.IO.File]::Open(
      $LockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    throw "Another Phase7C account bridge runner already owns the exclusive lock: $LockPath"
  }

  $lockMeta = [pscustomobject]@{
    version = 1
    runnerPid = $PID
    acquiredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } | ConvertTo-Json -Compress
  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($lockMeta)
  $lock.SetLength(0); $lock.Write($bytes, 0, $bytes.Length); $lock.Flush($true); $lock.Position = 0

  # Mirror the canonical Phase7B Web lifecycle boundary: bind the supervisor
  # itself to a kill-on-close Job Object before spawning the Bridge wrapper.
  # The wrapper and its Uvicorn/Python descendants then inherit the same job,
  # so forced Scheduled Task termination cannot orphan the Bridge listener.
  $runtimeJob = New-Phase7BKillOnCloseJob -Name ("Phase7C-Account-Bridge-{0}-{1}" -f $PID, [guid]::NewGuid().ToString('N'))
  Add-Phase7BProcessToJob -Job $runtimeJob -ProcessId $PID
  Write-Host "PHASE7C_ACCOUNT_BRIDGE_JOB_OBJECT=ACTIVE"

  $attempt = 0
  while ($true) {
    $attempt++
    $process = $null
    $state = $null
    try {
      $state = Read-AccountState
      $mode = $state.mode
      $envFile = $state.envInfo.envFile

      # A bridge process restart creates a new bridgeSessionId. Any previous
      # LIVE arm is therefore invalid and is proactively deleted before launch.
      Clear-Phase7CLiveArmState -WorkDir $RuntimeRoot -Reason "bridge-process-launch"

      $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", ('"{0}"' -f $BridgeRunner),
        "-EnvFile", ('"{0}"' -f $envFile),
        "-AccountMode", $mode,
        "-LiveArmStatePath", ('"{0}"' -f $LiveArmStatePath)
      )
      $starting = [pscustomobject]@{
        version = 1
        status = "STARTING_BRIDGE"
        runnerPid = $PID
        bridgeProcessPid = $null
        accountMode = $mode
        liveArmStatePath = $LiveArmStatePath
        envFile = $envFile
        attempt = $attempt
        updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      }
      Write-Phase7CAccountJsonAtomic -Path $StatusPath -Value $starting -Depth 5

      $process = Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList $arguments `
        -WorkingDirectory $BridgeDir `
        -RedirectStandardOutput $StdOut `
        -RedirectStandardError $StdErr `
        -PassThru

      Write-Host "PHASE7C_ACCOUNT_BRIDGE_RUNNER=RUNNING|MODE=$mode|PID=$($process.Id)|LIVE_ARM=DISARMED"
      while (-not $process.HasExited) {
        $running = [pscustomobject]@{
          version = 1
          status = "BRIDGE_RUNNING"
          runnerPid = $PID
          bridgeProcessPid = $process.Id
          accountMode = $mode
          liveArmStatePath = $LiveArmStatePath
          envFile = $envFile
          attempt = $attempt
          updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        Write-Phase7CAccountJsonAtomic -Path $StatusPath -Value $running -Depth 5
        Start-Sleep -Seconds 10
        $process.Refresh()
      }
      $message = "Phase7C account bridge process exited with code $($process.ExitCode); retrying in $RestartDelaySeconds seconds."
      Add-Content -LiteralPath $ErrorLog -Value "[$([DateTimeOffset]::Now.ToString('o'))] $message" -Encoding utf8
      Write-Phase7CAccountJsonAtomic -Path $StatusPath -Value ([pscustomobject]@{
        version = 1; status = "ERROR_RETRYING"; runnerPid = $PID; bridgeProcessPid = $process.Id;
        accountMode = $mode; liveArmStatePath = $LiveArmStatePath; envFile = $envFile; attempt = $attempt; exitCode = $process.ExitCode;
        message = $message; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      }) -Depth 5
    } catch {
      $message = "Phase7C account bridge launch/monitor failed: $($_.Exception.Message). Retrying in $RestartDelaySeconds seconds."
      Add-Content -LiteralPath $ErrorLog -Value "[$([DateTimeOffset]::Now.ToString('o'))] $message" -Encoding utf8
      Write-Phase7CAccountJsonAtomic -Path $StatusPath -Value ([pscustomobject]@{
        version = 1; status = "ERROR_RETRYING"; runnerPid = $PID;
        bridgeProcessPid = if ($null -ne $process) { $process.Id } else { $null };
        accountMode = if ($null -ne $state) { $state.mode } else { "UNKNOWN" };
        liveArmStatePath = $LiveArmStatePath; attempt = $attempt; message = $message; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      }) -Depth 5
    }
    Start-Sleep -Seconds $RestartDelaySeconds
  }
} finally {
  if ($null -ne $lock) { $lock.Dispose() }
}
