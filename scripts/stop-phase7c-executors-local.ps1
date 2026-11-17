param(
  [Parameter(Mandatory = $true)] [string]$WorkDir
)

$ErrorActionPreference = "Stop"
$script:StopFailures = @()
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) {
  $WorkDir = Join-Path $ProjectRoot $WorkDir
}
if (-not (Test-Path $WorkDir)) {
  Write-Host "PHASE7C_EXECUTOR_STOP=NO_RUNTIME"
  exit 0
}
$WorkDir = (Resolve-Path $WorkDir).Path
$RuntimeDir = Join-Path $WorkDir "phase7c-executors"

function Get-Phase7CProcessStartTicks([System.Diagnostics.Process]$Process) {
  if ($null -eq $Process) { return $null }
  try { return [long]$Process.StartTime.ToUniversalTime().Ticks }
  catch { return $null }
}

function Test-Phase7CSameProcessAlive([int]$ProcessId, [Nullable[long]]$StartTicks) {
  $current = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $current) { return $false }
  if ($null -eq $StartTicks) { return $true }
  try {
    return [long]$current.StartTime.ToUniversalTime().Ticks -eq [long]$StartTicks.Value
  } catch {
    # Fail closed if Windows cannot expose StartTime for a process that is
    # still visible. The caller will keep waiting instead of assuming it died.
    return $true
  }
}

function Wait-Phase7CProcessGone(
  [int]$ProcessId,
  [Nullable[long]]$StartTicks,
  [int]$TimeoutMilliseconds = 5000
) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    if (-not (Test-Phase7CSameProcessAlive $ProcessId $StartTicks)) { return $true }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  return -not (Test-Phase7CSameProcessAlive $ProcessId $StartTicks)
}

function Stop-ProcessTree([int]$ProcessId, [string]$Label) {
  if ($ProcessId -le 0) { return $false }
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  # A parent taskkill may already have removed a descendant captured in an
  # earlier CIM snapshot. That is a successful stopped state, not a warning.
  if ($null -eq $process) { return $true }
  $startTicks = Get-Phase7CProcessStartTicks $process

  try {
    $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    if (Test-Path $taskkill) {
      & $taskkill /PID $ProcessId /T /F 2>$null | Out-Null
    } else {
      Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    }
  } catch {
    # The process can exit between Get-Process and taskkill. A failed native
    # kill is therefore not itself a stop failure; verify the original PID
    # identity below before deciding.
  }

  # Windows process-tree teardown is asynchronous. The previous 150 ms check
  # could report a false failure for a launcher that was already terminating.
  # Wait for the exact original PID identity to disappear before escalating.
  if (Wait-Phase7CProcessGone $ProcessId $startTicks 5000) { return $true }

  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  } catch {}

  if (Wait-Phase7CProcessGone $ProcessId $startTicks 3000) { return $true }

  # One final verified tree kill covers a stubborn child/console teardown.
  try {
    $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    if (Test-Path $taskkill) {
      & $taskkill /PID $ProcessId /T /F 2>$null | Out-Null
    }
  } catch {}

  return Wait-Phase7CProcessGone $ProcessId $startTicks 2000
}

function Stop-PidFile([string]$Path, [string]$Label) {
  if (-not (Test-Path $Path)) {
    Write-Host "PHASE7C_${Label}_STOP=NO_PID_FILE"
    return
  }
  $removePidFile = $true
  try {
    $pidValue = [int](Get-Content -LiteralPath $Path -Raw).Trim()
    if ($pidValue -gt 0) {
      $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
      if ($null -ne $process) {
        $stopped = Stop-ProcessTree $pidValue $Label
        if ($stopped) {
          Write-Host "PHASE7C_${Label}_STOP=PASS_TREE|PID=$pidValue"
        } else {
          Write-Warning "Process tree for $Label PID $pidValue may still be alive after the shutdown grace period."
          $script:StopFailures += "${Label}:$pidValue"
          $removePidFile = $false
        }
      } else {
        Write-Host "PHASE7C_${Label}_STOP=ALREADY_EXITED|PID=$pidValue"
      }
    }
  } catch {
    Write-Warning "Could not stop $Label from PID file $Path. $($_.Exception.Message)"
    $script:StopFailures += "${Label}:PID_FILE_ERROR"
    $removePidFile = $false
  }
  if ($removePidFile) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  }
}

