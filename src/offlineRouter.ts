// Офлайн-роутер: дороги и тропы из OpenStreetMap (Overpass) скачиваются полосой вдоль
// маршрута, пока есть интернет, и хранятся в телефоне компактно. Без сети путь ищется A*.
//
// Что сделано ради скорости на старых телефонах:
//   • граф — плоские массивы (CSR): координаты, смещения рёбер, цели, длины, флаги;
//     в памяти — типизированные массивы, без тысяч мелких объектов;
//   • ближайший узел — через сетку ~1 км, а не перебором всех узлов;
//   • A* — с двоичной кучей (раньше на каждом шаге искался минимум перебором — O(n²));
//   • скачивается не прямоугольник вокруг всей дороги (на дальней поездке это сотни МБ),
//     а коридор ±1,5 км вдоль линии, кусками.

import type { LatLon } from './core/geo.ts';
import type { TravelMode, PlannedRoute, Maneuver } from './online.ts';
import { fetchText, firstOk } from './net.ts';

export type Node = { lat: number; lon: number };

/** Граф в памяти. fl: бит 1 — можно на машине, бит 2 — пешком/самокатом. cls — множитель «стоимости» для машины ×10. */
export type Graph = {
  v: 2;
  n: number;
  lat: Float64Array; lon: Float64Array;
  off: Int32Array; to: Int32Array; w: Float32Array; fl: Uint8Array; cls: Uint8Array;
  grid: Map<number, number[]>;
};

/** Граф на диске (JSON). */
export type StoredGraph = { v: 2; lat: number[]; lon: number[]; off: number[]; to: number[]; w: number[]; fl: number[]; cls: number[] };

const CAR = 1, FOOT = 2;
const R = 6371000;
const toR = Math.PI / 180;

