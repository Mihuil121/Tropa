#!/usr/bin/env bash
# Собирает данные одной области для «Тропы»: карта, дороги для встроенного Valhalla, поиск.
#
#   bash tools/region/build-region.sh crimea "Крым и Севастополь" 32.40,44.35,36.70,46.25
#
# Что нужно на компьютере (один раз, лучше Linux или VPS; Windows — через WSL):
#   • docker                      — сборка дорог Valhalla
#   • osmium-tool                 — sudo apt install osmium-tool
#   • pmtiles (go-pmtiles)        — https://github.com/protomaps/go-pmtiles/releases
#   • node 22+                    — индекс поиска
#   • russia-latest.osm.pbf       — https://download.geofabrik.de/russia-latest.osm.pbf (~3,5 ГБ)
#     (положите в tools/region/src/ или укажите путь в OSM_PBF=…)
# Сервера Geofabrik и Protomaps зарубежные: качать их удобнее на VPS за границей или с VPN —
# это делает только разработчик и один раз; пользователи потом берут готовое из России.
#
# Результат: tools/region/out/<id>/{map.pmtiles, valhalla.tar, search.json, region.json}
# Потом:     node tools/build-manifest.ts tools/region/out   и загрузить out/ в хранилище.

set -euo pipefail

ID="${1:?id области, например crimea}"
NAME="${2:?название, например \"Крым\"}"
BBOX="${3:?запад,юг,восток,север}"

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJ="$(cd "$HERE/../.." && pwd)"
OSM_PBF="${OSM_PBF:-$HERE/src/russia-latest.osm.pbf}"
# Или ссылка — скачаем сами (так делает сборка в GitHub Actions)
OSM_URL="${OSM_URL:-}"
# FLAT=1 — файлы не в папке области, а рядом с префиксом: crimea-map.pmtiles (для GitHub Releases)
FLAT="${FLAT:-0}"
# Версия Valhalla — та же, что внутри valhalla-mobile (иначе формат тайлов может не совпасть)
VALHALLA_IMAGE="${VALHALLA_IMAGE:-ghcr.io/valhalla/valhalla:3.9.1}"
# Свежая сборка карты Protomaps (дата в имени файла; список — https://maps.protomaps.com/builds/)
PROTOMAPS_BUILD="${PROTOMAPS_BUILD:-}"
MAXZOOM="${MAXZOOM:-15}"

OUT="$HERE/out/$ID"
WORK="$HERE/work/$ID"
mkdir -p "$OUT" "$WORK"

if [ -n "$OSM_URL" ]; then
  OSM_PBF="$HERE/src/$(basename "$OSM_URL")"
  mkdir -p "$HERE/src"
  [ -f "$OSM_PBF" ] || curl -fL --retry 5 -o "$OSM_PBF" "$OSM_URL"
fi
[ -f "$OSM_PBF" ] || { echo "Нет $OSM_PBF — скачайте russia-latest.osm.pbf с download.geofabrik.de"; exit 1; }

# Последняя готовая сборка карты Protomaps (выкладывается раз в день; ищем за последнюю неделю)
if [ -z "$PROTOMAPS_BUILD" ] && [ "${SKIP_MAP:-0}" != "1" ]; then
  for d in 1 2 3 4 5 6 7; do
    u="https://build.protomaps.com/$(date -u -d "-$d day" +%Y%m%d).pmtiles"
    if curl -sfI "$u" >/dev/null; then PROTOMAPS_BUILD="$u"; break; fi
  done
  [ -n "$PROTOMAPS_BUILD" ] || { echo "Не нашёл сборку Protomaps за неделю"; exit 1; }
  echo "Карта из $PROTOMAPS_BUILD"
fi
IFS=, read -r W S E N <<< "$BBOX"

echo "=== 1/4 Вырезаю область из OSM ($BBOX) ==="
osmium extract -b "$W,$S,$E,$N" "$OSM_PBF" -o "$WORK/region.osm.pbf" --overwrite --strategy=smart

echo "=== 2/4 Карта: вырезаю из сборки Protomaps (до масштаба $MAXZOOM) ==="
if [ "${SKIP_MAP:-0}" != "1" ]; then
  pmtiles extract "$PROTOMAPS_BUILD" "$OUT/map.pmtiles" --bbox="$W,$S,$E,$N" --maxzoom="$MAXZOOM"
fi

echo "=== 3/4 Дороги: тайлы Valhalla в одном tar ==="
if [ "${SKIP_ROADS:-0}" != "1" ]; then
  docker pull "$VALHALLA_IMAGE" || { echo "⚠ нет образа $VALHALLA_IMAGE — беру latest (проверьте совместимость с valhalla-mobile)"; VALHALLA_IMAGE=ghcr.io/valhalla/valhalla:latest; }
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$WORK:/data" "$VALHALLA_IMAGE" bash -lc '
    set -e
    mkdir -p /data/tiles
    valhalla_build_config \
      --mjolnir-tile-dir /data/tiles \
      --mjolnir-tile-extract /data/valhalla.tar \
      --mjolnir-timezone /data/tiles/timezones.sqlite \
      --mjolnir-admin /data/tiles/admins.sqlite > /data/valhalla.json
    valhalla_build_timezones > /data/tiles/timezones.sqlite || echo "часовые пояса не скачались — продолжаю без них"
    valhalla_build_admins -c /data/valhalla.json /data/region.osm.pbf
    valhalla_build_tiles -c /data/valhalla.json /data/region.osm.pbf
    valhalla_build_extract -c /data/valhalla.json -v --overwrite
  '
  mv -f "$WORK/valhalla.tar" "$OUT/valhalla.tar"
fi

echo "=== 4/4 Поиск адресов ==="
if [ "${SKIP_SEARCH:-0}" != "1" ]; then
  osmium tags-filter "$WORK/region.osm.pbf" nwr/name nwr/addr:housenumber -o "$WORK/named.osm.pbf" --overwrite
  osmium export "$WORK/named.osm.pbf" -f geojsonseq -o "$WORK/named.geojsonseq" --overwrite
  node "$PROJ/tools/build-search-index.ts" "$WORK/named.geojsonseq" "$OUT/search.json"
fi

printf '{"id":"%s","name":"%s","bbox":[%s,%s,%s,%s],"version":"%s"}\n' "$ID" "$NAME" "$W" "$S" "$E" "$N" "$(date -u +%Y-%m-%d)" > "$OUT/region.json"
if [ "$FLAT" = "1" ]; then
  for f in map.pmtiles valhalla.tar search.json region.json; do
    [ -f "$OUT/$f" ] && mv -f "$OUT/$f" "$HERE/out/$ID-$f"
  done
  rmdir "$OUT" 2>/dev/null || true
  ls -lh "$HERE/out/$ID-"*
else
  ls -lh "$OUT"
fi
rm -rf "$WORK" 2>/dev/null || true
echo "Готово: $OUT"
