#!/usr/bin/env bash
# Загрузка в Yandex Object Storage (S3-совместимое хранилище в России).
#
# Один раз:
#   1) console.yandex.cloud → Object Storage → создать бакет (например, tropa-data),
#      доступ на чтение — публичный.
#   2) Сервисный аккаунт с ролью storage.editor → статический ключ доступа.
#   3) pip install awscli  и  aws configure --profile yandex  (ключ, секрет, регион ru-central1)
#
#   BUCKET=tropa-data bash tools/region/upload-yandex.sh
#
# Адрес для приложения:  https://storage.yandexcloud.net/<бакет>/
# (впишите его в DEFAULT_DATA_URL в src/regions.ts — тогда пользователям ничего не надо настраивать)
# Подойдёт и Selectel S3, VK Cloud, свой nginx — нужны только обычные HTTP-запросы и Range.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BUCKET="${BUCKET:?имя бакета}"
ENDPOINT="${ENDPOINT:-https://storage.yandexcloud.net}"
PROFILE="${PROFILE:-yandex}"
aws --profile "$PROFILE" --endpoint-url "$ENDPOINT" s3 sync "$HERE/out" "s3://$BUCKET/" \
  --exclude "*/region.json" --exclude "work/*" --acl public-read
# manifest.json — последним и без кэша, чтобы телефоны сразу видели обновление
aws --profile "$PROFILE" --endpoint-url "$ENDPOINT" s3 cp "$HERE/out/manifest.json" "s3://$BUCKET/manifest.json" \
  --acl public-read --cache-control "no-cache" --content-type application/json
echo "Готово: $ENDPOINT/$BUCKET/manifest.json"
