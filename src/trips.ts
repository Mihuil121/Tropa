// Множественные поездки (скачанные офлайн-маршруты и их графы/карты)

import { Directory, File, Paths } from 'expo-file-system';
import type { Place, PlannedRoute, TravelMode } from './online';
import { loadGraph, type Graph, type StoredGraph } from './offlineRouter';
import { dlog, dlogError } from './debugLog';

export type TripStatus = 'queued' | 'downloading' | 'ready' | 'error';

export type TripProgress = {
  map: number;     // 0..100
  cells: number;   // 0..100
  graph: number;   // 0..100
};

export type BBox = [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]

export type Trip = {
  id: string;
  name: string;
  dest: Place;
  mode: TravelMode;
  createdAt: number;
  status: TripStatus;
  progress: TripProgress;
  totalPct: number;    // map 60%, cells 15%, graph 25%
  mb: number;
  cellsCount: number;
  bbox?: BBox;
  hasGraph?: boolean;
  queueDone?: boolean;
  graphDone?: boolean;
  error?: string;
};

const tropaDir = new Directory(Paths.document, 'tropa');
const tripsDir = new Directory(tropaDir, 'trips');
const indexFile = () => new File(tripsDir, 'index.json');

const legacyGraphFile = () => new File(tropaDir, 'offline-graph.json');

function ensureDirs() {
  if (!tropaDir.exists) tropaDir.create({ intermediates: true });
  if (!tripsDir.exists) tripsDir.create({ intermediates: true });
}

let tripsCache: Trip[] | null = null;
const tripListeners = new Set<() => void>();
const notifyTrips = () => tripListeners.forEach((l) => l());

export function subscribeTrips(listener: () => void): () => void {
  tripListeners.add(listener);
  return () => { tripListeners.delete(listener); };
}

let loadingList: Promise<Trip[]> | null = null;
/** Список поездок. Параллельные вызовы при старте ждут одну и ту же загрузку (иначе получатся две разные копии массива). */
export function listTrips(): Promise<Trip[]> {
  if (tripsCache) return Promise.resolve(tripsCache);
  return (loadingList ??= loadTripsFromDisk().finally(() => { loadingList = null; }));
}

async function loadTripsFromDisk(): Promise<Trip[]> {
  ensureDirs();
  if (tripsCache) return tripsCache;
  const f = indexFile();
  if (!f.exists) {
    await migrateLegacyIfNeeded();
    return tripsCache ?? [];
  }
  try {
    const list = JSON.parse(await f.text()) as Trip[];
    let changed = false;
    // Очистка прерванных загрузок при старте приложения
    for (const t of list) {
      if (t.status === 'queued' || t.status === 'downloading') {
        t.status = 'error';
        t.error = 'Загрузка прервана, нажмите «Скачать» снова';
        changed = true;
      }
    }
    tripsCache = list;
    if (changed) scheduleFlush();
  } catch (e) {
    dlogError('ошибка чтения trips/index.json', e);
    tripsCache = [];
  }
  return tripsCache ?? [];
}

/** Однократная миграция устаревших файлов при первом запуске (если index.json ещё нет) */
async function migrateLegacyIfNeeded() {
  ensureDirs();
  tripsCache = [];
  const lg = legacyGraphFile();
  if (lg.exists) {
    try {
      dlog('миграция устаревшего offline-graph.json…');
      const graphText = await lg.text();
      const rawGraph = JSON.parse(graphText);
      const graph = loadGraph(rawGraph);
      if (graph && graph.n > 0) {
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        for (let i = 0; i < graph.n; i++) {
          minLat = Math.min(minLat, graph.lat[i]); maxLat = Math.max(maxLat, graph.lat[i]);
          minLon = Math.min(minLon, graph.lon[i]); maxLon = Math.max(maxLon, graph.lon[i]);
        }
        const id = `trip_${Date.now()}`;
        const name = 'Сохранённый регион';
        const trip: Trip = {
          id,
          name,
          dest: { name, detail: '', lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 },
          mode: 'car',
          createdAt: Date.now(),
          status: 'ready',
          progress: { map: 100, cells: 100, graph: 100 },
          totalPct: 100,
          mb: 0,
          cellsCount: 0,
          bbox: [minLon - 0.05, minLat - 0.05, maxLon + 0.05, maxLat + 0.05],
          hasGraph: true,
          queueDone: true,
          graphDone: true,
        };
        const td = new Directory(tripsDir, id);
        if (!td.exists) td.create({ intermediates: true });
        await new File(td, 'graph.json').write(graphText);
        lg.delete();
        tripsCache.push(trip);
      }
    } catch (e) {
      dlogError('миграция offline-graph.json', e);
    }
  }
  await flushIndex();
  notifyTrips();
}

// Троттлинг записи индекса (не чаще 1 раза в секунду)
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSaveTime = 0;

async function flushIndex() {
  if (!tripsCache) return;
  ensureDirs();
  try {
    await indexFile().write(JSON.stringify(tripsCache));
    lastSaveTime = Date.now();
  } catch (e) {
    dlogError('ошибка записи trips/index.json', e);
  }
}

function scheduleFlush() {
  const now = Date.now();
  if (now - lastSaveTime >= 1000) {
    if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
    flushIndex();
  } else if (!saveTimeout) {
    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      flushIndex();
    }, 1000 - (now - lastSaveTime));
  }
}

export async function getTrip(id: string): Promise<Trip | null> {
  const list = await listTrips();
  return list.find((t) => t.id === id) ?? null;
}

