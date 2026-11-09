param(
  [string]$TaskName = "XAUUSD-Phase7B-Core",
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$StartupScript = Join-Path $PSScriptRoot "start-phase7b-core-background-v19-local.ps1"
$OpenScript = Join-Path $PSScriptRoot "open-phase7b-demo-v19-local.ps1"
$OpsUrl = "http://127.0.0.1:5717/phase7b-ops"

if (-not (Test-Path $StartupScript)) { throw "Missing startup script: $StartupScript" }
if (-not (Test-Path $OpenScript)) { throw "Missing opener script: $OpenScript" }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "Run this installer once from PowerShell 'Run as Administrator'."
}

$userId = $identity.Name
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument (
  "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartupScript`""
)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType Interactive `
  -RunLevel Highest

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "XAUUSD Phase7B DEMO core v19: Bridge + fresh API + fresh Web in background. Bot/Telegram start only from Web." `
  -Force | Out-Null

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "XAUUSD AI MASTER DEMO.lnk"
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$OpenScript`""
$shortcut.WorkingDirectory = $Root
$shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,13"
$shortcut.Description = "Open XAUUSD AI MASTER DEMO; start core automatically if Web is not ready."
$shortcut.Save()

Write-Host "PHASE7B_V19_AUTOSTART_TASK=$TaskName"
Write-Host "PHASE7B_V19_AUTOSTART_TRIGGER=WINDOWS_LOGON"
Write-Host "PHASE7B_V19_AUTOSTART_CORE=BRIDGE_API_WEB"
Write-Host "PHASE7B_V19_DEMO_WORK_DIR=$Root\.runtime\phase7b-demo-forward"
Write-Host "PHASE7B_V19_BOT_AUTOSTART=False"
Write-Host "PHASE7B_V19_TELEGRAM_AUTOSTART=False"
Write-Host "PHASE7B_V19_DESKTOP_SHORTCUT=$shortcutPath"
Write-Host "PHASE7B_V19_REAL_ACCOUNT_ALLOWED=False"

if ($StartNow) {
  Write-Host "PHASE7B_V19_CORE_START_NOW=STARTING"
  Start-ScheduledTask -TaskName $TaskName
  $ready = $false
  for ($attempt = 1; $attempt -le 90; $attempt++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-WebRequest -Uri $OpsUrl -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) {
        $ready = $true
        break
      }
    } catch {}
  }
  if (-not $ready) {
    throw "Core task started but Web did not become ready. Check .runtime\phase7b-core-background-v19.log"
  }
  Write-Host "PHASE7B_V19_CORE_START_NOW=PASS"
  Start-Process $OpsUrl
}

Write-Host "PHASE7B_V19_AUTOSTART_INSTALL=PASS"
