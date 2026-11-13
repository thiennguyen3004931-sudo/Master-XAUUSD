$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Preflight = Join-Path $PSScriptRoot "preflight-phase7c-live-switch-local.ps1"
$Recovery = Join-Path $PSScriptRoot "recover-phase7c-demo-after-failed-switch-local.ps1"
$GuardedSwitch = Join-Path $PSScriptRoot "switch-phase7c-live-guarded-local.ps1"
$AccountSwitcher = Join-Path $PSScriptRoot "switch-phase7c-account-mode-local.ps1"
$ExecutorStopper = Join-Path $PSScriptRoot "stop-phase7c-executors-local.ps1"

foreach ($target in @($Preflight, $Recovery, $GuardedSwitch, $AccountSwitcher, $ExecutorStopper)) {
  if (-not (Test-Path -LiteralPath $target)) { throw "Required source file missing: $target" }
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($target, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { throw "PowerShell parse failed for $target : $($errors -join '; ')" }
}

$preflight = Get-Content -LiteralPath $Preflight -Raw
$recovery = Get-Content -LiteralPath $Recovery -Raw
$guarded = Get-Content -LiteralPath $GuardedSwitch -Raw
$accountSwitcher = Get-Content -LiteralPath $AccountSwitcher -Raw
$stopper = Get-Content -LiteralPath $ExecutorStopper -Raw

function Require([string]$Text, [string]$Pattern, [string]$Message) {
  if ($Text -notmatch $Pattern) { throw $Message }
}
function Forbid([string]$Text, [string]$Pattern, [string]$Message) {
  if ($Text -match $Pattern) { throw $Message }
}

Require $preflight 'PHASE7C_LIVE_SWITCH_PREFLIGHT_SELECTED_RUNTIME=DEMO' "Preflight must require selected DEMO."
Require $preflight 'PHASE7C_LIVE_SWITCH_PREFLIGHT_BOT_MODE=PAUSE' "Preflight must require PAUSE."
Require $preflight 'Assert-Phase7CLiveRiskProfileBinding' "Preflight must recheck LIVE risk binding."
Require $preflight 'terminal_info\.trade_allowed' "Preflight must inspect terminal Algo Trading permission."
Require $preflight 'account\.trade_allowed' "Preflight must inspect account trading permission."
Require $preflight 'account\.trade_expert' "Preflight must inspect account Expert permission."
Require $preflight 'PHASE7C_LIVE_SWITCH_TERMINAL_AUTOTRADING=DISABLED' "Preflight must fail closed when terminal Algo Trading is disabled."
Require $preflight 'Get-Phase7CLiveArmPath' "Preflight must require LIVE arm absent."
Forbid $preflight 'order_send|/v1/orders/place|/v1/positions/close|/v1/positions/modify' "Preflight must remain read-only."
Forbid $preflight 'Start-ScheduledTask|Stop-ScheduledTask' "Preflight must not mutate runtime Scheduled Tasks."

Require $recovery 'Set-BotPause "failed-account-switch-recovery"' "Recovery must force PAUSE first."
Require $recovery 'Clear-Phase7CLiveArmState.+failed-account-switch-recovery' "Recovery must DISARM LIVE."
Forbid $recovery 'Stop-ScheduledTask -TaskName \$ExecutorTaskName' "Recovery must keep the SYSTEM lifecycle broker task running."
Forbid $recovery 'Start-ScheduledTask -TaskName \$ExecutorTaskName' "Recovery must not boot the executor Scheduled Task directly."
Require $recovery 'Ensure-ExecutorsStoppedThroughLifecycle' "Recovery must stop executor generations through canonical lifecycle control."
Require $recovery 'api/v1/phase7c/lifecycle/stop' "Recovery must request executor STOP through the canonical lifecycle API when runtime is active."
Require $recovery 'desiredExecutorState' "Recovery must verify canonical executor desired state."
Require $recovery 'Stop-ScheduledTask -TaskName \$BridgeTaskName' "Recovery must stop bridge task."
Require $recovery 'Stop-VerifiedBridgeListener' "Recovery must stop only a verified bridge listener."
Require $recovery 'PHASE7C_DEMO_RECOVERY_BRIDGE_LISTENER_PROOF=PASS' "Recovery must print listener ownership proof."
Require $recovery 'accountMode = "DEMO"' "Recovery must restore DEMO account state."
Require $recovery 'liveExecutionEnabled = \$false' "Recovery must restore account state LIVE execution false."
Require $recovery '\$configOut\["accountMode"\] = "DEMO"' "Recovery must restore DEMO task config."
Require $recovery '\$configOut\["liveExecutionEnabled"\] = \$false' "Recovery must disable LIVE in task config."
Require $recovery 'Start-ScheduledTask -TaskName \$BridgeTaskName' "Recovery must restart DEMO bridge task."
Require $recovery 'api/v1/phase7c/lifecycle' "Recovery must use canonical lifecycle broker status."
Require $recovery 'broker\.ready' "Recovery must prove lifecycle broker READY before executor lifecycle mutation."
Require $recovery 'api/v1/phase7c/lifecycle/start' "Recovery must request executor START through the canonical lifecycle API."
Require $recovery 'PHASE7C_DEMO_RECOVERY_LIFECYCLE_START=PASS' "Recovery must audit successful canonical lifecycle START."
Require $recovery 'ExpectedAccountMode DEMO' "Recovery must strictly verify DEMO runtime."
Require $recovery 'PHASE7C_DEMO_RECOVERY_STATUS=PASS' "Recovery PASS marker is missing."
Forbid $recovery 'arm-phase7c-live-local\.ps1|Write-Phase7CLiveArmState' "Recovery must never arm LIVE."
Forbid $recovery 'order_send|/v1/orders/place|/v1/positions/close|/v1/positions/modify' "Recovery must not send broker mutations."

Forbid $accountSwitcher 'Start-ScheduledTask -TaskName \$ExecutorTaskName' "Account switch must not boot the SYSTEM lifecycle broker task implicitly."
Forbid $accountSwitcher 'Stop-ScheduledTask -TaskName \$ExecutorTaskName' "Account switch must not stop the SYSTEM lifecycle broker task."
Require $accountSwitcher 'Stop-ExecutorsThroughLifecycle' "Account switch must stop executor generations through canonical lifecycle control."
Require $accountSwitcher 'api/v1/phase7c/lifecycle/stop' "Account switch must request canonical executor STOP."
Require $accountSwitcher 'desiredExecutorState' "Account switch must verify canonical executor desired state."
Require $accountSwitcher 'api/v1/phase7c/lifecycle' "Account switch must use canonical lifecycle broker status."
Require $accountSwitcher 'broker\.ready' "Account switch must prove lifecycle broker READY before executor lifecycle mutation."
Require $accountSwitcher 'api/v1/phase7c/lifecycle/start' "Account switch must request executor START through the canonical lifecycle API."
Require $accountSwitcher 'PHASE7C_ACCOUNT_SWITCH_LIFECYCLE_START=PASS' "Account switch must audit successful canonical lifecycle START."

Require $guarded '\[switch\]\$ConfirmLiveExecution' "Guarded switch must require explicit confirmation."
Require $guarded 'if \(-not \$ConfirmLiveExecution\)' "Guarded switch confirmation must fail closed."
Require $guarded '& \$Preflight' "Guarded switch must run switch preflight."
Require $guarded '& \$Switcher' "Guarded switch must invoke canonical switcher only after preflight."
Require $guarded '& \$Recovery' "Guarded switch must invoke deterministic recovery on failure."
Require $guarded 'PHASE7C_GUARDED_LIVE_SWITCH_LIVE_ARM=DISARMED' "Guarded switch must finish DISARMED."
Require $guarded 'EXPLICIT_LIVE_ARM_APPROVAL_REQUIRED' "Guarded switch must preserve separate ARM approval boundary."
Forbid $guarded 'arm-phase7c-live-local\.ps1|Write-Phase7CLiveArmState' "Guarded switch must never arm LIVE."
Forbid $guarded 'order_send|/v1/orders/place|/v1/positions/close|/v1/positions/modify' "Guarded switch must not directly contain broker mutation paths."

Require $stopper 'PHASE7C_EXECUTOR_STOP=PASS' "Executor stopper PASS marker is missing."
Require $stopper '(?ms)PHASE7C_EXECUTOR_STOP=PASS.*?exit 0' "Executor stopper must explicitly return exit code 0 after successful cleanup so callers do not inherit stale native LASTEXITCODE values."
Require $stopper '(?ms)PHASE7C_EXECUTOR_STOP=FAIL.*?exit 1' "Executor stopper must retain explicit failure exit code 1."
Require $stopper 'function Wait-Phase7CProcessGone' "Executor stopper must wait for asynchronous Windows process teardown."
Require $stopper 'Wait-Phase7CProcessGone \$ProcessId \$startTicks 5000' "Executor stopper must provide an initial shutdown grace period before reporting failure."
Require $stopper 'Wait-Phase7CProcessGone \$ProcessId \$startTicks 3000' "Executor stopper must recheck after Stop-Process escalation."
Require $stopper 'Get-Phase7CProcessStartTicks' "Executor stopper must bind shutdown verification to the original PID identity."
Forbid $stopper 'Start-Sleep -Milliseconds 150' "Executor stopper must not use the old 150 ms one-shot teardown check."

$preflightIndex = $guarded.IndexOf('& $Preflight')
$switchIndex = $guarded.IndexOf('& $Switcher')
if ($preflightIndex -lt 0 -or $switchIndex -lt 0 -or $preflightIndex -gt $switchIndex) {
  throw "Guarded LIVE switch must execute preflight before canonical switcher."
}

Write-Host "PHASE7C_LIVE_SWITCH_RECOVERY_SOURCE_TEST=PASS"
