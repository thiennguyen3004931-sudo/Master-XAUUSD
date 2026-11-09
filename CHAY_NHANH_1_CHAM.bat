@echo off
chcp 65001 >nul
title XAUUSD AI MASTER V5 - MAY CHU WEB :5717 + KET NOI TRUC TIEP MT5 (XAUUSD.G)
cd /d "%~dp0"

echo ===========================================================================
echo   XAUUSD AI MASTER V5 - KHOI DONG CONG :5717 VA KET NOI TRUC TIEP MT5
echo ===========================================================================
echo.
echo   [1/3] Dang giai phong cong :5717 va :3711 khoi cac tien trinh cu...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5717,3711 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

echo   [2/3] Dang kiem tra thu vien Python MetaTrader5...
python -m pip install --quiet MetaTrader5 2>nul
py -3 -m pip install --quiet MetaTrader5 2>nul

REM Mo trinh duyet sau 2 giay
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:5717/'"

echo   [3/3] Dang bat May chu Giao dich V5 tai: http://localhost:5717/
echo   -------------------------------------------------------------------------
echo   LUU Y QUAN TRONG:
echo   1. Hay mo san phan mem MetaTrader 5 (DBG Markets) va dang nhap TK #5201362
echo   2. Bam nut "Algo Trading" tren thanh cong cu MT5 chuyen sang MAU XANH LA!
echo   3. Giu cua so den nay mo trong suot qua trinh giao dich.
echo ===========================================================================
echo.

node ".\scripts\xauusd-standalone-server.mjs"
pause
