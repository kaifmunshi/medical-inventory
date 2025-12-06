@echo off
echo ==========================================
echo Medical Inventory - One-Time Setup
echo ==========================================

REM Go to the folder where this script is located (repo root)
cd /d %~dp0

echo.
echo === Step 1: Backend - Create virtual environment ===
if exist .venv (
    echo .venv already exists, skipping creation...
) else (
    python -m venv .venv
)

echo.
echo === Step 2: Backend - Install Python dependencies ===
call .venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt

echo.
echo === Step 3: Frontend - Install Node dependencies ===
cd frontend

REM Use locked versions from package-lock.json
npm ci

cd ..

echo.
echo ==========================================
echo Setup complete!
echo You can now start backend and frontend using your run .bat files.
echo ==========================================
pause
