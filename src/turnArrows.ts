// Стрелки поворотов на самой дороге — как в Яндекс Навигаторе: «хвост» за ~30 м до поворота,
// изгиб по линии маршрута и наконечник через ~25 м после. Размер в метрах — стрелка лежит на дороге
// и масштабируется вместе с картой (видна с масштаба 14).

import type { LatLon } from './core/geo.ts';

export type ArrowManeuver = { idx: number; type: number };

const R = 6371000;
const mx = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

/** Путь по ломаной от точки idx на `back` м назад и `fwd` м вперёд. */
function slice(pts: LatLon[], idx: number, back: number, fwd: number): LatLon[] {
  const out: LatLon[] = [];
  // назад
  let left = back, i = idx;
  const backPts: LatLon[] = [pts[idx]];
  while (i > 0 && left > 0) {
    const a = pts[i], b = pts[i - 1];
    const d = Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * mx(a.lat));
    if (d >= left) { const k = left / d; backPts.push({ lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k }); left = 0; break; }
    backPts.push(b); left -= d; i--;
  }
  out.push(...backPts.reverse());
  // вперёд
  left = fwd; i = idx;
  while (i < pts.length - 1 && left > 0) {
    const a = pts[i], b = pts[i + 1];
    const d = Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * mx(a.lat));
    if (d >= left) { const k = left / d; out.push({ lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k }); left = 0; break; }
    out.push(b); left -= d; i++;
  }
  return out;
}

/** Нужна ли стрелка: повороты, развороты, съезды, кольца (не «прямо», не старт/финиш). */
export function isTurn(type: number): boolean {
  return (type >= 9 && type <= 16) || (type >= 18 && type <= 21) || type === 23 || type === 24 || type === 26 || type === 27;
}

/** GeoJSON: древко (LineString) и наконечник (Polygon) для каждого манёвра. */
export function turnArrows(pts: LatLon[], mans: ArrowManeuver[], opts: { back?: number; fwd?: number; head?: number } = {}): GeoJSON.Feature[] {
  const back = opts.back ?? 30, fwd = opts.fwd ?? 25, head = opts.head ?? 11;
  const out: GeoJSON.Feature[] = [];

  // Фильтруем слишком частые близкие повороты (< 40 м), чтобы стрелки не накладывались
  const filteredMans: ArrowManeuver[] = [];
  let lastIdx = -Infinity;
  for (const m of mans) {
    if (!isTurn(m.type) || m.idx <= 0 || m.idx >= pts.length - 1) continue;
    let distM = 0;
    if (lastIdx > 0) {
      for (let i = lastIdx; i < m.idx && i < pts.length - 1; i++) {
        distM += Math.hypot((pts[i + 1].lat - pts[i].lat) * 111320, (pts[i + 1].lon - pts[i].lon) * mx(pts[i].lat));
      }
    }
    if (lastIdx < 0 || distM >= 40) {
      filteredMans.push(m);
      lastIdx = m.idx;
    }
  }

  for (const m of filteredMans) {
    const path = slice(pts, m.idx, back, fwd);
    if (path.length < 2) continue;
    // Наконечник: треугольник по направлению последнего отрезка; древко обрезаем под него
    const a = path[path.length - 2], b = path[path.length - 1];
    const dx = (b.lon - a.lon) * mx(b.lat), dy = (b.lat - a.lat) * 111320;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;               // вперёд
    const px = -uy, py = ux;                       // вбок
    const toLL = (x: number, y: number): [number, number] => [b.lon + x / mx(b.lat), b.lat + y / 111320];
    const baseX = -ux * head, baseY = -uy * head;
    const tri = [toLL(0, 0), toLL(baseX + px * head * 0.75, baseY + py * head * 0.75), toLL(baseX - px * head * 0.75, baseY - py * head * 0.75), toLL(0, 0)];
    const shaft = [...path.slice(0, -1).map((p) => [p.lon, p.lat] as [number, number]), toLL(baseX * 0.6, baseY * 0.6)];
    out.push({ type: 'Feature', properties: { part: 'shaft' }, geometry: { type: 'LineString', coordinates: shaft } });
    out.push({ type: 'Feature', properties: { part: 'head' }, geometry: { type: 'Polygon', coordinates: [tri] } });
  }
  return out;
}

export const _test = { slice, R };
