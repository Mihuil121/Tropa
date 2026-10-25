#!/usr/bin/env bash
# Скачивание бинарника opera-proxy v1.31.0 для Android arm64
set -euo pipefail

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="$PROJ/modules/opera-proxy/android/src/main/jniLibs/arm64-v8a"
TARGET_SO="$TARGET_DIR/libopera_proxy.so"
HASH_FILE="$PROJ/tools/opera-proxy.sha256"

mkdir -p "$TARGET_DIR"

URL="https://github.com/Alexey71/opera-proxy/releases/download/v1.31.0/opera-proxy.android-arm64"

echo "=== Скачивание opera-proxy v1.31.0 (arm64) ==="
curl -sL "$URL" -o "$TARGET_SO"
chmod +x "$TARGET_SO"

if [ -f "$HASH_FILE" ]; then
  EXPECTED=$(awk '{print $1}' "$HASH_FILE" | head -n 1)
  ACTUAL=$(sha256sum "$TARGET_SO" | awk '{print $1}')
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "❌ Ошибка: SHA-256 не совпадает ($ACTUAL != $EXPECTED)"
    exit 1
  fi
  echo "✔ SHA-256 проверен: $ACTUAL"
fi

echo "✔ opera-proxy сохранён в $TARGET_SO"
