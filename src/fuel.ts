// АЗС вокруг вас: Overpass (без ключа) → список; кэш на диске; личные отметки «есть / нет бензина».
// О наличии топлива в OpenStreetMap данных нет: «есть/нет» ставит пользователь, и только на своём телефоне.

import { Directory, File, Paths } from 'expo-file-system';
import { dlog, dlogError } from './debugLog';
import { fetchJson, firstOk } from './net';

export type LatLonP = { lat: number; lon: number };
export type FuelKind = '92' | '95' | '98' | '100' | 'diesel' | 'lpg';
export type FuelStation = { id: string; name: string; brand?: string; lat: number; lon: number; distM: number; fuels: FuelKind[]; openingHours?: string };
export type FuelStatus = 'yes' | 'no' | 'unknown';
export type FuelReports = Record<string, { status: 'yes' | 'no'; t: number }>;
export type FuelResult = { stations: FuelStation[]; fromCache: boolean; cachedAt?: number; error?: string };

export const FUEL_LABEL: Record<FuelKind, string> = { '92': 'АИ-92', '95': 'АИ-95', '98': 'АИ-98', '100': 'АИ-100', diesel: 'ДТ', lpg: 'Газ' };
const TAG: Record<FuelKind, string> = { '92': 'fuel:octane_92', '95': 'fuel:octane_95', '98': 'fuel:octane_98', '100': 'fuel:octane_100', diesel: 'fuel:diesel', lpg: 'fuel:lpg' };
const REPORT_TTL_MS = 12 * 3600_000; // отметка «есть/нет» живёт 12 часов

const OVERPASS_URLS = [
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

const dir = new Directory(Paths.document, 'tropa');
const cacheFile = () => new File(dir, 'fuel-cache.json');
const reportsFile = () => new File(dir, 'fuel-reports.json');
function ensureDir() { if (!dir.exists) dir.create({ intermediates: true }); }

function distM(a: LatLonP, b: LatLonP): number {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function withDist(list: FuelStation[], c: LatLonP): FuelStation[] {
  return list.map((s) => ({ ...s, distM: Math.round(distM(c, s)) })).sort((a, b) => a.distM - b.distM);
}

/** Запрос к Overpass: node, way и relation (многие АЗС нарисованы контуром, поэтому nwr и center). Ошибки сети — выбрасываем. */
async function fetchAround(c: LatLonP, km: number, signal?: AbortSignal): Promise<FuelStation[]> {
  const q = `[out:json][timeout:20];nwr["amenity"="fuel"](around:${km * 1000},${c.lat.toFixed(5)},${c.lon.toFixed(5)});out center tags 100;`;
  const json: any = await firstOk(OVERPASS_URLS.map((url) => ({
    label: 'overpass', host: url,
    run: (sig: AbortSignal) => fetchJson(url, {
      method: 'POST',
      body: `data=${encodeURIComponent(q)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: sig, timeoutMs: 20_000,
    }),
  })), { signal, staggerMs: 4000, budgetMs: 30_000 });
  const out: FuelStation[] = [];
  for (const el of json?.elements ?? []) {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    const t = el.tags ?? {};
    const brand: string | undefined = t.brand || t.operator || undefined;
    const fuels = (Object.keys(TAG) as FuelKind[]).filter((k) => t[TAG[k]] === 'yes');
    out.push({ id: `${el.type}/${el.id}`, name: t.name || brand || 'АЗС', brand, lat, lon, distM: 0, fuels, openingHours: t.opening_hours });
  }
  return withDist(out, c).slice(0, 60);
}

async function saveCache(c: LatLonP, list: FuelStation[]) {
  try { ensureDir(); await cacheFile().write(JSON.stringify({ c, t: Date.now(), list })); } catch (e) { dlogError('fuel-cache: запись', e); }
}

async function loadCache(c: LatLonP): Promise<FuelResult | null> {
  try {
    const f = cacheFile();
    if (!f.exists) return null;
    const j = JSON.parse(await f.text());
    if (!j?.c || !Array.isArray(j.list) || distM(j.c, c) > 10_000) return null;
    return { stations: withDist(j.list, c), fromCache: true, cachedAt: j.t };
  } catch { return null; }
}

/** Заправки рядом: радиус 5 → 10 → 20 км, пока что-то не найдётся. Нет связи — берём кэш рядом с этим местом. */
export async function findFuel(c: LatLonP, signal?: AbortSignal): Promise<FuelResult> {
  try {
    for (const km of [5, 10, 20]) {
      const list = await fetchAround(c, km, signal);
      if (list.length) {
        void saveCache(c, list);
        dlog(`заправки: ${list.length} в радиусе ${km} км`);
        return { stations: list, fromCache: false };
      }
    }
    return { stations: [], fromCache: false };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    dlogError('заправки: Overpass', e);
    const cached = await loadCache(c);
    if (cached) return cached;
    return { stations: [], fromCache: false, error: 'Нет связи с картой заправок. Попробуйте позже или с VPN.' };
  }
}

// ---------- Личные отметки «есть / нет бензина» (только на этом телефоне) ----------

let reports: FuelReports | null = null;

export async function loadReports(): Promise<FuelReports> {
  if (reports) return reports;
  let r: FuelReports = {};
  try {
    ensureDir();
    const f = reportsFile();
    if (f.exists) { const j = JSON.parse(await f.text()); if (j && typeof j === 'object') r = j; }
  } catch (e) { dlogError('fuel-reports: чтение', e); }
  reports = r;
  return r;
}

export async function setReport(id: string, status: 'yes' | 'no'): Promise<FuelReports> {
  const cur = await loadReports();
  reports = { ...cur, [id]: { status, t: Date.now() } };
  try { ensureDir(); await reportsFile().write(JSON.stringify(reports)); } catch (e) { dlogError('fuel-reports: запись', e); }
  return reports;
}

export function statusOf(r: FuelReports, id: string): FuelStatus {
  const x = r[id];
  return x && Date.now() - x.t < REPORT_TTL_MS ? x.status : 'unknown';
}

/** Подходит ли заправка под выбранное топливо. Если у заправки топливо не указано — оставляем (не знаем). */
export function matchesFuel(s: FuelStation, kind: FuelKind | null): boolean {
  return !kind || s.fuels.length === 0 || s.fuels.includes(kind);
}
