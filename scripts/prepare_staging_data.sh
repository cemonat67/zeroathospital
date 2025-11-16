#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
cd "$ROOT_DIR"
if [ ! -d "data_staging" ]; then
  cp -R data data_staging
  echo "Staging data initialized from prod."
else
  echo "data_staging already exists, skipping."
fi
