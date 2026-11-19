param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [decimal]$FixedVolume = 0.03,
  [int]$IntervalSeconds = 5,
  [string]$BridgeEnv = "",
  [string]$TelegramEnvFile = ".env.phase7b-telegram",
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717,
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path

if ([string]::IsNullOrWhiteSpace($BridgeEnv)) {
  $BridgeEnv = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo"
}
if (-not [System.IO.Path]::IsPathRooted($TelegramEnvFile)) {
  $TelegramEnvFile = Join-Path $ProjectRoot $TelegramEnvFile
}
if (-not (Test-Path $BridgeEnv)) { throw "Bridge DEMO env missing: $BridgeEnv" }
if (-not (Test-Path $TelegramEnvFile)) { throw "Telegram env missing: $TelegramEnvFile" }
$BridgeEnv = (Resolve-Path $BridgeEnv).Path
$TelegramEnvFile = (Resolve-Path $TelegramEnvFile).Path

$bridgeScript = Join-Path $PSScriptRoot "run-phase7b-bridge-service.ps1"
$botScript = Join-Path $PSScriptRoot "run-phase7b-demo-autostart-wrapper.ps1"
$telegramScript = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier-local.ps1"
$webScript = Join-Path $PSScriptRoot "run-phase7b-web-autostart.ps1"
foreach ($required in @($bridgeScript, $botScript, $telegramScript, $webScript)) {
  if (-not (Test-Path $required)) { throw "Required Phase 7B autostart script missing: $required" }
}

$bridgePython = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.venv\Scripts\python.exe"
if (-not (Test-Path $bridgePython)) {
  throw "Bridge .venv missing. Start the bridge manually once before installing autostart."
}

$taskBridge = "XAUUSD-Phase7B-Bridge"
$taskBot = "XAUUSD-Phase7B-Bot"
$taskTelegram = "XAUUSD-Phase7B-Telegram"
$taskWeb = "XAUUSD-Phase7B-Web"
$currentUser = "$env:USERDOMAIN\$env:USERNAME"

function Quote-Arg([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Register-Phase7BTask {
  param(
    [Parameter(Mandatory = $true)] [string]$TaskName,
    [Parameter(Mandatory = $true)] [string]$ScriptPath,
    [Parameter(Mandatory = $true)] [string]$Arguments,
    [Parameter(Mandatory = $true)] [string]$Description
  )

  $actionArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $(Quote-Arg $ScriptPath) $Arguments"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs -WorkingDirectory $ProjectRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 20 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $Description
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  Write-Host "PHASE7B_AUTOSTART_TASK_INSTALLED=$TaskName"
}

$bridgeArgs = "-EnvFile $(Quote-Arg $BridgeEnv)"
$botArgs = "-WorkDir $(Quote-Arg $WorkDir) -FixedVolume $FixedVolume -IntervalSeconds $IntervalSeconds -BridgeEnv $(Quote-Arg $BridgeEnv) -TelegramEnvFile $(Quote-Arg $TelegramEnvFile)"
$telegramArgs = "-WorkDir $(Quote-Arg $WorkDir) -EnvFile $(Quote-Arg $TelegramEnvFile) -IntervalSeconds 2"
$webArgs = "-WorkDir $(Quote-Arg $WorkDir) -BridgeEnv $(Quote-Arg $BridgeEnv) -ApiPort $ApiPort -WebPort $WebPort"

Register-Phase7BTask -TaskName $taskBridge -ScriptPath $bridgeScript -Arguments $bridgeArgs -Description "XAUUSD AI MASTER Phase 7B DEMO MT5 bridge. Real account opt-in remains disabled."
Register-Phase7BTask -TaskName $taskTelegram -ScriptPath $telegramScript -Arguments $telegramArgs -Description "XAUUSD AI MASTER Phase 7B Telegram journal notifier. Read-only; no MT5 order permission."
Register-Phase7BTask -TaskName $taskBot -ScriptPath $botScript -Arguments $botArgs -Description "XAUUSD AI MASTER Phase 7B DEMO bot. Hard-locked to DEMO account allow-list."
Register-Phase7BTask -TaskName $taskWeb -ScriptPath $webScript -Arguments $webArgs -Description "XAUUSD AI MASTER Phase 7B local Web API/UI on 127.0.0.1 only."

Write-Host "PHASE7B_AUTOSTART_MODE=AT_LOGON"
Write-Host "PHASE7B_AUTOSTART_USER=$currentUser"
Write-Host "PHASE7B_AUTOSTART_BOT_TASK=$taskBot"
Write-Host "PHASE7B_AUTOSTART_TELEGRAM_TASK=$taskTelegram"
Write-Host "PHASE7B_AUTOSTART_BRIDGE_TASK=$taskBridge"
Write-Host "PHASE7B_AUTOSTART_WEB_TASK=$taskWeb"
Write-Host "PHASE7B_AUTOSTART_WEB_API=http://127.0.0.1:$ApiPort"
Write-Host "PHASE7B_AUTOSTART_WEB_UI=http://127.0.0.1:$WebPort"
Write-Host "PHASE7B_AUTOSTART_REAL_ACCOUNT_ALLOWED=false"
Write-Host "PHASE7B_AUTOSTART_INSTALL_STATUS=PASS"

if ($StartNow) {
  Start-ScheduledTask -TaskName $taskBridge
  Start-ScheduledTask -TaskName $taskWeb
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $taskTelegram
  Start-ScheduledTask -TaskName $taskBot
  Write-Host "PHASE7B_AUTOSTART_START_NOW=REQUESTED"
}
