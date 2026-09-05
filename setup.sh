#!/usr/bin/env bash
# Quick-start script — run after spacetime login
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh <your-module-name>
#
# Example:
#   ./setup.sh wingman-demo

set -euo pipefail

# Resolve `spacetime` from PATH (portable across machines); fall back to the
# common install location only if it isn't already on PATH.
if command -v spacetime >/dev/null 2>&1; then
  SPACETIME="$(command -v spacetime)"
elif [ -x "${HOME}/.local/bin/spacetime" ]; then
  SPACETIME="${HOME}/.local/bin/spacetime"
else
  echo "error: 'spacetime' CLI not found on PATH. Install it, then re-run." >&2
  exit 1
fi

MODULE_NAME="${1:-wingman-demo}"

echo "==> Using module name: ${MODULE_NAME}"

# 1. Publish the module to Maincloud
echo ""
echo "==> Publishing module…"
cd spacetimedb
"${SPACETIME}" publish "${MODULE_NAME}" --yes
cd ..

# 2. Regenerate client bindings from the live schema
echo ""
echo "==> Generating TypeScript client bindings…"
"${SPACETIME}" generate \
  --lang typescript \
  --out-dir src/module_bindings \
  --module-path spacetimedb/spacetimedb
"${SPACETIME}" generate \
  --lang typescript \
  --out-dir orchestrator/matching/src/module_bindings \
  --module-path spacetimedb/spacetimedb

# 3. Install client deps (idempotent)
echo ""
echo "==> Installing client dependencies…"
cd src
npm install --silent
cd ..

# 4. Run the demo client (Vite dev server; Ctrl-C to stop)
echo ""
echo "==> Running demo client at http://localhost:5173 (Ctrl-C to stop)…"
VITE_MODULE_NAME="${MODULE_NAME}" npm --prefix src run dev

# ── Windows (PowerShell) ──────────────────────────────────────────────────────
# This is a bash script. On Windows run the steps directly in PowerShell:
#   $env:MODULE = "wingman-demo"
#   spacetime publish $env:MODULE --yes
#   spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb/spacetimedb
#   spacetime generate --lang typescript --out-dir orchestrator/matching/src/module_bindings --module-path spacetimedb/spacetimedb
#   npm --prefix src install
#   $env:VITE_MODULE_NAME = $env:MODULE; npm --prefix src run dev
