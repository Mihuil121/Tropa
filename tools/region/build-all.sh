#!/usr/bin/env bash
# Собирает все области из regions.txt и пишет manifest.json.
#   bash tools/region/build-all.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
grep -v '^\s*#' "$HERE/regions.txt" | grep -v '^\s*$' | while IFS='|' read -r id name bbox src; do
  id="$(echo "$id" | xargs)"; name="$(echo "$name" | xargs)"; bbox="$(echo "$bbox" | xargs)"; src="$(echo "$src" | xargs)"
  if [ -n "$src" ] && [ -z "${OSM_PBF:-}" ]; then
    OSM_URL="https://download.geofabrik.de/$src-latest.osm.pbf" bash "$HERE/build-region.sh" "$id" "$name" "$bbox" < /dev/null
  else
    bash "$HERE/build-region.sh" "$id" "$name" "$bbox" < /dev/null
  fi
done
node "$HERE/../build-manifest.ts" "$HERE/out"