export async function saveTrip(trip: Trip): Promise<void> {
  const list = await listTrips();
  const idx = list.findIndex((t) => t.id === trip.id);
  if (idx >= 0) list[idx] = trip;
  else list.unshift(trip);
  notifyTrips();
  scheduleFlush();
}

export async function updateTrip(id: string, update: Omit<Partial<Trip>, 'progress'> & { progress?: Partial<TripProgress> }): Promise<void> {
  const list = await listTrips();
  const idx = list.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const cur = list[idx];
  const { progress, ...rest } = update;
  const next: Trip = { ...cur, ...rest };

  if (progress) {
    const curP = cur.progress ?? { map: 0, cells: 0, graph: 0 };
    const p: TripProgress = { ...curP, ...progress };
    next.progress = p;
    next.totalPct = Math.round(p.map * 0.6 + p.cells * 0.15 + p.graph * 0.25);
  }
  list[idx] = next;
  notifyTrips();
  scheduleFlush();
}

/** Завершение частей скачивания (очередь/граф). Ставит ready только при завершении обеих частей. */
export async function finalizeTripPart(id: string, part: 'queue' | 'graph', err?: string, mb?: number): Promise<void> {
  const list = await listTrips();
  const idx = list.findIndex((t) => t.id === id);
  if (idx < 0) return;
  // Всё ниже синхронно, без await: два завершения подряд не затрут друг друга.
  const next: Trip = { ...list[idx] };
  if (mb != null && mb > 0) next.mb = mb;
  if (err) {
    next.status = 'error';
    next.error = err;
  } else {
    if (part === 'queue') next.queueDone = true; else next.graphDone = true;
    if (next.queueDone && next.graphDone && next.status !== 'error') {
      next.status = 'ready';
      next.error = undefined;
      next.totalPct = 100;
      next.progress = { map: 100, cells: 100, graph: 100 };
    }
  }
  list[idx] = next;
  notifyTrips();
  scheduleFlush();
}

export async function getTripRoute(id: string): Promise<PlannedRoute | null> {
  ensureDirs();
  const td = new Directory(tripsDir, id);
  const rf = new File(td, 'route.json');
  if (!rf.exists) return null;
  try {
    return JSON.parse(await rf.text());
  } catch {
    return null;
  }
}

export async function saveTripRoute(id: string, route: PlannedRoute): Promise<void> {
  ensureDirs();
  const td = new Directory(tripsDir, id);
  if (!td.exists) td.create({ intermediates: true });
  await new File(td, 'route.json').write(JSON.stringify(route));
}

export async function getTripGraph(id: string): Promise<Graph | null> {
  ensureDirs();
  const td = new Directory(tripsDir, id);
  const gf = new File(td, 'graph.json');
  if (!gf.exists) return null;
  try {
    const raw = JSON.parse(await gf.text());
    return loadGraph(raw);
  } catch {
    return null;
  }
}

export async function saveTripGraph(id: string, graph: StoredGraph): Promise<void> {
  ensureDirs();
  const td = new Directory(tripsDir, id);
  if (!td.exists) td.create({ intermediates: true });
  await new File(td, 'graph.json').write(JSON.stringify(graph));
  await updateTrip(id, { hasGraph: true });
}

// Кэш графа в памяти (один граф за раз)
let cachedTripId: string | null = null;
let cachedGraph: Graph | null = null;

export function resetGraphCache() {
  cachedTripId = null;
  cachedGraph = null;
}

/** Выбрать граф поездки, чей bbox включает координаты from (и to, если задана). В противном случае вернет null */
export async function getOfflineGraphForCoords(from?: { lat: number; lon: number }, to?: { lat: number; lon: number }): Promise<Graph | null> {
  const trips = await listTrips();
  const readyTrips = trips.filter((t) => t.status === 'ready' && t.hasGraph && t.bbox);
  if (!readyTrips.length) return null;

  let targetTrip: Trip | undefined;
  if (from) {
    if (to) {
      targetTrip = readyTrips.find((t) => {
        const [w, s, e, n] = t.bbox!;
        return from.lon >= w && from.lon <= e && from.lat >= s && from.lat <= n &&
               to.lon >= w && to.lon <= e && to.lat >= s && to.lat <= n;
      });
    }
    if (!targetTrip) {
      targetTrip = readyTrips.find((t) => {
        const [w, s, e, n] = t.bbox!;
        return from.lon >= w && from.lon <= e && from.lat >= s && from.lat <= n;
      });
    }
  }

  if (!targetTrip) return null;

  if (cachedTripId === targetTrip.id && cachedGraph) {
    return cachedGraph;
  }

  const g = await getTripGraph(targetTrip.id);
  if (g) {
    cachedTripId = targetTrip.id;
    cachedGraph = g;
  }
  return g;
}

/** Удаление папки поездки и записи из индекса. Принимает опциональный колбэк для удаления карт MapLibre. */
export async function deleteTrip(id: string, deleteMapsCb?: (id: string) => Promise<void>): Promise<void> {
  ensureDirs();
  if (deleteMapsCb) {
    try { await deleteMapsCb(id); } catch (e) { dlogError('deleteMapsCb', e); }
  }

  const td = new Directory(tripsDir, id);
  if (td.exists) td.delete();

  if (cachedTripId === id) resetGraphCache();

  const list = await listTrips();
  tripsCache = list.filter((t) => t.id !== id);
  notifyTrips();
  await flushIndex();
  dlog(`поездка ${id} удалена`);
}
