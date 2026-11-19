param(
  [int]$WebPort = 5717
)

$ErrorActionPreference = "Stop"
$desktop = [Environment]::GetFolderPath("Desktop")
$oldLnk = Join-Path $desktop "XAUUSD AI MASTER DEMO.lnk"
$urlPath = Join-Path $desktop "XAUUSD AI MASTER DEMO.url"
$opsUrl = "http://127.0.0.1:$WebPort/phase7b-ops"

# Remove the old WScript/VBScript launcher shortcut because endpoint security may
# block the VBScript -> PowerShell process chain. V21 uses a plain Internet
# Shortcut and never launches PowerShell, VBScript, cmd.exe, or wscript.exe when
# the user clicks the desktop icon.
Remove-Item -LiteralPath $oldLnk -Force -ErrorAction SilentlyContinue

$content = @(
  "[InternetShortcut]",
  "URL=$opsUrl",
  "IconFile=$env:SystemRoot\\System32\\SHELL32.dll",
  "IconIndex=13"
) -join "`r`n"

[System.IO.File]::WriteAllText($urlPath, $content + "`r`n", (New-Object System.Text.UTF8Encoding($false)))

if (-not (Test-Path -LiteralPath $urlPath)) {
  throw "Failed to create desktop Internet Shortcut: $urlPath"
}

Write-Host "PHASE7B_V21_DESKTOP_SHORTCUT=$urlPath"
Write-Host "PHASE7B_V21_DESKTOP_URL=$opsUrl"
Write-Host "PHASE7B_V21_CLICK_LAUNCHES_POWERSHELL=false"
Write-Host "PHASE7B_V21_CLICK_LAUNCHES_VBSCRIPT=false"
Write-Host "PHASE7B_V21_CLICK_LAUNCHES_WSCRIPT=false"
Write-Host "PHASE7B_V21_ENDPOINT_SECURITY_COMPAT_MODE=DIRECT_URL"
Write-Host "PHASE7B_V21_CORE_AUTOSTART_ASSUMED=WINDOWS_SCHEDULED_TASK"
Write-Host "PHASE7B_V21_BOT_AUTOSTART=false"
Write-Host "PHASE7B_V21_TELEGRAM_AUTOSTART=false"
Write-Host "PHASE7B_V21_DESKTOP_SHORTCUT_INSTALL=PASS"