function distLL(aLat: number, aLon: number, bLat: number, bLon: number) {
  const dLat = (bLat - aLat) * toR, dLon = (bLon - aLon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------- Какие дороги кому ----------------

const CAR_FACTOR: Record<string, number> = {
  motorway: 6, motorway_link: 7, trunk: 7, trunk_link: 8, primary: 8, primary_link: 9,
  secondary: 9, secondary_link: 10, tertiary: 10, tertiary_link: 10, unclassified: 12, road: 12,
  residential: 12, living_street: 16, service: 16, track: 25,
};
const FOOT_NO = /^(motorway|motorway_link)$/;

function wayFlags(tags: Record<string, string> = {}) {
  const hw = tags.highway ?? '';
  const car = CAR_FACTOR[hw] != null && tags.motor_vehicle !== 'no' && tags.motorcar !== 'no';
  const foot = !FOOT_NO.test(hw) && tags.foot !== 'no';
  const ow = tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === 'true' || tags.junction === 'roundabout' || hw === 'motorway';
  const rev = tags.oneway === '-1';
  return { car, foot, cls: CAR_FACTOR[hw] ?? 12, ow, rev };
}

// ---------------- Сборка графа ----------------

/** Собирает граф из ответов Overpass (каждый: { elements: [...] }). */
export function buildGraph(responses: { elements?: any[] }[]): StoredGraph {
  const coord = new Map<number, [number, number]>();
  for (const resp of responses) for (const el of resp.elements ?? []) if (el.type === 'node') coord.set(el.id, [el.lat, el.lon]);

  const index = new Map<number, number>();
  const lat: number[] = [], lon: number[] = [];
  const idx = (id: number) => {
    let i = index.get(id);
    if (i === undefined) {
      const c = coord.get(id)!;
      i = lat.length; index.set(id, i);
      lat.push(+c[0].toFixed(6)); lon.push(+c[1].toFixed(6));
    }
    return i;
  };
  const edges: [number, number, number, number, number][] = []; // from, to, w, fl, cls
  const seenWay = new Set<number>();
  for (const resp of responses) {
    for (const el of resp.elements ?? []) {
      if (el.type !== 'way' || !el.nodes || seenWay.has(el.id)) continue;
      seenWay.add(el.id);
      const f = wayFlags(el.tags);
      if (!f.car && !f.foot) continue;
      for (let k = 0; k < el.nodes.length - 1; k++) {
        const ca = coord.get(el.nodes[k]), cb = coord.get(el.nodes[k + 1]);
        if (!ca || !cb) continue;
        const a = idx(el.nodes[k]), b = idx(el.nodes[k + 1]);
        const d = Math.round(distLL(ca[0], ca[1], cb[0], cb[1]) * 10) / 10;
        const fwdCar = f.car && !f.rev, backCar = f.car && (!f.ow || f.rev);
        const fwd = (fwdCar ? CAR : 0) | (f.foot ? FOOT : 0);
        const back = (backCar ? CAR : 0) | (f.foot ? FOOT : 0);
        if (fwd) edges.push([a, b, d, fwd, f.cls]);
        if (back) edges.push([b, a, d, back, f.cls]);
      }
    }
  }
  edges.sort((x, y) => x[0] - y[0]);
  const n = lat.length;
  const off = new Array<number>(n + 1).fill(0);
  for (const e of edges) off[e[0] + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  return {
    v: 2, lat, lon, off,
    to: edges.map((e) => e[1]), w: edges.map((e) => e[2]), fl: edges.map((e) => e[3]), cls: edges.map((e) => e[4]),
  };
}

const CELL = 0.01; // ~1 км
const cellKey = (lat: number, lon: number) => Math.floor(lat / CELL) * 100000 + Math.floor(lon / CELL);

/** Граф с диска → в память (типизированные массивы + сетка). Понимает и старый формат {nodes, adj}. */
export function loadGraph(raw: any): Graph | null {
  if (!raw) return null;
  const st: StoredGraph = raw.v === 2 ? raw : fromLegacy(raw);
  const n = st.lat.length;
  if (!n) return null;
  const g: Graph = {
    v: 2, n,
    lat: Float64Array.from(st.lat), lon: Float64Array.from(st.lon),
    off: Int32Array.from(st.off), to: Int32Array.from(st.to), w: Float32Array.from(st.w),
    fl: Uint8Array.from(st.fl), cls: Uint8Array.from(st.cls),
    grid: new Map(),
  };
  for (let i = 0; i < n; i++) {
    if (g.off[i + 1] === g.off[i]) continue; // узел без рёбер — не цель
    const k = cellKey(g.lat[i], g.lon[i]);
    let arr = g.grid.get(k);
    if (!arr) g.grid.set(k, (arr = []));
    arr.push(i);
  }
  return g;
}

/** Старый формат (объекты nodes/adj) → новый. Все рёбра считаем общими для всех. */
function fromLegacy(old: { nodes?: Record<string, Node>; adj?: Record<string, [string, number][]> }): StoredGraph {
  const ids = Object.keys(old.nodes ?? {});
  const index = new Map(ids.map((id, i) => [id, i]));
  const lat = ids.map((id) => old.nodes![id].lat), lon = ids.map((id) => old.nodes![id].lon);
  const off = [0], to: number[] = [], w: number[] = [], fl: number[] = [], cls: number[] = [];
  for (const id of ids) {
    for (const [nb, d] of old.adj?.[id] ?? []) {
      const j = index.get(String(nb));
      if (j === undefined) continue;
      to.push(j); w.push(d); fl.push(CAR | FOOT); cls.push(12);
    }
    off.push(to.length);
  }
  return { v: 2, lat, lon, off, to, w, fl, cls };
}

/** Ближайший узел, по которому можно ехать этим видом транспорта (в пределах ~maxM). */
function nearest(g: Graph, p: Node, need: number, maxM = 2500): number {
  const cy = Math.floor(p.lat / CELL), cx = Math.floor(p.lon / CELL);
  let best = -1, bd = Infinity;
  const rings = Math.ceil(maxM / 1000) + 1;
  for (let r = 0; r <= rings; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // только кольцо
        const arr = g.grid.get((cy + dy) * 100000 + (cx + dx));
        if (!arr) continue;
        for (const i of arr) {
          let ok = false;
          for (let e = g.off[i]; e < g.off[i + 1]; e++) if (g.fl[e] & need) { ok = true; break; }
          if (!ok) continue;
          const d = distLL(g.lat[i], g.lon[i], p.lat, p.lon);
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    // нашли в этом кольце — следующее кольцо дальше ~1 км, лучше уже не будет
    if (best >= 0 && bd < r * 1000) break;
  }
  return bd <= maxM ? best : -1;
}

/** Двоичная куча по приоритету (минимум сверху). */
class Heap {
  private k: number[] = []; private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/** A* без интернета. Для машины учитывает односторонние и класс дороги, пешком — все тропы. */
export function route(g: Graph, from: Node, to: Node, mode: TravelMode = 'car'): Node[] | null {
  const need = mode === 'car' ? CAR : FOOT;
  const start = nearest(g, from, need), goal = nearest(g, to, need);
  if (start < 0 || goal < 0) return null;
  if (start === goal) return [from, { lat: g.lat[goal], lon: g.lon[goal] }, to];
  const car = mode === 'car';
  const hk = car ? 0.6 : 1; // эвристика не должна переоценивать (минимальный множитель — 0.6)
  const gLat = g.lat[goal], gLon = g.lon[goal];
  const gs = new Float64Array(g.n).fill(Infinity);
  const prev = new Int32Array(g.n).fill(-1);
  const closed = new Uint8Array(g.n);
  const heap = new Heap();
  gs[start] = 0;
  heap.push(distLL(g.lat[start], g.lon[start], gLat, gLon) * hk, start);
  let iter = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    if (cur === goal) break;
    closed[cur] = 1;
    if (++iter > 2_000_000) return null; // предохранитель
    for (let e = g.off[cur]; e < g.off[cur + 1]; e++) {
      if (!(g.fl[e] & need)) continue;
      const nb = g.to[e];
      if (closed[nb]) continue;
      const t = gs[cur] + (car ? g.w[e] * g.cls[e] / 10 : g.w[e]);
      if (t < gs[nb]) {
        gs[nb] = t; prev[nb] = cur;
        heap.push(t + distLL(g.lat[nb], g.lon[nb], gLat, gLon) * hk, nb);
      }
    }
  }
  if (prev[goal] < 0) return null;
  const path: Node[] = [];
  for (let i = goal; i >= 0; i = prev[i]) path.push({ lat: g.lat[i], lon: g.lon[i] });
  path.reverse();
  return path;
}

// ---------------- Скачивание коридора ----------------

const OVERPASS = [
  'https://overpass.openstreetmap.ru/api/interpreter', // в России — обычно доступен без VPN
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

type BBox = [number, number, number, number]; // юг, запад, север, восток

/** Прямоугольники ±marginKm вокруг кусков маршрута по ~stepKm. */
export function corridorBoxes(pts: LatLon[], marginKm = 1.5, stepKm = 8): BBox[] {
  const out: BBox[] = [];
  let chunk: LatLon[] = [], acc = 0;
  const flush = () => {
    if (!chunk.length) return;
    let s = 90, w = 180, n = -90, e = -180;
    for (const p of chunk) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
    const dLat = marginKm / 111.32, dLon = marginKm / (111.32 * Math.cos(((s + n) / 2) * toR));
    out.push([s - dLat, w - dLon, n + dLat, e + dLon]);
  };
  for (let i = 0; i < pts.length; i++) {
    chunk.push(pts[i]);
    if (i > 0) acc += distLL(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon) / 1000;
    if (acc >= stepKm) { flush(); chunk = [pts[i]]; acc = 0; }
  }
  flush();
  return out;
}

/**
 * Пока есть интернет: скачать дороги и тропы полосой вдоль маршрута.
 * Куски по 12 прямоугольников за запрос — чтобы ответ не был огромным для слабого телефона.
 */
export async function downloadCorridor(pts: LatLon[], opts: { signal?: AbortSignal; onProgress?: (pct: number) => void } = {}): Promise<StoredGraph> {
  const boxes = corridorBoxes(pts);
  const batches: BBox[][] = [];
  for (let i = 0; i < boxes.length; i += 12) batches.push(boxes.slice(i, i + 12));
  const responses: { elements?: any[] }[] = [];
  for (let b = 0; b < batches.length; b++) {
    const parts = batches[b].map(([s, w, n, e]) => `way["highway"]["access"!~"^(private|no)$"](${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)});`).join('');
    const q = `[out:json][timeout:90];(${parts});out body;>;out skel qt;`;
    const j = await firstOk(OVERPASS.map((url) => ({
      label: 'overpass', host: url,
      run: async (sig: AbortSignal) => {
        const r = await fetchText(url, {
          method: 'POST', body: `data=${encodeURIComponent(q)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: sig, timeoutMs: 100_000,
        });
        if (!r.ok) throw new Error(`overpass ${r.status}`);
        return JSON.parse(r.text);
      },
    })), { signal: opts.signal, staggerMs: 15_000, budgetMs: 150_000 });
    responses.push(j);
    opts.onProgress?.(((b + 1) / batches.length) * 100);
  }
  return buildGraph(responses);
}

/** Совместимость: прямоугольник (юг, запад, север, восток). */
export async function downloadArea(s: number, w: number, n: number, e: number): Promise<StoredGraph> {
  return downloadCorridor([{ lat: s, lon: w }, { lat: n, lon: e }]);
}

// ---------------- Путь → маршрут с подсказками ----------------

function bearing(a: Node, b: Node) {
  const y = Math.sin((b.lon - a.lon) * toR) * Math.cos(b.lat * toR);
  const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lon - a.lon) * toR);
  return (Math.atan2(y, x) / toR + 360) % 360;
}

/** Повороты по изгибам пути: направо/налево/правее/левее/разворот (типы как у Valhalla). */
export function turnsAlong(path: Node[]): { idx: number; type: number; text: string }[] {
  const out: { idx: number; type: number; text: string }[] = [];
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + distLL(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon));
  let lastIdx = -1;
  for (let i = 1; i < path.length - 1; i++) {
    // направление «до» и «после» по отрезкам не короче ~15 м
    let a = i - 1; while (a > 0 && cum[i] - cum[a] < 15) a--;
    let b = i + 1; while (b < path.length - 1 && cum[b] - cum[i] < 15) b++;
    const d = ((bearing(path[i], path[b]) - bearing(path[a], path[i]) + 540) % 360) - 180;
    const ad = Math.abs(d);
    if (ad < 30) continue;
    if (lastIdx >= 0 && cum[i] - cum[lastIdx] < 25) continue; // один поворот — одна подсказка
    const right = d > 0;
    let type: number, text: string;
    if (ad > 150) { type = 12; text = 'Разворот'; }
    else if (ad > 60) { type = right ? 10 : 15; text = right ? 'Направо' : 'Налево'; }
    else { type = right ? 9 : 16; text = right ? 'Правее' : 'Левее'; }
    out.push({ idx: i, type, text });
    lastIdx = i;
  }
  return out;
}

export function graphPathToPlannedRoute(path: Node[], mode: TravelMode): PlannedRoute {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + distLL(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon));
  const lengthM = cum[cum.length - 1];
  const speedMps = mode === 'walk' ? 1.4 : mode === 'scooter' ? 4.0 : 11.1;
  const timeS = Math.round(lengthM / speedMps);
  const marks = [{ idx: 0, type: 1, text: 'Начало маршрута' }, ...turnsAlong(path), { idx: path.length - 1, type: 4, text: 'Пункт назначения' }];
  const maneuvers: Maneuver[] = marks.map((m, k) => {
    const next = marks[k + 1];
    const len = next ? cum[next.idx] - cum[m.idx] : 0;
    return { idx: m.idx, type: m.type, text: m.text, lengthM: len, timeS: Math.round(len / speedMps) };
  });
  return {
    mode, points: path, maneuvers, timeS, lengthM, createdAt: Date.now(),
    offline: true, offlineGraph: true,
  };
}
