#!/usr/bin/env bash
set -euo pipefail

echo "=========================================="
echo "Medical Inventory - One-Time Setup (mac)"
echo "=========================================="

# Change to the directory where this script is located (repo root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo
echo "=== Step 1: Backend - Create virtual environment ==="
if [ -d ".venv" ]; then
  echo ".venv already exists, skipping creation..."
else
  python3.11 -m venv .venv
fi

echo
echo "=== Step 2: Backend - Install Python dependencies ==="
# shellcheck source=/dev/null
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt

echo
echo "=== Step 3: Frontend - Install Node dependencies ==="
if [ -d "frontend" ]; then
  cd frontend
  if command -v npm >/dev/null 2>&1; then
    npm ci
  else
    echo "npm not found — please install Node.js and npm first (e.g. from https://nodejs.org/)"
    exit 1
  fi
  cd - >/dev/null
else
  echo "frontend folder not found, skipping frontend install"
fi

echo
echo "=========================================="
echo "Setup complete!"
echo "Make the script executable with: chmod +x setup_friend_mac.sh"
echo "To activate the backend virtualenv: source .venv/bin/activate"
echo "Start backend and frontend using your usual commands (see README)."
echo "=========================================="
