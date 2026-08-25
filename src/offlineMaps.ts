// Скачивание онлайн-карты (OpenFreeMap) в телефон — чтобы она работала без интернета.
// Используем встроенный в MapLibre офлайн-менеджер: он сам скачивает плитки, шрифты и значки
// для прямоугольника и держит их в своей базе, а карта берёт их оттуда, когда сети нет.
//
//   Город     — квадрат ±R км вокруг центра, все масштабы до 14 (дальше карта «доувеличивает» сама).
//   Маршрут   — коридор ±1,5 км вдоль линии маршрута подробно + вся область маршрута обзорно.

import { OfflineManager, type OfflinePack } from '@maplibre/maplibre-react-native';
import type { LatLon } from './core/geo';
import { ONLINE_STYLE } from './mapStyle';
import { dlog, dlogError } from './debugLog';
import { routeBoxes } from './cellDownload';
import { probe } from './net';

type Bounds = [number, number, number, number]; // запад, юг, восток, север

const KB_PER_TILE = 35; // в среднем по векторным плиткам OpenFreeMap (город тяжелее, поля легче)

try { OfflineManager.setTileCountLimit(500_000); } catch {}
try { OfflineManager.setProgressEventThrottle(1000); } catch {}

export function boundsAround(p: LatLon, rKm: number): Bounds {
  const dLat = rKm / 111.32, dLon = rKm / (111.32 * Math.cos((p.lat * Math.PI) / 180));
  return [p.lon - dLon, p.lat - dLat, p.lon + dLon, p.lat + dLat];
}

/** Сколько плиток в прямоугольнике на масштабах minZ..maxZ. */
export function tileCount(b: Bounds, minZ: number, maxZ: number): number {
  const tx = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const ty = (lat: number, z: number) => {
    const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };
  let n = 0;
  for (let z = minZ; z <= maxZ; z++) n += (tx(b[2], z) - tx(b[0], z) + 1) * (ty(b[1], z) - ty(b[3], z) + 1);
  return n;
}

export type AreaPlan = { name: string; parts: { bounds: Bounds; minZ: number; maxZ: number }[]; tiles: number; mb: number;
  cellBoxes?: Bounds[];  // где заодно скачать вышки (см. cellDownload)
  cellsOnly?: boolean;   // карта уже есть — только вышки
};

export function planCity(name: string, center: LatLon, rKm = 12): AreaPlan {
  const parts = [{ bounds: boundsAround(center, rKm), minZ: 4, maxZ: 14 }];
  return { ...finish(name, parts), cellBoxes: [boundsAround(center, rKm)] };
}

