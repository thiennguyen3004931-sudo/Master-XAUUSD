@echo off
chcp 65001 >nul
title XAUUSD AI MASTER - DUNG TOAN BO HE THONG
cd /d "%~dp0"
node ".\scripts\xauusd-one-click-launcher.mjs" stop
echo.
pause
