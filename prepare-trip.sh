#!/usr/bin/env bash
# Подготовка дальней поездки на компьютере (Linux): вышки вдоль всей дороги из свежей базы OpenCelliD.
#
#   bash prepare-trip.sh "Севастополь" "Москва" ТОКЕН_OPENCELLID
#
# Токен бесплатный: зарегистрируйтесь на opencellid.org → «My API Key» (или «Downloads»).
# Что получится:  ~/Tropa-cells.json  (вышки ±15 км вдоль маршрута) и ~/Tropa-route.gpx.
# Потом в телефоне: ⚙ → «Свои файлы» → «Вышки (cells.json)» → выбрать Tropa-cells.json.
# Перекинуть файл на телефон — кабелем или через Telegram «Избранное».

set -euo pipefail
FROM="${1:-}"; TO="${2:-}"; TOKEN="${3:-${OPENCELLID_TOKEN:-}}"
[ -n "$FROM" ] && [ -n "$TO" ] && [ -n "$TOKEN" ] || { echo 'Использование: bash prepare-trip.sh "Откуда" "Куда" ТОКЕН_OPENCELLID'; exit 1; }

PROJ="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$HOME/tropa-build"
[ -x "$TOOLS/node/bin/node" ] && export PATH="$TOOLS/node/bin:$PATH"
command -v node >/dev/null || { echo 'Нужен Node.js 22 — сначала запустите build-local.sh (он его скачает)'; exit 1; }
cd "$PROJ"
[ -d node_modules ] || npm ci

echo '=== 1. Маршрут ==='
node tools/plan-route.ts "$FROM" "$TO" "$HOME/Tropa-route.gpx"

echo '=== 2. База вышек России (MCC 250, ~100–300 МБ, один раз) ==='
mkdir -p "$TOOLS/ocid"
CSV="$TOOLS/ocid/250.csv.gz"
if [ ! -s "$CSV" ] || [ -n "$(find "$CSV" -mtime +14 2>/dev/null)" ]; then
  curl -fL --retry 3 -o "$CSV.part" "https://opencellid.org/ocid/downloads?token=$TOKEN&type=mcc&file=250.csv.gz"
  if ! gzip -t "$CSV.part" 2>/dev/null; then
    echo 'Сервер вернул не архив. Частые причины: неверный токен или лимит скачиваний на сегодня. Ответ:'
    head -c 300 "$CSV.part"; echo; rm -f "$CSV.part"; exit 1
  fi
  mv "$CSV.part" "$CSV"
fi

echo '=== 3. Вышки вдоль дороги (±15 км) ==='
node tools/build-cells.ts "$CSV" "$HOME/Tropa-route.gpx" "$HOME/Tropa-cells.json" 15
ls -lh "$HOME/Tropa-cells.json"
echo
echo 'Готово! Перекиньте ~/Tropa-cells.json на телефон и откройте в «Тропе»: ⚙ → Свои файлы → Вышки (cells.json).'
