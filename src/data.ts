// Офлайн-данные навигатора. Готовятся дома (с интернетом) и копируются в телефон:
//   map.pmtiles  — векторная карта региона/коридора маршрута (Protomaps)
//   route        — маршрут .gpx или .geojson (проложить можно в любом онлайн-роутере)
//   cells.json   — вышки вдоль маршрута (делает tools/build-cells.mjs из базы OpenCelliD)
// Внутри приложения всё лежит в его личной папке и работает без сети.

import { Directory, File, Paths } from 'expo-file-system';
import type { LatLon } from './core/geo';
import { parseGeoJson, parseGpx } from './core/route';
import { CellDb } from './core/cells';
import type { PlannedRoute } from './online';
import type { Graph } from './offlineRouter';
import { getOfflineGraphForCoords } from './trips';

const dir = new Directory(Paths.document, 'tropa');
const mapFile = () => new File(dir, 'map.pmtiles');
const routeFile = () => new File(dir, 'route.json');
const cellsFile = () => new File(dir, 'cells.json');
const settingsFile = () => new File(dir, 'settings.json');
const learnedFile = () => new File(dir, 'learned-cells.json');

export function getOfflineGraph(from?: LatLon, to?: LatLon): Promise<Graph | null> {
  return getOfflineGraphForCoords(from, to);
}

export type Kind = 'map' | 'route' | 'cells';

export type Settings = {
  tomtomKey?: string;  // устарело: TomTom не покрывает Россию
  gisKey?: string;     // ключ 2ГИС — пробки на маршруте
  traffic?: boolean;   // показывать пробки
  view3d?: boolean;    // 3D-вид при ведении (по умолчанию да; в лёгком режиме — нет)
  lite?: 'auto' | 'on' | 'off'; // лёгкий режим для слабых телефонов (auto — по версии Android)
  dataUrl?: string;    // сервер данных с областями (карта, дороги, поиск) — в России, без VPN
  theme?: 'auto' | 'light' | 'dark'; // тема: как в системе / светлая / тёмная
  voice?: boolean;     // голосовые подсказки на русском
  prefetch?: 'all' | 'cells' | 'off';
  // Неофициальные источники (для себя): Waze — пробки и ДТП, Google — слой пробок картинками
  waze?: boolean;
  gTraffic?: boolean;
  gTrafficUrl?: string;
  yandex?: boolean;       // пробки Яндекса: читаем цвет плиток под маршрутом, рисуем сами
  yandexUrl?: string;     // свой адрес плиток (если старый перестанет работать) // в пути при интернете подкачивать впереди: карту+вышки / только вышки / ничего
};

export type Loaded = {
  mapUri: string | null;
  route: LatLon[] | null;
  plan: PlannedRoute | null;   // маршрут с подсказками и временем (если прокладывали в приложении)
  cells: CellDb | null;
  info: { map: string; route: string; cells: string };
};

function ensureDir() { if (!dir.exists) dir.create({ intermediates: true }); }

/** Открывает системный выбор файла и копирует его в приложение. Возвращает текст ошибки или ''. */
export async function importFile(kind: Kind): Promise<string> {
  ensureDir();
  const res = await File.pickFileAsync({ mimeTypes: '*/*' });
  if (res.canceled) return '';
  const picked = res.result;
  try {
    if (kind === 'map') {
      const dst = mapFile();
      if (dst.exists) dst.delete();
      await picked.copy(dst);
      return '';
    }
    const text = await picked.text();
    if (kind === 'route') {
      const pts = /<gpx|<trkpt|<rtept/i.test(text) ? parseGpx(text) : parseGeoJson(text);
      if (pts.length < 2) return 'В файле не нашлось линии маршрута (нужен GPX или GeoJSON LineString).';
      await routeFile().write(JSON.stringify({ mode: 'car', points: pts, maneuvers: [], timeS: 0, lengthM: 0, createdAt: Date.now() }));
      return '';
    }
    const db = CellDb.fromJson(text);
    if (db.size === 0) return 'В файле нет вышек.';
    await cellsFile().write(text);
    return '';
  } catch (e: any) {
    return `Не удалось прочитать файл: ${e?.message ?? e}`;
  }
}

