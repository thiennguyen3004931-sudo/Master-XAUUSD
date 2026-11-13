@echo off
chcp 65001 >nul
title XAUUSD AI MASTER - BANG DIEU KHIEN 1 CHAM (GUI)
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\xauusd-gui-launcher.ps1"
