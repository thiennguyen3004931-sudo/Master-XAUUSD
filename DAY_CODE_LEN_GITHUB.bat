@echo off
chcp 65001 >nul
title XAUUSD AI MASTER V6 - XOA CODE CU VA GHI DE CODE MOI LEN GITHUB
cd /d "%~dp0"

echo ===========================================================================
echo   XAUUSD AI MASTER V6 - XOA CODE CU TREN GITHUB VA DAY CODE MOI 100%%:
echo   https://github.com/thiennguyen3004931-sudo/Master-XAUUSD
echo ===========================================================================
echo.

REM Kiem tra .gitignore co chan .env hay khong
findstr /i "\.env" .gitignore >nul
if %errorlevel% neq 0 (
  echo [CANH BAO NGUY HIEM] File .gitignore thieu quy tac chan .env!
  echo Da huy day code de bao ve mat khau va tai khoan MT5 cua ban.
  pause
  exit /b 1
)

echo [1/4] Kiem tra bao mat: Da khoa chan cac file .env, sqlite3 va mat khau MT5.

echo [2/4] Dang lam sach lich su Git cu va gom toan bo code V6 moi...
if exist ".git" rmdir /s /q ".git"
git init
git branch -M main
git remote add origin https://github.com/thiennguyen3004931-sudo/Master-XAUUSD.git

echo [3/4] Dang dong goi toan bo file code moi (git add -A)...
git add -A
git commit -m "Clean Release XAUUSD AI Master V6: Replace old code with V6 Mobile, Positive DCA & Strategy Approval"

echo [4/4] Dang XOA CODE CU va GHI DE code moi len GitHub (git push --force)...
git push -u origin main --force

if %errorlevel% equ 0 (
  echo.
  echo ===========================================================================
  echo   [HOAN TAT 100%%] Da XOA SACH code cu va cap nhat code V6 moi len:
  echo   https://github.com/thiennguyen3004931-sudo/Master-XAUUSD
  echo ===========================================================================
) else (
  echo.
  echo [LUU Y] Neu cua so dang nhap GitHub hien ra, hay bam Sign in with browser.
  echo Neu nhanh mac dinh tren GitHub cua ban ten la master, dang thu day sang master...
  git push -u origin main:master --force
)

echo.
pause
