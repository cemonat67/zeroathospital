#!/usr/bin/env bash
set -euo pipefail
ENV="${1:-prod}"
TS=$(date +%Y%m%d_%H%M%S)
ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
BACKUP_DIR="$ROOT_DIR/backup"
mkdir -p "$BACKUP_DIR"
DATA_DIR="data"
if [ "$ENV" = "staging" ]; then DATA_DIR="data_staging"; fi
OUT="$BACKUP_DIR/zero_hospital_${ENV}_${TS}.tar.gz"
LOG="$BACKUP_DIR/backup_log.jsonl"
SIZE=0
STATUS="ok"
ERR=""
{
  tar -czf "$OUT" -C "$ROOT_DIR" server.js index.html zah.html config/ops.config.json scripts "$DATA_DIR" || { STATUS="error"; ERR="tar_failed"; }
  if [ -f "$OUT" ]; then SIZE=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT" 2>/dev/null || echo 0); fi
} || true
TSISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"ts":"%s","env":"%s","file":"%s","status":"%s","size_bytes":%s%s}\n' "$TSISO" "$ENV" "$(basename "$OUT")" "$STATUS" "$SIZE" ","error_message":"$ERR""" >> "$LOG"
if [ "$STATUS" != "ok" ]; then exit 1; fi
