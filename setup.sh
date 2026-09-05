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

SPACETIME="${HOME}/.local/bin/spacetime"
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

# 3. Install client deps (idempotent)
echo ""
echo "==> Installing client dependencies…"
cd src
npm install --silent
cd ..

# 4. Run the demo client
echo ""
echo "==> Running demo client (Ctrl-C to stop)…"
MODULE_NAME="${MODULE_NAME}" npx --prefix src tsx src/client.ts
