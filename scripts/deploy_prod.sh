#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
cd "$ROOT_DIR"
"$ROOT_DIR/scripts/backup.sh" prod || true
pkill -f "node server.js" || true
nohup node server.js >/tmp/zero_prod.out 2>&1 &
sleep 1
code=$(curl -s -o /tmp/resp.json -w "%{http_code}" "http://localhost:5174/api/health")
if [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; then echo "Prod deploy OK"; exit 0; else echo "Prod deploy FAIL ($code)"; cat /tmp/resp.json; exit 1; fi
