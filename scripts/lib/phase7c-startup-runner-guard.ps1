function Open-Phase7CStartupRunnerLock([string]$Path) {
  Set-StrictMode -Version Latest

  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "Startup runner lock path is required."
  }

  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  try {
    $stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    throw "Another Phase7C startup runner already owns the exclusive lock: $Path"
  }

  try {
    $metadata = [pscustomobject]@{
      version = 1
      runnerPid = $PID
      acquiredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    } | ConvertTo-Json -Compress
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($metadata)
    $stream.SetLength(0)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Position = 0
    return $stream
  } catch {
    $stream.Dispose()
    throw
  }
}

function Write-Phase7CJsonAtomic(
  [Parameter(Mandatory = $true)] [string]$Path,
  [Parameter(Mandatory = $true)] $Value,
  [int]$Depth = 6
) {
  Set-StrictMode -Version Latest

  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "Atomic JSON path is required."
  }

  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  $token = "$PID.$([Guid]::NewGuid().ToString('N'))"
  $tempPath = "$Path.$token.tmp"
  $backupPath = "$Path.$token.bak"
  try {
    $json = $Value | ConvertTo-Json -Depth $Depth
    [System.IO.File]::WriteAllText(
      $tempPath,
      $json,
      [System.Text.UTF8Encoding]::new($false)
    )

    if ([System.IO.File]::Exists($Path)) {
      $replaceAttempt = 0
      $replaceMaxAttempts = 21
      while ($true) {
        $replaceAttempt++
        try {
          [System.IO.File]::Replace($tempPath, $Path, $backupPath)
          break
        } catch {
          $deepest = $_.Exception
          while ($null -ne $deepest -and $null -ne $deepest.InnerException) {
            $deepest = $deepest.InnerException
          }
          $nativeCode = if ($null -ne $deepest) { $deepest.HResult -band 0xFFFF } else { -1 }
          $retryableSharingViolation = (
            $null -ne $deepest -and
            $deepest -is [System.IO.IOException] -and
            $nativeCode -in @(32, 33)
          )
          if (-not $retryableSharingViolation -or $replaceAttempt -ge $replaceMaxAttempts) {
            throw
          }
          Start-Sleep -Milliseconds 25
        }
      }
      if ([System.IO.File]::Exists($backupPath)) {
        [System.IO.File]::Delete($backupPath)
      }
    } else {
      [System.IO.File]::Move($tempPath, $Path)
    }
  } finally {
    foreach ($candidate in @($tempPath, $backupPath)) {
      if ([System.IO.File]::Exists($candidate)) {
        Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
      }
    }
  }
}
