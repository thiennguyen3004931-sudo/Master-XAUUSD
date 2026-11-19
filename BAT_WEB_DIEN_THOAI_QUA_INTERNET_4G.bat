@echo off
chcp 65001 >nul
title XAUUSD AI MASTER V6 - DUONG HAM 4G/5G CHONG LOI 1033 (CHAY NGAM)
cd /d "%~dp0"

echo ===========================================================================
echo   XAUUSD AI MASTER V6 - KHOI TAO LINK 4G/5G CHONG NGAT KET NOI (ERROR 1033)
echo ===========================================================================
echo.
if not exist ".runtime" mkdir ".runtime"

for /f "usebackq delims=" %%K in (`powershell -NoProfile -Command "$f='.runtime\v6-control-token.txt'; if (Test-Path $f) { $t=(Get-Content $f -Raw).Trim() } else { $bytes=New-Object byte[] 18; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes); $t='v6_' + [BitConverter]::ToString($bytes).Replace('-','').ToLower(); Set-Content -Path $f -Value $t -Encoding UTF8 }; Write-Output $t"`) do set "ZIQ_V6_CONTROL_TOKEN=%%K"

echo   [1/3] Dang kiem tra may chu Web tai cong 127.0.0.1:5717...
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 5717 -State Listen -ErrorAction SilentlyContinue)) { Start-Process node -ArgumentList '.\scripts\xauusd-standalone-server.mjs' -WindowStyle Minimized; Start-Sleep -Seconds 3 }"

echo   [2/3] Dang khoi dong Cloudflare Tunnel o che do CHAY NGAM (HTTP/2)...
echo         (Giup ban bam Ctrl+C hoac dong cua so nay cung KHONG bi loi 1033!)

powershell -NoProfile -Command ^
  "$logFile = Join-Path (Get-Location) '.runtime\cloudflared.log'; " ^
  "if (Test-Path $logFile) { Remove-Item $logFile -Force -ErrorAction SilentlyContinue }; " ^
  "if (Get-Command cloudflared -ErrorAction SilentlyContinue) { " ^
  "  Start-Process cloudflared -ArgumentList 'tunnel','--url','http://127.0.0.1:5717','--protocol','http2','--no-autoupdate','--logfile',$logFile -WindowStyle Hidden; " ^
  "  Write-Host '  [3/3] Dang cho Cloudflare cap link HTTPS (khoang 5-7 giay)...' -ForegroundColor Cyan; " ^
  "  $url = $null; " ^
  "  for ($i=0; $i -lt 20; $i++) { " ^
  "    Start-Sleep -Seconds 1; " ^
  "    if (Test-Path $logFile) { " ^
  "      $content = Get-Content $logFile -Raw -ErrorAction SilentlyContinue; " ^
  "      if ($content -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') { $url = $matches[0]; break } " ^
  "    } " ^
  "  } " ^
  "  if ($url) { " ^
  "    Set-Content -Path '.runtime\mobile-internet-url.txt' -Value $url -Encoding UTF8; " ^
  "    Set-Clipboard -Value $url -ErrorAction SilentlyContinue; " ^
  "    Write-Host ''; " ^
  "    Write-Host '===========================================================================' -ForegroundColor Green; " ^
  "    Write-Host ('  LINK 4G/5G CUA BAN: ' + $url) -ForegroundColor Yellow; " ^
  "    Write-Host ('  KHOA DIEU KHIEN V6: ' + $env:ZIQ_V6_CONTROL_TOKEN) -ForegroundColor Cyan; " ^
  "    Write-Host '  (Link da duoc TU DONG COPY vao Clipboard - Nhap Khoa Dieu Khien V6 tren' -ForegroundColor Green; " ^
  "    Write-Host '   dien thoai de mo khoa xac thuc API Fail-Closed!)' -ForegroundColor Green; " ^
  "    Write-Host '===========================================================================' -ForegroundColor Green; " ^
  "  } else { " ^
  "    Write-Host '  Dang tiep tuc ket noi ngam... Xem link trong file .runtime\cloudflared.log' -ForegroundColor Yellow; " ^
  "  } " ^
  "} else { " ^
  "  npx --yes localtunnel --port 5717 " ^
  "}"

echo.
pause
