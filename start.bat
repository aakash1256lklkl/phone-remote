@echo off
title Phone Remote
where python >nul 2>nul
if %errorlevel% neq 0 (
  echo Python not found. Install it from python.org first.
  pause
  exit /b 1
)

set DIR=%~dp0
cd /d "%DIR%"

echo Checking dependencies...
python -c "import websockets, pyautogui, qrcode" >nul 2>nul
if %errorlevel% neq 0 (
  echo Installing dependencies...
  python -m pip install -r requirements.txt
)

echo Starting Phone Remote...
python server.py
pause