export async function loadAll(): Promise<Loaded> {
  ensureDir();
  const out: Loaded = { mapUri: null, route: null, plan: null, cells: null, info: { map: 'нет', route: 'нет', cells: 'нет' } };
  const m = mapFile();
  if (m.exists) { out.mapUri = m.uri; out.info.map = `${(m.size / 1e6).toFixed(0)} МБ`; }
  const r = routeFile();
  if (r.exists) {
    try {
      const j = JSON.parse(await r.text());
      // Старый формат — просто массив точек
      out.plan = Array.isArray(j) ? { mode: 'car', points: j, maneuvers: [], timeS: 0, lengthM: 0, createdAt: 0 } : j;
      out.route = out.plan!.points;
      out.info.route = out.plan!.dest?.name ?? `${out.route.length} точек`;
    } catch {}
  }
  const c = cellsFile();
  if (c.exists) {
    try { out.cells = CellDb.fromJson(await c.text()); out.info.cells = `${out.cells.size} вышек`; } catch {}
  }
  return out;
}

/** Сохранить проложенный маршрут — он понадобится, когда пропадёт интернет. */
export async function savePlan(plan: PlannedRoute) {
  ensureDir();
  await routeFile().write(JSON.stringify(plan));
}

export function clearPlan() {
  const f = routeFile();
  if (f.exists) f.delete();
}

export async function loadSettings(): Promise<Settings> {
  ensureDir();
  const f = settingsFile();
  if (!f.exists) return {};
  try { return JSON.parse(await f.text()); } catch { return {}; }
}

export async function saveSettings(st: Settings) {
  ensureDir();
  await settingsFile().write(JSON.stringify(st));
}

const areaCellsFile = () => new File(dir, 'area-cells.json');

/** Сколько вышек скачано для каждой области карты (чтобы показать в списке). */
export async function loadAreaCells(): Promise<Record<string, number>> {
  ensureDir();
  const f = areaCellsFile();
  if (!f.exists) return {};
  try { return JSON.parse(await f.text()); } catch { return {}; }
}

export async function saveAreaCells(name: string, count: number) {
  const all = await loadAreaCells();
  all[name] = count;
  await areaCellsFile().write(JSON.stringify(all));
}

/** Добавить вышки (скачанные заранее) к файлу вышек. Возвращает, сколько всего стало. */
export async function mergeCells(records: Record<string, [number, number, number]>): Promise<number> {
  ensureDir();
  const f = cellsFile();
  let all: Record<string, [number, number, number]> = {};
  if (f.exists) { try { all = JSON.parse(await f.text()); } catch {} }
  Object.assign(all, records);
  await f.write(JSON.stringify(all));
  return Object.keys(all).length;
}

// ---------- Своя база вышек и Wi‑Fi (учится, пока GPS честный) ----------

export async function loadLearned(): Promise<string | null> {
  ensureDir();
  const f = learnedFile();
  if (!f.exists) return null;
  try { return await f.text(); } catch { return null; }
}

export async function saveLearned(json: string) {
  ensureDir();
  await learnedFile().write(json);
}

export function clearLearned() {
  const f = learnedFile();
  if (f.exists) f.delete();
}

// ---------- Журнал поездки (для разбора и прогона в симуляторе) ----------

export class TripLog {
  private buf: string[] = [];
  private file: File | null = null;
  enabled = true;

  start() {
    ensureDir();
    const logs = new Directory(dir, 'logs');
    if (!logs.exists) logs.create();
    const name = new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl';
    this.file = new File(logs, name);
    this.file.create();
  }

  add(ev: Record<string, unknown>) { if (this.enabled) this.buf.push(JSON.stringify(ev)); }

  async flush() {
    if (!this.file || !this.buf.length) return;
    const chunk = this.buf.join('\n') + '\n';
    this.buf = [];
    try { await this.file.write(chunk, { append: true }); } catch {}
  }
}