/** Подготовка к поездке: за один вызов качаем карту маршрута и вышки этой области. */
export function packTrip(name: string, pts: LatLon[]): AreaPlan {
  const plan = planRoute(name, pts);
  enqueue(plan);
  dlog(`режим поездки: запущен скачивание всего для «${name}»`);
  return plan;
}
export function planRoute(name: string, pts: LatLon[]): AreaPlan {
  const parts: AreaPlan['parts'] = [];
  const margin = 1.5;
  let chunk: LatLon[] = [], acc = 0;
  const flush = () => {
    if (!chunk.length) return;
    let w = 180, s = 90, e = -180, n = -90;
    for (const p of chunk) { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
    const a = boundsAround({ lat: s, lon: w }, margin), b = boundsAround({ lat: n, lon: e }, margin);
    parts.push({ bounds: [a[0], a[1], b[2], b[3]], minZ: 11, maxZ: 14 });
  };
  for (let i = 0; i < pts.length; i++) {
    chunk.push(pts[i]);
    if (i > 0) acc += Math.hypot((pts[i].lat - pts[i - 1].lat) * 111.32, (pts[i].lon - pts[i - 1].lon) * 111.32 * Math.cos((pts[i].lat * Math.PI) / 180));
    if (acc >= 10) { flush(); chunk = [pts[i]]; acc = 0; }
  }
  flush();
  // Обзор всей дороги: мелкие масштабы
  let w = 180, s = 90, e = -180, n = -90;
  for (const p of pts) { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
  const a = boundsAround({ lat: s, lon: w }, 10), b = boundsAround({ lat: n, lon: e }, 10);
  parts.push({ bounds: [a[0], a[1], b[2], b[3]], minZ: 3, maxZ: 10 });
  return { ...finish(name, parts), cellBoxes: routeBoxes(pts, 4) };
}

/**
 * Полоса вдоль куска маршрута (подкачка «впереди» в пути): только подробные масштабы 11–14,
 * без обзорной карты всей дороги. withMap=false — только вышки.
 */
export function planCorridor(name: string, pts: LatLon[], withMap = true): AreaPlan {
  const full = planRoute(name, pts);
  const parts = withMap ? full.parts.filter((p) => p.minZ >= 11) : [];
  return { ...finish(name, parts), cellBoxes: full.cellBoxes, cellsOnly: !withMap };
}

function finish(name: string, parts: AreaPlan['parts']): AreaPlan {
  const tiles = parts.reduce((x, p) => x + tileCount(p.bounds, p.minZ, p.maxZ), 0);
  return { name, parts, tiles, mb: Math.round((tiles * KB_PER_TILE) / 1024) };
}

export type PackInfo = { id: string; name: string; group: string; percent: number; mb: number; state: string };

/** Начать скачивание. onProgress — общий процент по всем частям. */
export async function download(plan: AreaPlan, onProgress: (pct: number, done: boolean, err?: string) => void) {
  const group = `${plan.name}#${Date.now()}`;
  const pct = new Map<number, number>();
  const report = () => {
    const total = [...pct.values()].reduce((a, b) => a + b, 0) / plan.parts.length;
    onProgress(total, total >= 99.9);
  };
  dlog(`карты: качаю «${plan.name}», частей ${plan.parts.length}, ≈${plan.tiles} плиток ≈${plan.mb} МБ`);
  for (let i = 0; i < plan.parts.length; i++) {
    const part = plan.parts[i];
    pct.set(i, 0);
    try {
      await OfflineManager.createPack(
        { mapStyle: ONLINE_STYLE, bounds: part.bounds, minZoom: part.minZ, maxZoom: part.maxZ, metadata: { name: plan.name, group, part: i } },
        (_pack, st) => { pct.set(i, st.percentage); report(); },
        (_pack, err) => { dlog(`⚠ карты: часть ${i}: ${err.message}`); const total = [...pct.values()].reduce((a, b) => a + b, 0) / plan.parts.length; onProgress(total, false, err.message); },
      );
    } catch (e) {
      dlogError('карты: createPack', e);
      onProgress(0, false, String((e as Error)?.message ?? e));
      return;
    }
  }
}

/** Скачанные области (части одной области сгруппированы). */
export async function listAreas(): Promise<PackInfo[]> {
  let packs: OfflinePack[] = [];
  try { packs = await OfflineManager.getPacks(); } catch (e) { dlogError('карты: getPacks', e); return []; }
  const groups = new Map<string, { ids: string[]; name: string; pct: number[]; bytes: number; active: boolean }>();
  for (const p of packs) {
    const g = String(p.metadata?.group ?? p.id);
    let st;
    try { st = await p.status(); } catch { continue; }
    const cur = groups.get(g) ?? { ids: [], name: String(p.metadata?.name ?? 'Карта'), pct: [], bytes: 0, active: false };
    cur.ids.push(p.id); cur.pct.push(st.percentage); cur.bytes += st.completedResourceSize || st.completedTileSize || 0;
    cur.active ||= st.state === 'active';
    groups.set(g, cur);
  }
  return [...groups.entries()].map(([g, v]) => ({
    id: v.ids.join(','), group: g, name: v.name,
    percent: v.pct.reduce((a, b) => a + b, 0) / v.pct.length,
    mb: Math.round(v.bytes / 1e6), state: v.active ? 'качается' : 'готово',
  }));
}

export async function deleteArea(ids: string) {
  for (const id of ids.split(',')) {
    try { await OfflineManager.deletePack(id); } catch (e) { dlogError('карты: deletePack', e); }
  }
}

// ---------------- Очередь загрузок: города качаются по одному, даже если экран закрыт ----------------

export type QueueState = { current: { name: string; pct: number; err?: string; phase?: 'карта' | 'вышки' } | null; waiting: string[]; withCells: boolean };

/** Что делать после карты (App подключает сюда скачивание вышек). */
type AfterMap = (plan: AreaPlan, progress: (pct: number, note?: string) => void) => Promise<void>;
let afterMap: AfterMap | null = null;
let withCells = true;
export function setAfterMap(f: AfterMap) { afterMap = f; }
export function setWithCells(v: boolean) { withCells = v; notify(); }

const queue: AreaPlan[] = [];
let current: QueueState['current'] = null;
const qListeners = new Set<() => void>();
const notify = () => qListeners.forEach((l) => l());

export function queueState(): QueueState { return { current, waiting: queue.map((p) => p.name), withCells }; }
export function subscribeQueue(l: () => void) { qListeners.add(l); return () => { qListeners.delete(l); }; }

/** Поставить в очередь (повтор того же имени не добавляем). */
export function enqueue(plan: AreaPlan) {
  if (current?.name === plan.name || queue.some((p) => p.name === plan.name)) return;
  if (plan.cellsOnly) plan = { ...plan, parts: [] };
  queue.push(plan);
  notify();
  runNext();
}

export function cancelQueued(name: string) {
  const i = queue.findIndex((p) => p.name === name);
  if (i >= 0) { queue.splice(i, 1); notify(); }
}

async function runNext() {
  if (current || !queue.length) return;
  const plan = queue.shift()!;
  current = { name: plan.name, pct: 0, phase: 'карта' };
  notify();
  // Сначала за 4 секунды проверяем, отвечает ли сервер карт, — а не ждём минуты впустую.
  let mapReachable = true;
  if (!plan.cellsOnly && plan.parts.length) {
    mapReachable = await probe(ONLINE_STYLE, 4000);
    if (!mapReachable) {
      current = { name: plan.name, pct: 0, phase: 'карта', err: 'сервер карт не отвечает (часто так без VPN) — качаю только вышки' };
      notify();
    }
  }
  if (!plan.cellsOnly && plan.parts.length && mapReachable) await new Promise<void>((resolve) => {
    let finished = false, lastPct = 0, lastChange = Date.now();
    const finish = () => { if (!finished) { finished = true; clearInterval(watch); resolve(); } };
    // Если загрузка 90 секунд стоит на месте (сеть пропала / сервер замер) — идём дальше
    const watch = setInterval(() => { if (Date.now() - lastChange > 90_000) { current = { ...current!, err: 'загрузка остановилась — нет ответа от сервера карт' }; notify(); finish(); } }, 10_000);
    download(plan, (pct, done, err) => {
      if (pct !== lastPct) { lastPct = pct; lastChange = Date.now(); }
      current = { name: plan.name, pct: Math.max(pct, current?.pct ?? 0), err: err ?? current?.err, phase: 'карта' };
      notify();
      if (done) finish();
    }).catch(() => finish());
  });
  dlog(`карты: «${plan.name}» — ${current?.err ? 'остановлено: ' + current.err : 'готово'}`);
  // Потом — вышки этой же области (чтобы место находилось и без GPS)
  if ((withCells || plan.cellsOnly) && afterMap && plan.cellBoxes?.length) {
    current = { name: plan.name, pct: 0, phase: 'вышки' };
    notify();
    try {
      await afterMap(plan, (pct, note) => { current = { name: plan.name, pct, phase: 'вышки', err: note }; notify(); });
    } catch (e) {
      current = { name: plan.name, pct: current?.pct ?? 0, phase: 'вышки', err: `вышки: ${(e as Error)?.message ?? e}` };
      notify();
      dlogError('вышки', e);
    }
  }
  current = null;
  notify();
  runNext();
}
