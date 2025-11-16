#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${1:-http://localhost:6174}"
check(){
  local path="$1"
  echo "Testing $BASE_URL$path"
  code=$(curl -s -o /tmp/resp.json -w "%{http_code}" "$BASE_URL$path")
  if [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; then
    echo "OK $path ($code)"
  else
    echo "FAIL $path ($code)"; cat /tmp/resp.json; exit 1
  fi
}
check "/api/health"
check "/api/ops/summary"
check "/api/eflib"
check "/api/reports/list"
check "/api/tasks"
