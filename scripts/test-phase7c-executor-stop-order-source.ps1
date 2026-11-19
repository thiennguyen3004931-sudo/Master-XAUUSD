$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Stopper = Join-Path $PSScriptRoot "stop-phase7c-executors-local.ps1"

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) {
    throw "PowerShell syntax error in ${Path}: $($errors[0].Message)"
  }
}

Assert-True (Test-Path -LiteralPath $Stopper -PathType Leaf) "Missing Phase7C executor stopper: $Stopper"
Assert-PowerShellSyntax $Stopper

$stopperText = (Get-Content -LiteralPath $Stopper -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

$supervisorStop = 'Stop-PidFile (Join-Path $RuntimeDir "supervisor.pid") "SUPERVISOR"'
$tradeNotifierStop = 'Stop-PidFile (Join-Path $RuntimeDir "trade-notifier.pid") "TRADE_NOTIFIER"'
$telegramStop = 'Stop-PidFile (Join-Path $RuntimeDir "telegram-mode.pid") "TELEGRAM_MODE"'
$regimeStop = 'Stop-PidFile (Join-Path $RuntimeDir "regime-notifier.pid") "REGIME_NOTIFIER"'
$trendStop = 'Stop-PidFile (Join-Path $RuntimeDir "trend.pid") "TREND"'
$sidewayStop = 'Stop-PidFile (Join-Path $RuntimeDir "sideway.pid") "SIDEWAY"'

$supervisorIndex = $stopperText.IndexOf($supervisorStop, [System.StringComparison]::Ordinal)
Assert-True ($supervisorIndex -ge 0) "executor stopper must explicitly stop the supervisor PID file"

foreach ($contract in @(
  @{ Label = "trade notifier"; Text = $tradeNotifierStop },
  @{ Label = "Telegram mode"; Text = $telegramStop },
  @{ Label = "regime notifier"; Text = $regimeStop },
  @{ Label = "Trend"; Text = $trendStop },
  @{ Label = "Sideway"; Text = $sidewayStop }
)) {
  $childIndex = $stopperText.IndexOf([string]$contract.Text, [System.StringComparison]::Ordinal)
  Assert-True ($childIndex -ge 0) "executor stopper must clean up the $($contract.Label) PID file"
  Assert-True ($supervisorIndex -lt $childIndex) "executor stopper must stop supervisor before $($contract.Label) so watchdog cannot respawn children during shutdown"
}

$tradeNotifierOrphan = 'Stop-OrphanNodeProcess "run-phase7b-telegram-notifier.mjs" "TRADE_NOTIFIER"'
Assert-True ($stopperText.Contains($tradeNotifierOrphan)) "executor stopper orphan cleanup must include the trade notifier Node process"

# PID files can disappear while their canonical PowerShell launcher processes are
# still alive. Orphan reconciliation must therefore be bounded to exact canonical
# wrapper paths instead of broadly terminating powershell.exe processes.
Assert-True ($stopperText.Contains('function Stop-OrphanPowerShellProcess')) "executor stopper must define bounded orphan PowerShell wrapper cleanup"
Assert-True ($stopperText.Contains('[System.IO.Path]::GetFullPath($ScriptPath)')) "orphan PowerShell cleanup must canonicalize the exact wrapper script path"
Assert-True ($stopperText.Contains("Name='powershell.exe'")) "orphan PowerShell cleanup must inspect Windows PowerShell wrapper processes"
Assert-True ($stopperText.Contains("Name='pwsh.exe'")) "orphan PowerShell cleanup must inspect PowerShell 7 wrapper processes without broad process termination"

foreach ($contract in @(
  @{ Label = "supervisor"; Text = 'Stop-OrphanPowerShellProcess (Join-Path $PSScriptRoot "run-phase7c-executors-local.ps1") "SUPERVISOR"' },
  @{ Label = "Trend"; Text = 'Stop-OrphanPowerShellProcess (Join-Path $PSScriptRoot "run-phase7c-trend-controller-local.ps1") "TREND"' },
  @{ Label = "Sideway"; Text = 'Stop-OrphanPowerShellProcess (Join-Path $PSScriptRoot "run-phase7c-sideway-controller-local.ps1") "SIDEWAY"' },
  @{ Label = "Telegram mode"; Text = 'Stop-OrphanPowerShellProcess (Join-Path $PSScriptRoot "run-phase7c-telegram-mode-controller-local.ps1") "TELEGRAM_MODE"' },
  @{ Label = "regime notifier"; Text = 'Stop-OrphanPowerShellProcess (Join-Path $PSScriptRoot "run-phase7c-regime-notifier-local.ps1") "REGIME_NOTIFIER"' }
)) {
  Assert-True ($stopperText.Contains([string]$contract.Text)) "executor stopper must boundedly reconcile orphan $($contract.Label) PowerShell wrapper by exact canonical script path"
}

Write-Host "PHASE7C_EXECUTOR_STOP_ORDER_SOURCE_TEST=PASS"
