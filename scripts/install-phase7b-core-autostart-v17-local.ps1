param(
  [string]$TaskName = "XAUUSD-Phase7B-Core",
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$StartupScript = Join-Path $PSScriptRoot "start-phase7b-core-background-v17-local.ps1"
$OpsUrl = "http://127.0.0.1:5717/phase7b-ops"

if (-not (Test-Path $StartupScript)) {
  throw "Missing startup script: $StartupScript"
}

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartupScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "XAUUSD Phase7B DEMO core: Bridge + API + Web background. Bot/Telegram only start from Web button." `
  -Force | Out-Null

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "XAUUSD AI MASTER DEMO.url"
$shortcut = @"
[InternetShortcut]
URL=$OpsUrl
IconFile=%SystemRoot%\System32\SHELL32.dll
IconIndex=13
"@
[System.IO.File]::WriteAllText($shortcutPath, $shortcut, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "PHASE7B_V17_AUTOSTART_TASK=$TaskName"
Write-Host "PHASE7B_V17_AUTOSTART_TRIGGER=WINDOWS_LOGON"
Write-Host "PHASE7B_V17_AUTOSTART_CORE=BRIDGE_API_WEB"
Write-Host "PHASE7B_V17_BOT_AUTOSTART=False"
Write-Host "PHASE7B_V17_TELEGRAM_AUTOSTART=False"
Write-Host "PHASE7B_V17_DESKTOP_SHORTCUT=$shortcutPath"
Write-Host "PHASE7B_V17_OPS_URL=$OpsUrl"
Write-Host "PHASE7B_V17_REAL_ACCOUNT_ALLOWED=False"

if ($StartNow) {
  Write-Host "PHASE7B_V17_CORE_START_NOW=STARTING"
  Start-ScheduledTask -TaskName $TaskName
  $ready = $false
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-WebRequest -Uri $OpsUrl -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
  }
  if (-not $ready) {
    throw "Core task was started but Web did not become ready within 60 seconds. Check .runtime\phase7b-core-background.log"
  }
  Write-Host "PHASE7B_V17_CORE_START_NOW=PASS"
  Start-Process $OpsUrl
}

Write-Host "PHASE7B_V17_AUTOSTART_INSTALL=PASS"
