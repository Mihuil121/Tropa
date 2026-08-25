// Объезды пробок по данным 2ГИС.
//
// Раз в 3 минуты спрашиваем у 2ГИС дорогу с учётом пробок от нас до точки ~45 км впереди
// по нашему маршруту — основной вариант и до двух других. Затем:
//   1) находим среди них «наш» (линия совпадает с нашей на ≥85 %) — это наше время с пробками;
//      если такого нет, спрашиваем ещё раз «через наши точки»;
//   2) предлагаем 1–2 других, если они быстрее хотя бы на 3 мин и 7 %;
//   3) если человек согласился — заменяем этот кусок маршрута, остальное оставляем.

import type { LatLon } from './core/geo.ts';
import type { GisRoute, Maneuver, PlannedRoute } from './online.ts';

const kx = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

export function cumDist(pts: LatLon[]): number[] {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot((pts[i].lat - pts[i - 1].lat) * 111320, (pts[i].lon - pts[i - 1].lon) * kx(pts[i].lat)));
  return c;
}

/** Ближайшая вершина ломаной к точке. */
export function nearestIdx(pts: LatLon[], p: LatLon, from = 0, to = pts.length): number {
  let best = from, bd = Infinity;
  const k = kx(p.lat);
  for (let i = from; i < to; i++) {
    const d = ((pts[i].lat - p.lat) * 111320) ** 2 + ((pts[i].lon - p.lon) * k) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Расстояние от точки до ломаной, м (с сеткой для скорости). */
function makeNear(line: LatLon[]) {
  const CELL = 0.002; // ~200 м
  const grid = new Map<string, number[]>();
  const key = (lat: number, lon: number) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(b.lat - a.lat), Math.abs(b.lon - a.lon)) / CELL));
    for (let t = 0; t <= n; t++) {
      const k = key(a.lat + ((b.lat - a.lat) * t) / n, a.lon + ((b.lon - a.lon) * t) / n);
      const arr = grid.get(k) ?? []; if (arr[arr.length - 1] !== i) arr.push(i); grid.set(k, arr);
    }
  }
  return (p: LatLon): number => {
    let best = Infinity;
    const cy = Math.floor(p.lat / CELL), cx = Math.floor(p.lon / CELL);
    const k = kx(p.lat);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const i of grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
        const a = line[i], b = line[i + 1];
        const ax = (a.lon - p.lon) * k, ay = (a.lat - p.lat) * 111320, bx = (b.lon - p.lon) * k, by = (b.lat - p.lat) * 111320;
        const vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L));
        best = Math.min(best, Math.hypot(ax + t * vx, ay + t * vy));
      }
    }
    return best;
  };
}

/** Какая доля линии `a` лежит вдоль линии `b` (точки через ~100 м, допуск 40 м). */
export function overlap(a: LatLon[], b: LatLon[], tol = 40): number {
  if (a.length < 2 || b.length < 2) return 0;
  const near = makeNear(b);
  const c = cumDist(a);
  let n = 0, hit = 0, next = 0;
  for (let i = 0; i < a.length; i++) {
    if (c[i] < next && i !== a.length - 1) continue;
    next = c[i] + 100; n++;
    if (near(a[i]) <= tol) hit++;
  }
  return n ? hit / n : 0;
}

export type DetourOffer = {
  route: GisRoute;
  savingS: number;        // насколько быстрее нашего
  extraM: number;         // насколько длиннее (может быть < 0)
  via: string;            // по каким улицам/дорогам (новые относительно нашего)
  divergeAt: LatLon;      // где сворачивать с нашего маршрута
};

/** Наш вариант среди ответов 2ГИС (или null) и выгодные объезды (0–2 шт.). */
export function pickDetours(ours: LatLon[], routes: GisRoute[], oursTimeS?: number): { mine: GisRoute | null; offers: DetourOffer[] } {
  let mine: GisRoute | null = null, bestOv = 0;
  for (const r of routes) {
    const ov = Math.min(overlap(ours, r.points), overlap(r.points, ours));
    if (ov > bestOv) { bestOv = ov; mine = r; }
  }
  if (bestOv < 0.85) mine = null;
  const base = mine?.timeS ?? oursTimeS;
  if (!base) return { mine, offers: [] };
  const baseLen = mine?.lengthM ?? cumDist(ours).at(-1)!;
  const nearOurs = makeNear(ours);
  const offers: DetourOffer[] = [];
  for (const r of routes) {
    if (r === mine) continue;
    const saving = base - r.timeS;
    if (saving < Math.max(180, 0.07 * base)) continue;
    if (Math.min(overlap(ours, r.points), overlap(r.points, ours)) > 0.9) continue; // по сути тот же путь
    const div = r.points.find((p) => nearOurs(p) > 60) ?? r.points[Math.floor(r.points.length / 2)];
    const ourNames = new Set(mine?.names ?? []);
    const via = r.names.filter((n) => !ourNames.has(n)).slice(0, 2).join(', ');
    offers.push({ route: r, savingS: saving, extraM: r.lengthM - baseLen, via, divergeAt: div });
  }
  offers.sort((a, b) => b.savingS - a.savingS);
  return { mine, offers: offers.slice(0, 2) };
}

/**
 * Новый маршрут: [объезд от нас до точки targetIdx] + [наш маршрут от targetIdx до конца].
 * Манёвры и время второй части сохраняются, у первой — из 2ГИС.
 */
export function spliceDetour(plan: PlannedRoute, targetIdx: number, alt: GisRoute): PlannedRoute {
  const rest = plan.points.slice(targetIdx);
  const points = [...alt.points, ...rest.slice(1)];
  const shift = alt.points.length - 1 - targetIdx;
  const restMans: Maneuver[] = plan.maneuvers.filter((m) => m.idx >= targetIdx).map((m) => ({ ...m, idx: m.idx + shift }));
  const altMans = alt.maneuvers.filter((m) => m.type !== 4); // «приехали» в середине маршрута не нужно
  const c = cumDist(plan.points);
  const total = c.at(-1) || 1;
  const restFrac = (total - c[targetIdx]) / total;
  return {
    ...plan,
    points,
    maneuvers: [...altMans, ...restMans],
    timeS: alt.timeS + plan.timeS * restFrac,
    lengthM: alt.lengthM + plan.lengthM * restFrac,
    limits: undefined, // знаки для нового куска загрузятся заново
    createdAt: Date.now(),
  };
}
