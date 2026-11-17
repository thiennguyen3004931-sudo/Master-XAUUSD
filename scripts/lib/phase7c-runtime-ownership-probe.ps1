function Get-Phase7CReadOnlyLockState {
  param(
    [Parameter(Mandatory = $true)] [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return 'MISSING'
  }

  $handle = $null
  try {
    # Diagnostic probe only: request read access and exclusive sharing so the
    # production runner's open FileStream remains the source of truth. Use
    # File.Open so Windows PowerShell preserves the native sharing-violation
    # HRESULT used by the canonical startup-runner ownership helper.
    $handle = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::None
    )
    return 'RELEASED'
  } catch [System.UnauthorizedAccessException] {
    return 'ACCESS_DENIED'
  } catch [System.IO.IOException] {
    $code = $_.Exception.HResult -band 0xFFFF
    if ($code -eq 32 -or $code -eq 33) {
      return 'HELD'
    }
    return 'IO_ERROR'
  } catch {
    return 'ERROR'
  } finally {
    if ($null -ne $handle) {
      $handle.Dispose()
    }
  }
}

function Read-Phase7CRuntimeOwnershipJson {
  param(
    [Parameter(Mandatory = $true)] [string]$Path
  )

  $maxAttempts = 8
  $retryDelayMs = 5
  $lastIoError = $null

  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    $stream = $null
    $reader = $null
    $raw = $null
    try {
      # These files are atomically replaced by the SYSTEM lifecycle broker while
      # reconciliation/diagnostic probes may read them concurrently. Readers must
      # explicitly allow FILE_SHARE_DELETE or Windows can reject File.Replace and
      # terminate the broker heartbeat loop.
      $shareMode = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
      $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        $shareMode
      )
      $reader = [System.IO.StreamReader]::new(
        $stream,
        [System.Text.Encoding]::UTF8,
        $true,
        1024,
        $false
      )
      $raw = $reader.ReadToEnd()
    } catch [System.UnauthorizedAccessException] {
      return [pscustomobject]@{
        ok = $false
        value = $null
        error = 'ACCESS_DENIED'
      }
    } catch [System.IO.FileNotFoundException] {
      $lastIoError = 'MISSING'
    } catch [System.IO.DirectoryNotFoundException] {
      $lastIoError = 'MISSING'
    } catch [System.IO.IOException] {
      $lastIoError = 'INVALID_OR_UNREADABLE'
    } catch {
      return [pscustomobject]@{
        ok = $false
        value = $null
        error = 'INVALID_OR_UNREADABLE'
      }
    } finally {
      if ($null -ne $reader) {
        $reader.Dispose()
      } elseif ($null -ne $stream) {
        $stream.Dispose()
      }
    }

    if ($null -ne $raw) {
      try {
        $value = $raw | ConvertFrom-Json -ErrorAction Stop
        return [pscustomobject]@{
          ok = $true
          value = $value
          error = $null
        }
      } catch {
        # A successfully-read malformed payload is real invalid evidence, not a
        # transient sharing race. Preserve fail-closed behavior without retry.
        return [pscustomobject]@{
          ok = $false
          value = $null
          error = 'INVALID_OR_UNREADABLE'
        }
      }
    }

    if ($attempt -lt $maxAttempts) {
      Start-Sleep -Milliseconds $retryDelayMs
    }
  }

  return [pscustomobject]@{
    ok = $false
    value = $null
    error = if ($lastIoError -eq 'MISSING') { 'MISSING' } else { 'INVALID_OR_UNREADABLE' }
  }
}

function Get-Phase7CRuntimeGenerationSnapshot {
  param(
    [Parameter(Mandatory = $true)] [string]$WorkDir,
    [ValidateRange(1, 600000)] [int64]$HeartbeatMaxAgeMs = 5000
  )

  $workDirFull = [System.IO.Path]::GetFullPath($WorkDir).TrimEnd('\', '/')
  $runtimeDir = Join-Path $workDirFull 'phase7c-executors'
  $brokerStateDir = Join-Path $workDirFull 'phase7c-lifecycle-broker\state'
  $statusPath = Join-Path $brokerStateDir 'status.json'
  $heartbeatPath = Join-Path $brokerStateDir 'heartbeat.json'
  $startupRunnerLockPath = Join-Path $runtimeDir 'startup-runner.lock'

  $lockState = Get-Phase7CReadOnlyLockState -Path $startupRunnerLockPath
  $statusRead = Read-Phase7CRuntimeOwnershipJson -Path $statusPath
  $heartbeatRead = Read-Phase7CRuntimeOwnershipJson -Path $heartbeatPath

  $statusPid = 0L
  $heartbeatPid = 0L
  $heartbeatUpdatedAt = 0L

  if ([bool]$statusRead.ok -and $null -ne $statusRead.value.PSObject.Properties['brokerPid']) {
    try { $statusPid = [int64]$statusRead.value.brokerPid } catch { $statusPid = 0L }
  }
  if ([bool]$heartbeatRead.ok -and $null -ne $heartbeatRead.value.PSObject.Properties['brokerPid']) {
    try { $heartbeatPid = [int64]$heartbeatRead.value.brokerPid } catch { $heartbeatPid = 0L }
  }
  if ([bool]$heartbeatRead.ok -and $null -ne $heartbeatRead.value.PSObject.Properties['updatedAt']) {
    try { $heartbeatUpdatedAt = [int64]$heartbeatRead.value.updatedAt } catch { $heartbeatUpdatedAt = 0L }
  }

  $pidMatch = $statusPid -gt 0 -and $heartbeatPid -gt 0 -and $statusPid -eq $heartbeatPid

  $brokerProcessAlive = $false
  if ($pidMatch -and $statusPid -le [int]::MaxValue) {
    try {
      $process = Get-Process -Id ([int]$statusPid) -ErrorAction Stop
      $brokerProcessAlive = $null -ne $process
    } catch {
      $brokerProcessAlive = $false
    }
  }

  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $heartbeatAgeMs = if ($heartbeatUpdatedAt -gt 0) { $nowMs - $heartbeatUpdatedAt } else { [int64]::MaxValue }
  $heartbeatFresh = $heartbeatUpdatedAt -gt 0 -and $heartbeatAgeMs -ge 0 -and $heartbeatAgeMs -le $HeartbeatMaxAgeMs

  $lockGenerationAbsent = $lockState -eq 'MISSING' -or $lockState -eq 'RELEASED'
  $exactGenerationMismatchGate = $brokerProcessAlive -and $heartbeatFresh -and $pidMatch -and $lockGenerationAbsent

  return [pscustomobject]@{
    workDir = $workDirFull
    runtimeDir = $runtimeDir
    brokerStateDir = $brokerStateDir
    statusPath = $statusPath
    heartbeatPath = $heartbeatPath
    startupRunnerLockPath = $startupRunnerLockPath
    statusReadState = if ([bool]$statusRead.ok) { 'OK' } else { [string]$statusRead.error }
    heartbeatReadState = if ([bool]$heartbeatRead.ok) { 'OK' } else { [string]$heartbeatRead.error }
    statusBrokerPid = $statusPid
    heartbeatBrokerPid = $heartbeatPid
    heartbeatUpdatedAt = $heartbeatUpdatedAt
    heartbeatAgeMs = $heartbeatAgeMs
    brokerProcessAlive = $brokerProcessAlive
    brokerHeartbeatFresh = $heartbeatFresh
    brokerStatusPidMatch = $pidMatch
    startupRunnerLockState = $lockState
    exactGenerationMismatchGate = $exactGenerationMismatchGate
  }
}
