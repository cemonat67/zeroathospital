#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
cd "$ROOT_DIR"
"$ROOT_DIR/scripts/backup.sh" staging || true
pkill -f "ZERO_ENV=staging node server.js" || true
env ZERO_ENV=staging nohup node server.js >/tmp/zero_staging.out 2>&1 &
sleep 1
"$ROOT_DIR/scripts/run_tests.sh" "http://localhost:6174"
echo "Staging deploy and tests completed"
