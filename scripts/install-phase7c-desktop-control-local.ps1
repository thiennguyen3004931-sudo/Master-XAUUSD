param(
  [string]$ShortcutName = "XAUUSD AI MASTER.lnk",
  [string]$BridgeTask = "XAUUSD-Phase7B-Bridge",
  [string]$WebTask = "XAUUSD-Phase7B-Web",
  [string]$ExecutorTask = "XAUUSD-Phase7C-Executors",
  [string]$BridgeEnv = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [switch]$SkipMt5Panel,
  [switch]$KeepExecutorStartup
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot "open-phase7c-control-center-local.ps1"
$Mt5Installer = Join-Path $PSScriptRoot "install-phase7c-mt5-decision-panel-local.ps1"
if (-not (Test-Path -LiteralPath $Launcher)) { throw "Desktop Control Center launcher not found: $Launcher" }
if (-not $SkipMt5Panel -and -not (Test-Path -LiteralPath $Mt5Installer)) { throw "MT5 panel installer not found: $Mt5Installer" }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run PowerShell as Administrator to install Desktop Control Center and set manual Bot startup."
}

$bridge = Get-ScheduledTask -TaskName $BridgeTask -ErrorAction Stop
$web = Get-ScheduledTask -TaskName $WebTask -ErrorAction Stop
$webAction = @($web.Actions)
if ($webAction.Count -ne 1) { throw "Task $WebTask must have exactly one action." }
$expectedWorkDir = Join-Path $ProjectRoot ".runtime"
$arguments = [string]$webAction[0].Arguments
if ($arguments -notlike "*${expectedWorkDir}*") {
  throw "Task $WebTask is not using canonical WorkDir $expectedWorkDir. Repair it before desktop installation."
}

$executor = Get-ScheduledTask -TaskName $ExecutorTask -ErrorAction SilentlyContinue
if (-not $KeepExecutorStartup -and $null -ne $executor) {
  if ([string]$executor.State -eq "Running") {
    throw "Task $ExecutorTask is currently Running. Keep PAUSE, ensure zero XAUUSD positions and stop it before converting to manual BẬT BOT mode."
  }
  Disable-ScheduledTask -TaskName $ExecutorTask -ErrorAction Stop | Out-Null
  Write-Host "PHASE7C_DESKTOP_EXECUTOR_AUTOSTART=DISABLED_MANUAL_BUTTON_ONLY"
} elseif ($KeepExecutorStartup) {
  Write-Host "PHASE7C_DESKTOP_EXECUTOR_AUTOSTART=PRESERVED_BY_OPERATOR"
} else {
  Write-Host "PHASE7C_DESKTOP_EXECUTOR_AUTOSTART=TASK_NOT_FOUND"
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop $ShortcutName
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`""
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,13"
$shortcut.Description = "Open XAUUSD AI MASTER Control Center; Bot starts only after clicking BẬT BOT."
$shortcut.WindowStyle = 7
$shortcut.Save()

if (-not (Test-Path -LiteralPath $shortcutPath)) { throw "Desktop shortcut was not created: $shortcutPath" }

if (-not $SkipMt5Panel) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Mt5Installer -BridgeEnv $BridgeEnv
  if ($LASTEXITCODE -ne 0) { throw "MT5 decision panel installation failed with exit code $LASTEXITCODE" }
  Write-Host "PHASE7C_DESKTOP_MT5_PANEL=INSTALLED"
} else {
  Write-Host "PHASE7C_DESKTOP_MT5_PANEL=SKIPPED_BY_OPERATOR"
}

Write-Host "PHASE7C_DESKTOP_SHORTCUT=$shortcutPath"
Write-Host "PHASE7C_DESKTOP_LAUNCHER=$Launcher"
Write-Host "PHASE7C_DESKTOP_BRIDGE_TASK=$($bridge.TaskName)"
Write-Host "PHASE7C_DESKTOP_WEB_TASK=$($web.TaskName)"
Write-Host "PHASE7C_DESKTOP_WEB_START=ON_SHORTCUT_OPEN"
Write-Host "PHASE7C_DESKTOP_BOT_START=WEB_BUTTON_ONLY"
Write-Host "PHASE7C_DESKTOP_TELEGRAM=STARTS_WITH_BOT_AND_NOTIFIES"
Write-Host "PHASE7C_DESKTOP_INSTALL=PASS"
