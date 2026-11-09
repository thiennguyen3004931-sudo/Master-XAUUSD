param(
  [string]$ShortcutName = "XAUUSD AI MASTER DEMO.lnk"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot "open-phase7b-demo-hidden-v20-local.vbs"
$OpenScript = Join-Path $PSScriptRoot "open-phase7b-demo-v19-local.ps1"

if (-not (Test-Path $Launcher)) { throw "Missing hidden launcher: $Launcher" }
if (-not (Test-Path $OpenScript)) { throw "Missing Phase7B opener: $OpenScript" }

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop $ShortcutName
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$shortcut.Arguments = "`"$Launcher`""
$shortcut.WorkingDirectory = $Root
$shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,13"
$shortcut.Description = "Open XAUUSD AI MASTER DEMO silently; start Phase7B Core when needed."
$shortcut.Save()

Write-Host "PHASE7B_V20_DESKTOP_SHORTCUT=$shortcutPath"
Write-Host "PHASE7B_V20_SHORTCUT_TARGET=$($shortcut.TargetPath)"
Write-Host "PHASE7B_V20_HIDDEN_LAUNCHER=$Launcher"
Write-Host "PHASE7B_V20_POWERSHELL_WINDOW_VISIBLE=false"
Write-Host "PHASE7B_V20_CORE_AUTOSTART_PRESERVED=true"
Write-Host "PHASE7B_V20_BOT_AUTOSTART=false"
Write-Host "PHASE7B_V20_TELEGRAM_AUTOSTART=false"
Write-Host "PHASE7B_V20_DESKTOP_SHORTCUT_INSTALL=PASS"
