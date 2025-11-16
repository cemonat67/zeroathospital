#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
cd "$ROOT_DIR"
ENV="${1:-prod}"
FILE="${2:-}"
if [ -z "$FILE" ]; then echo "Usage: rollback.sh <env> <backup_tar.gz>"; exit 1; fi
TMPDIR=$(mktemp -d)
tar -xzf "backup/$FILE" -C "$TMPDIR" || { echo "Extraction failed"; exit 1; }
SRC_DIR="$TMPDIR/data"
if [ "$ENV" = "staging" ]; then SRC_DIR="$TMPDIR/data_staging"; fi
if [ ! -d "$SRC_DIR" ]; then echo "No data dir in backup"; exit 1; fi
DEST_DIR="$ROOT_DIR/data"
if [ "$ENV" = "staging" ]; then DEST_DIR="$ROOT_DIR/data_staging"; fi
rm -rf "$DEST_DIR" || true
cp -R "$SRC_DIR" "$DEST_DIR" || { echo "Copy failed"; exit 1; }
echo "Rollback applied to $ENV ($DEST_DIR) from $FILE"
