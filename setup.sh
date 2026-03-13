#!/usr/bin/env bash
# =============================================================================
# setup.sh — Phoenix Shopping Sniper · Full-Stack Setup
# =============================================================================
# Sets up both the Python virtual environment AND the Node.js web application.
#
# Usage (Git Bash / WSL / macOS / Linux):
#   chmod +x setup.sh
#   ./setup.sh
# =============================================================================

set -euo pipefail

VENV_DIR="${VENV_PATH:-./my_pro_chall}"
PYTHON="${PYTHON:-python3}"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Phoenix Shopping Sniper · Full-Stack Setup        ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── 1. Python Environment ────────────────────────────────────────────
echo "▸ [1/6] Checking Python virtual environment..."
if [ -d "${VENV_DIR}" ]; then
    echo "  ✓ Venv exists at ${VENV_DIR}/"
else
    echo "  Creating virtual environment at ${VENV_DIR}/ ..."
    "${PYTHON}" -m venv "${VENV_DIR}"
    echo "  ✓ Virtual environment created."
fi

# Activate venv
if [ -f "${VENV_DIR}/bin/activate" ]; then
    source "${VENV_DIR}/bin/activate"
elif [ -f "${VENV_DIR}/Scripts/activate" ]; then
    source "${VENV_DIR}/Scripts/activate"
fi
echo "  ✓ Virtual environment activated."

# ── 2. Python Dependencies ───────────────────────────────────────────
echo "▸ [2/6] Installing Python dependencies..."
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
echo "  ✓ Python dependencies installed."

# ── 3. Playwright Browser ────────────────────────────────────────────
echo "▸ [3/6] Installing Playwright Chromium..."
playwright install chromium 2>/dev/null || echo "  ⚠ Playwright install skipped (may already be installed)"
echo "  ✓ Playwright ready."

# ── 4. Node.js Dependencies ──────────────────────────────────────────
echo "▸ [4/6] Installing Node.js dependencies..."
if command -v pnpm &> /dev/null; then
    pnpm install
elif command -v npm &> /dev/null; then
    npm install
else
    echo "  ✗ Neither pnpm nor npm found. Please install Node.js."
    exit 1
fi
echo "  ✓ Node.js dependencies installed."

# ── 5. Database Setup ────────────────────────────────────────────────
echo "▸ [5/6] Setting up database..."
if command -v pnpm &> /dev/null; then
    pnpm db:push 2>/dev/null || npx drizzle-kit push 2>/dev/null || echo "  ⚠ DB push skipped (tables auto-created on startup)"
else
    npx drizzle-kit push 2>/dev/null || echo "  ⚠ DB push skipped (tables auto-created on startup)"
fi
echo "  ✓ Database ready."

# ── 6. Environment Validation ────────────────────────────────────────
echo "▸ [6/6] Validating environment..."
if [ -f ".env" ]; then
    echo "  ✓ .env file found."
    if grep -q "GEMINI_API_KEY" .env 2>/dev/null; then
        echo "  ✓ GEMINI_API_KEY configured."
    else
        echo "  ⚠ GEMINI_API_KEY not found in .env"
    fi
else
    echo "  ⚠ No .env file found. Creating template..."
    cat > .env << 'EOF'
# Phoenix Shopping Sniper · Environment Configuration
GEMINI_API_KEY=your-gemini-api-key-here
# GCS_BUCKET_NAME=your-gcs-bucket
# GCS_PROJECT_ID=your-project-id
# GCS_CREDENTIALS_PATH=./service-account.json
# VENV_PATH=./my_pro_chall
EOF
    echo "  ✓ Template .env created. Please update with your API keys."
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo " Setup complete! Start the application with:"
echo ""
echo "   ./run.sh          # or: npm run dev"
echo ""
echo " Open:  http://localhost:5173/sniper"
echo "════════════════════════════════════════════════════════"
echo ""
