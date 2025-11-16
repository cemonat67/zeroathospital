#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${1:-http://localhost:6174}"
"$(dirname "$0")"/../test/api_smoke_tests.sh "$BASE_URL"
echo "Smoke tests passed"
