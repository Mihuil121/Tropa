// Поиск АЗС, точек питания и туалетов вдоль маршрута (Overpass API, без ключа).

import type { LatLon } from './core/geo';
import { dlog, dlogError } from './debugLog';
import { fetchJson, firstOk } from './net';

export type PoiCategory = 'fuel' | 'food' | 'toilet';

export type PoiItem = {
  id: string;
  name: string;
  category: PoiCategory;
  lat: number;
  lon: number;
  distM?: number; // расстояние от старта маршрута
};

const OVERPASS_URLS = [
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

function bboxOf(pts: LatLon[], marginKm = 1.0): [number, number, number, number] {
  let w = 180, s = 90, e = -180, n = -90;
  for (const p of pts) {
    w = Math.min(w, p.lon);
    e = Math.max(e, p.lon);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  const dLat = marginKm / 111.32;
  const dLon = marginKm / (111.32 * Math.cos((s * Math.PI) / 180));
  return [s - dLat, w - dLon, n + dLat, e + dLon];
}

export async function fetchRoutePois(pts: LatLon[], signal?: AbortSignal): Promise<PoiItem[]> {
  if (!pts || pts.length < 2) return [];
  const [s, w, n, e] = bboxOf(pts, 0.8);
  const q = `[out:json][timeout:15];
(
  node["amenity"="fuel"](${s.toFixed(3)},${w.toFixed(3)},${n.toFixed(3)},${e.toFixed(3)});
  node["amenity"~"restaurant|fast_food|cafe"](${s.toFixed(3)},${w.toFixed(3)},${n.toFixed(3)},${e.toFixed(3)});
  node["amenity"="toilets"](${s.toFixed(3)},${w.toFixed(3)},${n.toFixed(3)},${e.toFixed(3)});
);
out body 60;`;

  try {
    let json: any = null;
    try {
      json = await firstOk(OVERPASS_URLS.map((url) => ({
        label: 'overpass', host: url,
        run: (sig: AbortSignal) => fetchJson(url, {
          method: 'POST',
          body: `data=${encodeURIComponent(q)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: sig, timeoutMs: 20_000,
        }),
      })), { signal, staggerMs: 4000, budgetMs: 30_000 });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
    }
    if (!json) return [];
    const items: PoiItem[] = [];

    for (const el of json.elements ?? []) {
      if (el.type !== 'node' || !el.lat || !el.lon) continue;
      const amenity = el.tags?.amenity;
      let category: PoiCategory = 'fuel';
      if (amenity === 'toilets') category = 'toilet';
      else if (['restaurant', 'fast_food', 'cafe'].includes(amenity)) category = 'food';

      const name = el.tags?.name || el.tags?.brand || (category === 'fuel' ? 'АЗС' : category === 'food' ? 'Еда' : 'Туалет');
      items.push({
        id: `${el.id}`,
        name,
        category,
        lat: el.lat,
        lon: el.lon,
      });
    }

    dlog(`Overpass POI: найдено объектов ${items.length} вдоль маршрута`);
    return items;
  } catch (e: any) {
    if (e?.name === 'AbortError' || e?.message?.includes('cancel') || e?.message?.includes('Cancel')) return [];
    dlogError('Overpass POI', e);
    return [];
  }
}
