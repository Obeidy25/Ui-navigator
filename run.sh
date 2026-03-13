#!/usr/bin/env bash
# =============================================================================
# run.sh — Phoenix Shopping Sniper · Dev Server
# =============================================================================
# Starts both the Vite frontend and Express backend concurrently.
#
# Usage:
#   ./run.sh
#
# The web app will be available at:
#   Frontend: http://localhost:5173/sniper
#   API:      http://localhost:3001/api/trpc
# =============================================================================

set -euo pipefail

VENV_DIR="${VENV_PATH:-.venv}"

# ── Create Python venv if it doesn't exist ───────────────────────────
if [ ! -d "${VENV_DIR}" ]; then
    echo "📦 Creating Python virtual environment at ${VENV_DIR}..."
    python3 -m venv "${VENV_DIR}"
    echo "✅ Virtual environment created successfully!"
fi

# ── Activate Python venv ��────────────────────────────────────────────
if [ -f "${VENV_DIR}/bin/activate" ]; then
    source "${VENV_DIR}/bin/activate"
elif [ -f "${VENV_DIR}/Scripts/activate" ]; then
    source "${VENV_DIR}/Scripts/activate"
else
    echo "ERROR: Failed to find activation script in ${VENV_DIR}"
    exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Phoenix Shopping Sniper · Dev Server              ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Frontend: http://localhost:5173/sniper"
echo "  API:      http://localhost:3001/api/trpc"
echo "  Health:   http://localhost:3001/api/health"
echo ""

# ── Start dev servers ────────────────────────────────────────────────
if command -v pnpm &> /dev/null; then
    exec pnpm dev
elif command -v npm &> /dev/null; then
    exec npm run dev
else
    echo "ERROR: Neither pnpm nor npm found."
    exit 1
fi
