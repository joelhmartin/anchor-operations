#!/bin/bash
# Local dev: backend (nodemon, port 4000) + frontend (vite, port 3000) together.
# Requires a local Postgres with the base schema + ops tables (see docs/STANDUP.md
# "Local development"). Ctrl-C stops both.
set -euo pipefail

cd "$(dirname "$0")"

lsof -ti:4000 | xargs kill -9 2>/dev/null || true

echo "Starting anchor-ops backend (port 4000) + frontend (port 3000)..."
npx nodemon server/index.js &
BACK=$!
trap 'kill $BACK 2>/dev/null || true' EXIT INT TERM

yarn start
