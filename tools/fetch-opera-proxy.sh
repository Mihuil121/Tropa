#!/usr/bin/env bash
set -euo pipefail

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
DIR_ARM64="$PROJ/modules/opera-proxy/android/src/main/jniLibs/arm64-v8a"
DIR_ARM="$PROJ/modules/opera-proxy/android/src/main/jniLibs/armeabi-v7a"
HASH_FILE="$PROJ/tools/opera-proxy.sha256"

mkdir -p "$DIR_ARM64" "$DIR_ARM"

URL_ARM64="https://github.com/Alexey71/opera-proxy/releases/download/v1.31.0/opera-proxy.android-arm64"
URL_ARM="https://github.com/Alexey71/opera-proxy/releases/download/v1.31.0/opera-proxy.android-arm"

echo "=== Скачивание opera-proxy v1.31.0 (arm64 и arm) ==="
curl -fL "$URL_ARM64" -o "$DIR_ARM64/libopera_proxy.so"
curl -fL "$URL_ARM" -o "$DIR_ARM/libopera_proxy.so"

chmod +x "$DIR_ARM64/libopera_proxy.so" "$DIR_ARM/libopera_proxy.so"

if [ -f "$HASH_FILE" ]; then
  EXPECTED_ARM64=$(grep "opera-proxy.android-arm64" "$HASH_FILE" | awk '{print $1}')
  EXPECTED_ARM=$(grep "opera-proxy.android-arm" "$HASH_FILE" | awk '{print $1}')

  ACTUAL_ARM64=$(sha256sum "$DIR_ARM64/libopera_proxy.so" | awk '{print $1}')
  ACTUAL_ARM=$(sha256sum "$DIR_ARM/libopera_proxy.so" | awk '{print $1}')

  if [ "$EXPECTED_ARM64" != "$ACTUAL_ARM64" ] || [ "$EXPECTED_ARM" != "$ACTUAL_ARM" ]; then
    echo "❌ Ошибка: SHA-256 не совпадает"
    exit 1
  fi
  echo "✔ SHA-256 проверен для обеих архитектур"
fi

echo "✔ opera-proxy успешно скачан"
