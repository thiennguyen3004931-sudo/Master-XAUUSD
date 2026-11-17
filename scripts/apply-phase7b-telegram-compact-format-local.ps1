param(
  [string]$Remote = "origin",
  [string]$Branch = "phase4-risk-entry-compression"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$CompactRelative = "scripts/run-phase7b-telegram-notifier-compact.mjs"
$CompactPath = Join-Path $Root "scripts\run-phase7b-telegram-notifier-compact.mjs"
$WrapperPath = Join-Path $Root "scripts\run-phase7b-telegram-notifier-local.ps1"

Push-Location $Root
try {
  & git fetch $Remote $Branch
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed: $LASTEXITCODE" }

  $lines = @(& git show "${Remote}/${Branch}:$CompactRelative")
  if ($LASTEXITCODE -ne 0) { throw "git show failed for $CompactRelative" }
  [System.IO.File]::WriteAllText($CompactPath, (($lines -join "`n") + "`n"), $Utf8NoBom)

  if (-not (Test-Path $WrapperPath)) { throw "Missing Telegram wrapper: $WrapperPath" }
  $wrapper = [System.IO.File]::ReadAllText($WrapperPath)
  $old = 'run-phase7b-telegram-notifier.mjs'
  $new = 'run-phase7b-telegram-notifier-compact.mjs'
  if ($wrapper.Contains($old)) {
    $wrapper = $wrapper.Replace($old, $new)
    [System.IO.File]::WriteAllText($WrapperPath, $wrapper, $Utf8NoBom)
  } elseif (-not $wrapper.Contains($new)) {
    throw "Telegram wrapper does not contain expected notifier marker."
  }

  & node --check $CompactPath
  if ($LASTEXITCODE -ne 0) { throw "Compact Telegram notifier syntax check failed: $LASTEXITCODE" }

  $verifyWrapper = [System.IO.File]::ReadAllText($WrapperPath)
  if (-not $verifyWrapper.Contains($new)) { throw "Telegram wrapper did not switch to compact notifier." }

  Write-Host "PHASE7B_TELEGRAM_COMPACT_APPLY=PASS"
  Write-Host "PHASE7B_TELEGRAM_ENTRY_MESSAGE=ENTRY_SL_TP_PLUS10_REASON"
  Write-Host "PHASE7B_TELEGRAM_TP_MEANING=PLUS10_ONE_THIRD_PARTIAL_NOT_HARD_RUNNER_TP"
  Write-Host "PHASE7B_TELEGRAM_FOLLOWUP=COMPACT_ACTION_MOVE_USD"
  Write-Host "PHASE7B_TELEGRAM_TEST_SEQUENCE=ENTRY,BE,PARTIAL,HOLD"
  Write-Host "PHASE7B_TELEGRAM_REAL_ACCOUNT_ALLOWED=False"
}
finally {
  Pop-Location
}
