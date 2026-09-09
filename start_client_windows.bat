@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Missing Python environment. Run prepare_client_windows.bat first.
  pause
  exit /b 1
)

if not exist "frontend\dist\index.html" (
  echo Missing production frontend. Run prepare_client_windows.bat first.
  pause
  exit /b 1
)

echo Starting Medical Inventory backend...
start "Medical Inventory Backend" /min /D "%~dp0" ".venv\Scripts\python.exe" -m uvicorn backend.main:app --host 127.0.0.1 --port 8000

echo Starting optimized production frontend...
start "Medical Inventory Frontend" /min /D "%~dp0frontend" cmd /c "npm run preview -- --host 127.0.0.1 --port 4173"

timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:4173"
exit /b 0
