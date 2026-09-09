@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo Medical Inventory - Client Update
echo ==========================================

if not exist ".venv\Scripts\python.exe" (
  echo Python environment is missing. Running initial setup...
  call setup_friend_windows.bat
  if errorlevel 1 goto :failed
)

echo [1/4] Updating Python dependencies...
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :failed

echo [2/4] Installing locked frontend dependencies...
pushd frontend
call npm ci
if errorlevel 1 (
  popd
  goto :failed
)

echo [3/4] Building optimized production frontend...
call npm run build
if errorlevel 1 (
  popd
  goto :failed
)
popd

echo [4/4] Backing up and optimizing the client database...
".venv\Scripts\python.exe" scripts\optimize_client_db.py
if errorlevel 1 goto :failed

echo.
echo Client update completed successfully.
echo Use start_client_windows.bat to run the optimized application.
pause
exit /b 0

:failed
echo.
echo Update failed. The existing database and application were not replaced.
pause
exit /b 1