function Stop-OrphanPowerShellProcess([string]$ScriptPath, [string]$Label) {
  try {
    $canonicalScriptPath = [System.IO.Path]::GetFullPath($ScriptPath)
    $candidates = @(
      @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop)
      @(Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" -ErrorAction Stop)
    )
    $matches = @($candidates | Where-Object {
      $commandLine = [string]$_.CommandLine
      if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
      $hasFileSwitch = $commandLine -match '(?i)(?:^|\s)-File(?:\s|=)'
      $hasCanonicalScript = $commandLine.IndexOf($canonicalScriptPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
      $hasFileSwitch -and $hasCanonicalScript
    })
    foreach ($match in $matches) {
      $pidValue = [int]$match.ProcessId
      if ($pidValue -le 0 -or $pidValue -eq $PID) { continue }
      $stopped = Stop-ProcessTree $pidValue $Label
      if ($stopped) {
        Write-Host "PHASE7C_${Label}_POWERSHELL_ORPHAN_STOP=PASS|PID=$pidValue"
      } else {
        Write-Warning "Could not fully stop orphan $Label PowerShell wrapper PID $pidValue."
        $script:StopFailures += "${Label}_POWERSHELL_ORPHAN:$pidValue"
      }
    }
  } catch {
    Write-Warning "Could not inspect orphan $Label PowerShell wrappers. $($_.Exception.Message)"
    $script:StopFailures += "${Label}_POWERSHELL_ORPHAN:INSPECTION_ERROR"
  }
}

function Stop-OrphanNodeProcess([string]$ScriptName, [string]$Label) {
  try {
    $matches = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop | Where-Object {
      -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
      [string]$_.CommandLine -like "*$ScriptName*"
    })
    foreach ($match in $matches) {
      $pidValue = [int]$match.ProcessId
      if ($pidValue -le 0) { continue }
      $stopped = Stop-ProcessTree $pidValue $Label
      if ($stopped) {
        Write-Host "PHASE7C_${Label}_ORPHAN_STOP=PASS|PID=$pidValue"
      } else {
        Write-Warning "Could not fully stop orphan $Label Node process PID $pidValue."
        $script:StopFailures += "${Label}_ORPHAN:$pidValue"
      }
    }
  } catch {
    Write-Warning "Could not inspect orphan $Label Node processes. $($_.Exception.Message)"
    $script:StopFailures += "${Label}_ORPHAN:INSPECTION_ERROR"
  }
}

# Stop the watchdog owner first. Otherwise it can recreate a managed child
# while this stopper is still cleaning that child's PID file/process tree.
Stop-PidFile (Join-Path $RuntimeDir "supervisor.pid") "SUPERVISOR"
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDir "supervisor.pid"))) {
  Stop-OrphanPowerShellProcess (Join-Path $PSScriptRoot "run-phase7c-executors-local.ps1") "SUPERVISOR"
} else {
  Write-Host "PHASE7C_SUPERVISOR_POWERSHELL_ORPHAN_STOP=SKIP_PID_EVIDENCE_PRESENT"
}

# The supervisor tree kill normally removes all descendants. These idempotent
# child checks clean up anything that survived or detached before shutdown.
Stop-PidFile (Join-Path $RuntimeDir "trade-notifier.pid") "TRADE_NOTIFIER"
Stop-PidFile (Join-Path $RuntimeDir "telegram-mode.pid") "TELEGRAM_MODE"
Stop-PidFile (Join-Path $RuntimeDir "regime-notifier.pid") "REGIME_NOTIFIER"
Stop-PidFile (Join-Path $RuntimeDir "trend.pid") "TREND"
Stop-PidFile (Join-Path $RuntimeDir "sideway.pid") "SIDEWAY"

# Reconcile canonical PowerShell wrappers by exact full script path only when
# their PID evidence is absent. An existing but invalid PID file is an ownership
# ambiguity and must fail closed without killing a potentially managed wrapper.
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDir "telegram-mode.pid"))) {
  Stop-OrphanPowerShellProcess (Join-Path $PSScriptRoot "run-phase7c-telegram-mode-controller-local.ps1") "TELEGRAM_MODE"
}
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDir "regime-notifier.pid"))) {
  Stop-OrphanPowerShellProcess (Join-Path $PSScriptRoot "run-phase7c-regime-notifier-local.ps1") "REGIME_NOTIFIER"
}
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDir "trend.pid"))) {
  Stop-OrphanPowerShellProcess (Join-Path $PSScriptRoot "run-phase7c-trend-controller-local.ps1") "TREND"
}
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDir "sideway.pid"))) {
  Stop-OrphanPowerShellProcess (Join-Path $PSScriptRoot "run-phase7c-sideway-controller-local.ps1") "SIDEWAY"
}

# Clean up Node children left by older versions that only killed the launcher PID.
Stop-OrphanNodeProcess "run-phase7b-telegram-notifier.mjs" "TRADE_NOTIFIER"
Stop-OrphanNodeProcess "run-phase7c-telegram-mode-controller.mjs" "TELEGRAM_MODE"
Stop-OrphanNodeProcess "run-phase7c-regime-notifier.mjs" "REGIME_NOTIFIER"
Stop-OrphanNodeProcess "run-phase7c-trend-controller.mjs" "TREND"
Stop-OrphanNodeProcess "run-phase7c-sideway-locked.mjs" "SIDEWAY"
Stop-OrphanNodeProcess "run-phase7c-sideway-controller.mjs" "SIDEWAY"

if ($script:StopFailures.Count -gt 0) {
  Write-Host "PHASE7C_EXECUTOR_STOP=FAIL|REMAINING=$($script:StopFailures -join ',')"
  Write-Error "Phase 7C executor stop is incomplete. Re-run from PowerShell Administrator; activation must remain PAUSE."
  exit 1
}

Remove-Item -LiteralPath (Join-Path $RuntimeDir "phase7c-execution.lock") -Force -ErrorAction SilentlyContinue
Write-Host "PHASE7C_EXECUTOR_STOP=PASS"

# Explicitly publish success to callers that invoke this script with `&` and
# inspect $LASTEXITCODE. Native taskkill.exe calls above can leave a stale
# non-zero LASTEXITCODE even when every process is already stopped cleanly.
# Without this explicit exit code, recovery/switch callers can misclassify a
# successful cleanup as a failure.
exit 0