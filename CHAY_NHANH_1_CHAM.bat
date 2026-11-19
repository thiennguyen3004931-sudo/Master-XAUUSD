@echo off
chcp 65001 >nul
title XAUUSD AI MASTER V6 - MAY CHU WEB :5717 + KET NOI TRUC TIEP MT5
cd /d "%~dp0"

echo ===========================================================================
echo   XAUUSD AI MASTER V6 - KHOI DONG CONG :5717 VA KET NOI TRUC TIEP MT5
echo ===========================================================================
echo.
if not exist ".runtime" mkdir ".runtime"

echo   [1/4] Dang dung tien trinh May chu Web V6 cu tren cong :5717 va :3711 (neu co)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5717,3711 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match 'node') { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }; Start-Sleep -Milliseconds 500"

echo   [2/4] Dang khoi tao khoa dieu khien cuc bo (.runtime\v6-control-token.txt)...
for /f "usebackq delims=" %%K in (`powershell -NoProfile -Command "$f='.runtime\v6-control-token.txt'; if (Test-Path $f) { $t=(Get-Content $f -Raw).Trim() } else { $bytes=New-Object byte[] 18; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes); $t='v6_' + [BitConverter]::ToString($bytes).Replace('-','').ToLower(); Set-Content -Path $f -Value $t -Encoding UTF8 }; Set-Clipboard -Value $t -ErrorAction SilentlyContinue; Write-Output $t"`) do set "ZIQ_V6_CONTROL_TOKEN=%%K"

echo   -------------------------------------------------------------------------
echo   BAO MAT P0: Khoa V6 da luu tai .runtime\v6-control-token.txt (va copy vao Clipboard).
echo   Ma Ghep Noi 1 Lan (OTP 6 so) duoc cap tai: .runtime\v6-pairing-otp.txt
echo   -------------------------------------------------------------------------
echo.
echo   [3/4] Dang kiem tra thu vien Python MetaTrader5...
python -m pip install --quiet MetaTrader5 2>nul
py -3 -m pip install --quiet MetaTrader5 2>nul

REM Mo trinh duyet sau 2 giay
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:5717/'"

echo   [4/4] Dang bat May chu Giao dich V6 tai: http://localhost:5717/
echo   -------------------------------------------------------------------------
echo   HUONG DAN DANG NHAP VA DIEU KHIEN AN TOAN (P0):
echo   1. Khi trang Web mo len, dan khoa tu Clipboard (Ctrl+V) hoac nhap Ma OTP 6 so
echo      (xem trong file .runtime\v6-pairing-otp.txt) vao o [Ghep noi OTP / Luu Khoa].
echo   2. He thong khoi dong mac dinh o trang thai PAUSE + DISARMED.
echo   3. Bam [ARM LIVE] rieng biet neu muon cap quyen mo lenh that trong phien nay.
echo ===========================================================================
echo.

node ".\scripts\xauusd-standalone-server.mjs"
pause
