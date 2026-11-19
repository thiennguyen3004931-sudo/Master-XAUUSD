@echo off
chcp 65001 >nul
title XAUUSD AI MASTER - DONG BO GITHUB AN TOAN
cd /d "%~dp0"
node ".\scripts\xauusd-one-click-launcher.mjs" git-sync
echo.
pause
